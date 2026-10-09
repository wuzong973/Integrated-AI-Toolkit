import { Injectable } from '@nestjs/common';
import {
  MODES_BY_MODULE,
  PRACTICE_MODULE_ORDER,
  PRACTICE_MODULE_TITLES,
  bizDayDate,
  bizDayStart,
  type PracticeModule,
  type PracticeMode,
} from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';

import type {
  PracticeModulePlan,
  SentenceCard,
  SentenceChunk,
  TopicCard,
} from './dto/practice.dto';

/**
 * 今日练习队列（练习中心的主流程）
 *
 * ## 计划 = 每个模块的固定配额 − 今天已做量
 *
 * 与记单词（`vocab-plan.service.ts`）同一条纪律：**不另存一份"今日进度"**，
 * 已做量从 `practice_study_log` 读。刷新页面得到的是剩余量，不是重新发一遍计划。
 *
 * ## 一次多取（`EXTRA`）再截断
 *
 * 与词汇模块同理：到期复习的题可能因为"素材不完整"被剔除，
 * 不预多取的话队列会比计划少，用户看到"计划 10 题、实际 7 题"却不知道为什么。
 *
 * ## 种子：新题按 `id` 稳定取，复习题按 `dueDate` 取
 *
 * 新题的顺序**必须稳定**（同一用户同一天刷新两次拿到同一批），否则"做了一半
 * 下拉刷新"会换一批题，用户会以为进度丢了。所以按 `id` 升序 ——
 * 用 `createdAt` 也行，但 `id` 是主键、排序代价更低且天然唯一。
 * ⚠️ **不能不加 `orderBy`**：MySQL 不保证无排序时的返回顺序，
 * 换台机器或加了索引就可能变，而这是静默的。
 */
@Injectable()
export class PracticeQueueService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 各模块的单日配额（产品需求定的"单次练习题量"）。
   *
   * - `sentence` 10 题 —— 与记单词的每日目标同量级，多数人 8~12 分钟能做完；
   *   再多会让人中途放弃，而句子练习的价值在"每天见面"而非"一次做完"。
   * - `speak` 6 题 —— 口语要录音，一题平均 20 秒（含听完重录），
   *   6 题约 3 分钟。定 10 题会让人"只练两次就再也不想打开"。
   * - `write` 1 题 —— 一篇 120 词作文认真写要 20 分钟以上，
   *   一天一篇是现实上限；写超了不该催，所以配额是 1。
   */
  static readonly QUOTA: Record<PracticeModule, number> = { sentence: 10, speak: 6, write: 1 };

  /** 配额之外多取的候选数（见文件头"一次多取"） */
  private static readonly EXTRA = 8;

  /**
   * 三个模块的推荐顺序。
   *
   * ⚠️ 转发 `@qz/core` 的常量，**不在这里另写一份**（见那个常量的说明）。
   * 留这个 static 是为了让 `PracticeQueueService.MODULE_ORDER` 这个既有引用
   * 仍然可读 —— 但真值是 core 的那一份。
   */
  static readonly MODULE_ORDER = PRACTICE_MODULE_ORDER;

  /** 某模块今天该练多少（剩余量）与队列里能取到多少 */
  async plan(userId: string, module: PracticeModule): Promise<PracticeModulePlan> {
    const day = await this.dayStat(userId);
    const done = doneOf(day, module);
    const quota = Math.max(0, PracticeQueueService.QUOTA[module] - done);
    const reviewDue = await this.reviewDue(userId, module);

    const bundle = await this.pick(userId, module, quota);
    return {
      module,
      modes: [...MODES_BY_MODULE[module]],
      quota,
      done,
      available: bundle.available,
      reviewDue,
      emptyReason: bundle.emptyReason,
    };
  }

  /**
   * 取某模块的今日队列（`sentence` / `speak` 共用）。
   *
   * ⚠️ 两个模块共用同一张 `practice_sentence` 表，但**筛选条件不同**：
   * 口语只能在 `speakable = true` 的句子上做（含引号的句子用户读不出来，
   * 那一个词永远对不上）。这里按 `module` 分流，而不是让调用方自己筛 ——
   * 让调用方筛的话，漏筛的表现是"口语队列里混进对话引语句"，
   * 用户读完发现 40 分而不知道为什么。
   */
  async sentenceCards(
    userId: string,
    module: PracticeModule,
    limit: number,
  ): Promise<{ cards: SentenceCard[]; mode: PracticeMode }> {
    if (module === 'write') return { cards: [], mode: 'write' };
    const rows = await this.pickSentenceRows(userId, limit, module === 'speak');
    // 句子的默认题面是连词成句；口语只有一种模式
    const mode: PracticeMode = module === 'speak' ? 'speak' : 'chunks';
    const cards = rows.map((r, i) => this.toCard(r, i + 1, mode));
    return { cards, mode };
  }

  /**
   * 取作文题（`write` 模块）。
   *
   * ⚠️ **不按"今天该写哪一篇"随机抽**：作文一天只写一篇，而随机抽会让
   * 用户第二天看到一道他昨天刚写过的题（抽签没记忆）。这里按"我已经练过几次"
   * 升序取 —— 没写过的优先，写过的最少次数的其次。这样既不重复，也不会有
   * "题库里那几道偏题永远抽不到"的问题。
   */
  async topicCards(userId: string, limit: number): Promise<TopicCard[]> {
    if (limit <= 0) return [];
    const rows = await this.prisma.practiceTopic.findMany({
      orderBy: [{ level: 'asc' }, { code: 'asc' }],
      take: TOPIC_POOL,
    });
    const done = await this.prisma.practiceProgress.findMany({
      where: { userId, kind: 'topic', refId: { in: rows.map((r) => r.id) } },
      select: { refId: true, attemptCount: true },
    });
    const countOf = new Map(done.map((d) => [d.refId, d.attemptCount]));
    // 排序键：(已练次数, 原顺序) —— 原顺序是稳定排序的兜底，
    // 保证"同一用户同一天刷新两次拿到同一批"
    const sorted = [...rows].sort((a, b) => {
      const d = (countOf.get(a.id) ?? 0) - (countOf.get(b.id) ?? 0);
      return d !== 0 ? d : a.code.localeCompare(b.code);
    });
    return sorted.slice(0, limit).map((r, i) => ({
      id: r.id,
      index: i + 1,
      code: r.code,
      kind: r.kind,
      level: r.level,
      title: r.title,
      zhBrief: r.zhBrief,
      outline: toOutline(r.outline),
      minWords: r.minWords,
      attempts: countOf.get(r.id) ?? 0,
    }));
  }

  /** 今天的练习计数（按模块拆） */
  async dayStat(userId: string) {
    const log = await this.prisma.practiceStudyLog.findUnique({
      where: { userId_day: { userId, day: bizDayDate() } },
    });
    return {
      sentenceCount: log?.sentenceCount ?? 0,
      speakCount: log?.speakCount ?? 0,
      writeCount: log?.writeCount ?? 0,
      passCount: log?.passCount ?? 0,
      failCount: log?.failCount ?? 0,
    };
  }

  /** 全局累计（统计页用） */
  async totals(userId: string) {
    const day = bizDayStart();
    const [tracked, mastered, due, speak, write, sentence] = await Promise.all([
      this.prisma.practiceProgress.count({ where: { userId } }),
      this.prisma.practiceProgress.count({ where: { userId, state: 'mastered' } }),
      this.prisma.practiceProgress.count({ where: { userId, dueDate: { lte: day } } }),
      this.prisma.practiceAttempt.aggregate({
        where: { userId, mode: 'speak' },
        _avg: { score: true },
        _count: true,
      }),
      this.prisma.practiceAttempt.aggregate({
        where: { userId, mode: 'write' },
        _avg: { score: true },
        _count: true,
      }),
      this.prisma.practiceAttempt.aggregate({
        where: { userId, mode: { in: ['chunks', 'recall', 'listen'] } },
        _count: true,
        // 通过率没有 _avg，用 _sum + _count 手算（Prisma 不支持条件聚合）
        _sum: { score: true },
      }),
    ]);

    return {
      tracked,
      mastered,
      due,
      // ⚠️ 一次没练过时是 0 而不是 100：100 分会让用户以为"我全对了"
      speakAvg: speak._count > 0 ? Math.round(speak._avg.score ?? 0) : 0,
      writeAvg: write._count > 0 ? Math.round(write._avg.score ?? 0) : 0,
      // 用"满分次数 / 总次数"算句子正确率（句子题的 score 只有 100 与不满分两种）
      sentenceAccuracy: this.accuracyOf(sentence._count, sentence._sum.score),
    };
  }

  /**
   * 句子正确率。
   *
   * ⚠️ 这里用 `sumScore / (count * 100)` 而不是另查一次 `passed` 计数：
   * 句子题的 `score` 就是"命中词比例"，**全对才 100**，所以
   * "平均分 ÷ 100" 恰好等于"全对的比例"。多查一次不划算，且两者可能不一致
   * （一个是写入时算的、一个是查询时算的）。
   */
  private accuracyOf(count: number, sumScore: number | null): number {
    if (count === 0) return 0;
    return Math.round(((sumScore ?? 0) / (count * 100)) * 100);
  }

  /** 某模块到期的复习题数 */
  private async reviewDue(userId: string, module: PracticeModule): Promise<number> {
    return this.prisma.practiceProgress.count({
      where: { userId, kind: kindOf(module), dueDate: { lte: bizDayStart() } },
    });
  }

  /** 取题：先复习到期的，不足则补新题（复用 `pickSentenceRows` 的顺序规则） */
  private async pick(
    userId: string,
    module: PracticeModule,
    quota: number,
  ): Promise<{ available: number; emptyReason: string }> {
    if (quota <= 0) return { available: 0, emptyReason: '' };
    if (module === 'write') {
      const n = await this.prisma.practiceTopic.count();
      return { available: Math.min(quota, n), emptyReason: n === 0 ? '作文题库还在建设中' : '' };
    }
    const kind = kindOf(module);
    const [dueCount, total] = await Promise.all([
      this.prisma.practiceProgress.count({
        where: { userId, kind, dueDate: { lte: bizDayStart() } },
      }),
      this.prisma.practiceSentence.count(
        module === 'speak' ? { where: { speakable: true } } : undefined,
      ),
    ]);
    const taken = Math.min(quota, dueCount + Math.max(0, total));
    if (taken > 0) return { available: taken, emptyReason: '' };
    const what = module === 'speak' ? '适合朗读的句子' : '句子素材';
    return {
      available: 0,
      emptyReason: `今天的${PRACTICE_MODULE_TITLES[module]}已经练完了，${what}明天再见`,
    };
  }

  /**
   * 取句子行：**到期复习优先，再补新题**。
   *
   * 为什么复习优先：复习是 SM-2 排出来的"该在这天重现"，
   * 让新题插到它前面会让到期日越拖越远，间隔复习就退化成"随机做题"。
   */
  private async pickSentenceRows(
    userId: string,
    limit: number,
    speakableOnly: boolean,
  ): Promise<SentenceRow[]> {
    if (limit <= 0) return [];
    const due = await this.prisma.practiceProgress.findMany({
      where: { userId, kind: 'sentence', dueDate: { lte: bizDayStart() } },
      // 越早到期的越先复习；同一到期日按 refId 兜底，保证顺序可复现
      orderBy: [{ dueDate: 'asc' }, { refId: 'asc' }],
      take: limit + PracticeQueueService.EXTRA,
      select: { refId: true },
    });
    const dueIds = due.map((d) => d.refId);
    const rows = await this.prisma.practiceSentence.findMany({
      where: { id: { in: dueIds }, ...(speakableOnly ? { speakable: true } : {}) },
      select: SENTENCE_SELECT,
    });
    // `in` 查询不保证顺序（MySQL 按主键返回），要按 dueIds 重排回 SM-2 的顺序
    const order = new Map(dueIds.map((id, i) => [id, i]));
    const ordered = rows.sort(
      (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );

    const remain = limit - ordered.length;
    if (remain <= 0) return ordered.slice(0, limit);

    const fresh = await this.prisma.practiceSentence.findMany({
      where: {
        id: { notIn: dueIds.length > 0 ? dueIds : [''] },
        ...(speakableOnly ? { speakable: true } : {}),
      },
      orderBy: { id: 'asc' },
      take: remain + PracticeQueueService.EXTRA,
      select: SENTENCE_SELECT,
    });
    return [...ordered, ...fresh].slice(0, limit);
  }

  /** 行 → 卡片（含"答案是否下发"的落点，见 `dto` 文件头） */
  private toCard(row: SentenceRow, index: number, mode: PracticeMode): SentenceCard {
    return {
      id: row.id,
      index,
      // ⚠️ 中译英不给英文：给了就等于给答案。见 `dto` 文件头的说明
      en: mode === 'recall' ? null : row.en,
      zh: row.zh,
      chunks: mode === 'chunks' ? toChunks(row.chunks) : null,
      // ⚠️ 音频**在这里一律不下发**：合成是异步且有成本的，
      // 队列里 10 题每次都合成会让"打开练习页"变成一次批量 TTS。
      // 需要时由 `GET /practice/sentences/:id/audio` 单独取（界面点喇叭才调）。
      audio: null,
      level: row.level,
      wordCount: row.wordCount,
    };
  }

  /** 今天已做多少（某模块） */
  static doneOf = doneOf;
}

/** 数据库行（`chunks` 是 Json，读取时要收窄） */
export interface SentenceRow {
  id: string;
  en: string;
  zh: string;
  chunks: unknown;
  level: number;
  wordCount: number;
  speakable: boolean;
}

const SENTENCE_SELECT = {
  id: true,
  en: true,
  zh: true,
  chunks: true,
  level: true,
  wordCount: true,
  speakable: true,
} as const;

/**
 * `chunks` 是 `Json` 列，Prisma 读出来是 `JsonValue`。
 *
 * ⚠️ **不能直接 `as SentenceChunk[]`**：老数据或手改的数据里可能是
 * 字符串、`null`、甚至缺字段。直接断言会让 `.map` 在运行时炸在某个用户的页面上
 * （类型系统在这里帮不上忙，因为 Prisma 的 `JsonValue` 断言是合法的）。
 * 所以逐项校验并**丢掉不合规的块**，宁可显示成"没有砖块"（降级为直接拼写），
 * 也不要整页崩掉。
 */
/**
 * `chunks` 是 `Json` 列，Prisma 读出来是 `JsonValue`。
 *
 * ⚠️ **不能直接 `as SentenceChunk[]`**：老数据或手改的数据里可能是
 * 字符串、`null`、甚至缺字段。直接断言会让 `.map` 在运行时炸在某个用户的页面上
 * （类型系统在这里帮不上忙，因为 Prisma 的 `JsonValue` 断言是合法的）。
 * 所以逐项校验并**丢掉不合规的块**，宁可显示成"没有砖块"（降级为直接拼写），
 * 也不要整页崩掉。
 *
 * ⚠️⚠️ 落库的字段名是 **`text`**，不是 `en`（写入方是 `scripts/db/gen-sentences.mjs`
 * 的 `chunk()`，它 `return out.map((text) => ({ text, zh: '' }))`）。
 * 这里读 `en` 会让**每一块都校验失败**、整列返回 `null` ——
 * 表现是连词成句的砖块区**一片空白**，而库里、接口里都"有数据"，两端都不报错。
 * 对外契约（`SentenceChunk`）仍然用 `en`，转换只在这一层做。
 */
function toChunks(raw: unknown): SentenceChunk[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out = raw.map(toChunk).filter((c): c is SentenceChunk => c !== null);
  return out.length > 0 ? out : null;
}

/** 单个砖块：校验失败返回 `null`（该块被丢掉，不影响其余块） */
function toChunk(item: unknown): SentenceChunk | null {
  if (!item || typeof item !== 'object') return null;
  // 兼容两种键名：库里是 `text`，早期数据可能写成 `en`
  const row = item as { text?: unknown; en?: unknown; zh?: unknown };
  const en = typeof row.text === 'string' ? row.text : row.en;
  if (typeof en !== 'string' || !en.trim()) return null;
  return { en, zh: typeof row.zh === 'string' ? row.zh : '' };
}

/** 作文候选池大小（一次多取，排序后截断 —— 见 `topicCards`） */
const TOPIC_POOL = 60;

/**
 * `practice_topic.outline` 是 `Json` 列，读出来是 `JsonValue`。
 *
 * ⚠️ **不能直接 `as string[]`**：老数据或手改的数据里可能是字符串、`null`、
 * 甚至嵌套对象。直接断言会让 `.map` 在运行时炸在某个用户的页面上 ——
 * 而 Prisma 的 `JsonValue` 断言在类型上是合法的，编译器不会拦。
 * 所以逐项校验并过滤。
 */
function toOutline(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string' && Boolean(x.trim()));
}

/** 模块 → `practice_progress.kind` */
export function kindOf(module: PracticeModule): 'sentence' | 'topic' {
  return module === 'write' ? 'topic' : 'sentence';
}

/** 今天某模块做了几题 */
function doneOf(
  day: { sentenceCount: number; speakCount: number; writeCount: number },
  module: PracticeModule,
): number {
  if (module === 'sentence') return day.sentenceCount;
  if (module === 'speak') return day.speakCount;
  return day.writeCount;
}
