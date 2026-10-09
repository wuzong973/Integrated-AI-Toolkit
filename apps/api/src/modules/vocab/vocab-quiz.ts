import { Injectable } from '@nestjs/common';
import { bizDayDate } from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';

import type { VocabCard, VocabQuestionType } from './dto/vocab.dto';
import type { OptionSource } from './vocab-options';
import {
  MIN_OPTIONS,
  buildQuestion,
  canBuild,
  isQuestionType,
  pickType,
  type Question,
  type QuestionSource,
} from './vocab-question';
import {
  WORD_SELECT,
  toExamples,
  toOptionSource,
  toPhrases,
  toSenses,
  type WordRow,
} from './vocab-word';

/**
 * 出题：把词条行变成题卡（今日队列与判卷**共用**）
 *
 * 判卷（`POST /vocab/answer`）必须算出与出题时**一模一样**的题与答案，
 * 才能知道用户提交的是不是对的。所以逻辑只有这一份，且全程确定性
 * （题型由词 id 决定、选项由词 id 洗牌，见 `vocab-question.ts` 文件头）。
 *
 * ## 两个池子，两种用途 —— 别混用
 *
 * 四种题型里有两种"选项是词形"（听音辨词 / 例句填空）、一种"选项是释义"（看词选义）。
 * 所以需要**两个独立的池子**：
 *
 *   · `loadMeaningPool` —— `OptionSource.text` = **释义**（看词选义用）
 *   · `loadFormPool`    —— `OptionSource.text` = **词形**（听音辨词 / 例句填空用）
 *
 * 曾经想过"一个池子两种 text 都存"，但那会让 `pickDistractors` 的
 * **按文本去重**失效（`text` 到底指哪个？），而"四个选项里出现两个一样的"
 * 是一种看起来像界面 bug 的送分题。两个池子各查一次库，代价可以接受。
 *
 * ## 池子只看「难度」，不看「词书」——这一点是刻意的
 *
 * 最早的写法是"池子 = 本词书的词"，但它藏了一个很难查的 bug：
 * 池子会随**查询批次的排除集**与**当前学的是哪本词书**而变，
 * 而出题（一次出 10 个）与判卷（一次判 1 个）的上下文必然不同 ——
 * 池子一变，选出的干扰项就变，**正确项在选项里的位置也跟着变**，
 * 于是判卷算出的答案与用户眼前的卡片对不上（表现为"明明选对了却判错"）。
 *
 * 改成"难度接近的全局词"之后，池子只取决于**这个词自己的难度**：
 * 同一张卡片无论什么时候、由谁、在哪个上下文里判卷，答案都一致。
 * 难度窗口取不满时退回全库前 N 个（同样确定性）。
 */
const POOL_SIZE = 80;

/** 拼写题不需要池子 —— 它是唯一一个词库再小也出得了的题型 */
const POOLLESS = new Set(['spelling']);

/**
 * 出题 / 判卷共用的上下文：这个词**今天的题型**。
 *
 * ⚠️ 不要在这里传"轮次"让两边各自去算 —— 那样一旦轮次变了（每次提交都会变），
 * 两边就会算出不同的题型，而这是静默的（只是答案对不上）。
 * 题型一律由 `resolveType` 定，调用方拿到什么就用什么。
 */
export interface QuizContext {
  /** 今天这道题的题型（已锁定；未锁定时由 `resolveType` 抽取） */
  type: VocabQuestionType;
}

@Injectable()
export class VocabQuizService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 释义池：难度 ±1 的词，按拼写升序取前 N 个（顺序稳定 = 结果可复现）。
   * 窗口内不足 4 个时退回"全库按拼写前 N 个"—— 词库刚起步时不会因此出不了题。
   */
  loadMeaningPool(difficulty: number): Promise<OptionSource[]> {
    return this.poolBy(difficulty, (row) => toOptionSource(row));
  }

  /**
   * 词形池：给"选项是词形"的题型用（听音辨词 / 例句填空）。
   *
   * 与释义池同源、同排序、同回退策略 —— 差别只在 `text` 取词形。
   * 音标为空的词照样可以进池子：它是**干扰项**，用户要选的是拼写，
   * 不需要能朗读；把这类词剔掉反而会让池子变小。
   */
  loadFormPool(difficulty: number): Promise<OptionSource[]> {
    return this.poolBy(difficulty, (row) => formSource(row));
  }

  /**
   * 定下这个词**今天的题型**，并把锁写回库（见文件头"同一轮里必须锁住"）。
   *
   * 三档决策，顺序不能换：
   *   ① 库里已有**今天**的锁 → 直接用（这是"重试不变题"的唯一保证）；
   *   ② 锁是**昨天或更早**的、或压根没有 → 按 `(词 id, 复习轮次)` 重新抽一个，
   *      并把锁与日期一起写回（跨天/跨轮换题）；
   *   ③ 抽出来的题型**今天出不了**（缺音标/例句）→ 走 `pickType` 的降级链。
   *
   * ⚠️ 判定"今天"必须用 `bizDayDate`（与打卡日历同一个折算），不能用 `new Date()`：
   * 两者差一个时区会让锁"每天提前/推迟几小时失效"，表现是**同一晚做两次题、第二次换题**。
   */
  async resolveType(row: WordRow, userId: string): Promise<VocabQuestionType> {
    const src = toQuestionSource(row);
    if (!src) return 'meaning';
    const today = bizDayDate(new Date());

    const existing = await this.prisma.userWordProgress.findUnique({
      where: { userId_wordId: { userId, wordId: row.id } },
      select: { repetitions: true, typeLock: true, typeLockDay: true },
    });

    // ① 今天已经锁过 —— 直接用，**不重算**
    if (existing?.typeLockDay && isSameBizDay(existing.typeLockDay, today) && isQuestionType(existing.typeLock)) {
      if (canBuild(existing.typeLock, src)) return existing.typeLock;
      // 素材今天出不了这个题型（如音标后续被清空）→ 重新抽，并覆盖锁
    }

    // ② 重新抽：种子是复习轮次（不是累计作答次数，见文件头）
    const type = pickType(row.id, existing?.repetitions ?? 0, src);

    // ③ 写回锁。⚠️ 只在**已经有进度行**时更新：新词此时还没建行，
    //    由第一次作答的 upsert 一并写入（否则这里 upsert 会与那次写入打架）
    if (existing) {
      await this.prisma.userWordProgress.update({
        where: { userId_wordId: { userId, wordId: row.id } },
        data: { typeLock: type, typeLockDay: today },
      });
    }
    return type;
  }

  /** 单张卡片的题与答案（判卷用）。素材不够 / 凑不出选项时返回 null */
  async buildOne(row: WordRow, ctx: QuizContext): Promise<Question | null> {
    const src = toQuestionSource(row);
    if (!src) return null;
    const q = buildQuestion(src, ctx.type, await this.poolFor(ctx.type, row.difficulty, null));
    return enoughOptions(q) ? q : null;
  }

  /**
   * 行 → 卡片。**凑不出选项的词会被丢掉**（不是编一个假选项凑数），
   * 所以返回条数可能少于入参 —— 调用方据此判断"今日队列是不是真的没词"。
   *
   * `typeOf` 是行 → **今天已锁定的题型**。调用方必须先跑 `resolveType`
   * 把它定下来再传进来，不能在这里现算（现算 = 每张卡片各自决定，无法保证
   * 判卷时算出同一个）。
   */
  async buildCards(
    rows: WordRow[],
    isNew: boolean,
    typeOf: (row: WordRow) => VocabQuestionType,
  ): Promise<VocabCard[]> {
    const prepared: { row: WordRow; src: QuestionSource }[] = [];
    for (const row of rows) {
      const src = toQuestionSource(row);
      if (src) prepared.push({ row, src });
    }
    if (prepared.length === 0) return [];

    // 同一批词的难度往往集中在两三档，按 `难度+用途` 缓存池子，避免每个词都查一次库
    const cache = new Map<string, OptionSource[]>();
    const cards: VocabCard[] = [];
    for (const { row, src } of prepared) {
      const type = typeOf(row);
      const q = buildQuestion(src, type, await this.poolFor(type, row.difficulty, cache));
      if (!enoughOptions(q)) continue;
      cards.push(toCard(row, q!, isNew));
    }
    return cards;
  }

  /**
   * 取这道题需要的池子。
   *
   * 过滤条件刻意没用 `if (!q)` 那种窄化 —— `buildQuestion` 可能返回 null，
   * 而这里要拿的是 `q.type`。所以先取题型再取池子（`type` 一定是已定的）。
   */
  private async poolFor(
    type: string,
    difficulty: number,
    cache: Map<string, OptionSource[]> | null,
  ): Promise<OptionSource[]> {
    if (POOLLESS.has(type)) return [];
    const kind = type === 'meaning' ? 'm' : 'f';
    const key = `${kind}:${difficulty}`;
    if (cache && cache.has(key)) return cache.get(key) ?? [];
    const pool = kind === 'm' ? await this.loadMeaningPool(difficulty) : await this.loadFormPool(difficulty);
    cache?.set(key, pool);
    return pool;
  }

  /** 难度 ±1 优先，不足 4 个退回全库；排序与截断都由 Prisma 负责（结果可复现） */
  private async poolBy(
    difficulty: number,
    map: (row: WordRow) => OptionSource | null,
  ): Promise<OptionSource[]> {
    const near = await this.queryPool(
      { difficulty: { in: [difficulty - 1, difficulty, difficulty + 1] } },
      map,
    );
    return near.length >= MIN_OPTIONS ? near : this.queryPool({}, map);
  }

  private async queryPool(
    where: Record<string, unknown>,
    map: (row: WordRow) => OptionSource | null,
  ): Promise<OptionSource[]> {
    // `orderBy spelling asc` 是**确定性**的关键：池子的顺序决定干扰项选谁与正确项排第几
    const rows = await this.prisma.word.findMany({
      where,
      orderBy: { spelling: 'asc' },
      take: POOL_SIZE,
      select: WORD_SELECT,
    });
    const pool: OptionSource[] = [];
    for (const row of rows) {
      const source = map(row as WordRow);
      if (source) pool.push(source);
    }
    return pool;
  }
}

/** 选项够不够成题：拼写题不需要选项，其余至少 4 个 */
export function enoughOptions(q: Question | null): q is Question {
  if (!q) return false;
  return POOLLESS.has(q.type) || q.options.length >= MIN_OPTIONS;
}

/** 词形池的候选项：`text` = 词形。词形为空的脏数据直接丢掉 */
function formSource(row: WordRow): OptionSource | null {
  const spelling = row.spelling.trim();
  return spelling ? { id: row.id, text: spelling } : null;
}

/**
 * 行 → 组题素材。
 *
 * 释义一条都没有时返回 `null`：这类词**出不了任何题型**（拼写与看词选义都要释义）。
 * 调用方据此把它从今日队列里剔掉，而不是让它以"文本为空的选项"混进卡片。
 */
export function toQuestionSource(row: WordRow): QuestionSource | null {
  const senses = toSenses(row.senses);
  if (senses.length === 0) return null;
  return {
    id: row.id,
    spelling: row.spelling.trim(),
    phonetic: row.phonetic?.trim() ?? '',
    ukPhonetic: row.ukPhonetic?.trim() ?? '',
    senses,
    examples: toExamples(row.examples),
    phrases: toPhrases(row.phrases),
  };
}

/**
 * 题 → 卡片（**剥掉答案**）。
 *
 * `listening` 题型必须清空 `spelling` 与 `phonetic` —— 这个题型的全部难度
 * 就在于"只给声音、不给字"。留一个词形在屏幕上，它就退化成送分题。
 * 而**清空动作写在这里而不是界面里**：界面上"不小心把词形显示出来"
 * 是不会有任何报错的，只会让这个题型静默失效。
 */
function toCard(row: WordRow, q: Question, isNew: boolean): VocabCard {
  const listening = q.type === 'listening';
  return {
    wordId: row.id,
    type: q.type,
    spelling: listening ? '' : row.spelling,
    phonetic: listening ? '' : (row.phonetic?.trim() ?? ''),
    difficulty: row.difficulty,
    isNew,
    options: q.options,
    prompt: q.prompt,
    promptZh: q.promptZh,
    senseText: q.senseText,
  };
}

/**
 * 两个日期是不是**同一个学习日**。
 *
 * 必须按业务日折算后比，不能直接比 `toDateString()`：`typeLockDay` 是 `@db.Date`
 * （只有日粒度、且以本地时区读回），而 `bizDayDate(new Date())` 也是日粒度 ——
 * 直接比 `Date` 对象会因为"一个是 UTC 零点、一个是本地零点"而**总是判定不相等**，
 * 于是锁每天失效，表现是"同一晚做两次题、第二次换题了"，且不报任何错。
 */
function isSameBizDay(a: Date, b: Date): boolean {
  return bizDayDate(a).getTime() === bizDayDate(b).getTime();
}
