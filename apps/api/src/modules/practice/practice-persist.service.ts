import { Injectable } from '@nestjs/common';
import {
  INITIAL_SRS_STATE,
  bizDayDate,
  gradeFromOutcome,
  review,
  type Grade,
  type PracticeMode,
} from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * 落库（练习中心唯一的写路径）
 *
 * ## 三个模块共用这一份，是刻意的
 *
 * 句子 / 口语 / 作文的区别只在"提交的是什么、怎么判分"。**落库是三件完全一样的事**：
 *   ① `practice_progress` —— SM-2 调度结果（EF / 间隔 / 连续次数 / 到期日 / 成熟度）
 *   ② `practice_attempt`  —— 作答流水（作文要回看原文，所以存全文）
 *   ③ `practice_study_log` —— 当天计数（打卡日历的唯一数据源）
 *
 * 抽出来单独成文件而不是留在 `practice-submit.service.ts` 里，有两个具体原因：
 *   · 那个文件已经超 300 行（`submitSentence` / `submitSpeak` / `submitEssay`
 *     三段各自带一大段设计说明），再塞落库就会顶着红线；
 *   · **落库是"错了最难查"的那一段** —— 计数漂移、锁失效都是静默的，
 *     单独一个文件才装得下它的说明。
 *
 * ## 三张表必须同事务
 *
 * 分开写会出现"进度说练了 10 题、日志记了 8 题"，而这**不会报错**，
 * 只让日历与统计页互相矛盾。
 *
 * ## `modeLock` 的处理与词汇模块的 `typeLock` **逐字同构**
 *
 * 见 `vocab-answer.service.ts` 的说明：当天已锁时不覆盖，否则写本次的模式；
 * 新题在 create 分支里写锁 —— 少了这一步，第一次作答后 `repetitions` 变了，
 * 重试会换模式（表现是"同一句话第二次进去突然变成另一种题面"）。
 */
@Injectable()
export class PracticePersistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: AppLogger,
  ) {}

  /** 写入一次练习（三张表同事务），返回 SM-2 的调度结果 */
  async write(
    input: PracticeWriteInput,
  ): Promise<{ intervalDays: number; dueAt: Date; state: string }> {
    const now = new Date();
    const day = bizDayDate(now);

    const existing = await this.prisma.practiceProgress.findUnique({
      where: { userId_kind_refId: { userId: input.userId, kind: input.kind, refId: input.refId } },
    });
    const next = review(srsStateOf(existing), input.grade, now);
    // ⚠️ `review()` 返回的字段名是 `dueAt`，而 Prisma 列叫 `dueDate` ——
    // 直接把 `next` 展开给 Prisma 会在**运行时**报 "Unknown argument 'dueAt'"，
    // 看起来像 schema 没重新生成。所以这里显式转一次名，不用 `...next`
    const schedule = {
      easeFactor: next.easeFactor,
      intervalDays: next.intervalDays,
      repetitions: next.repetitions,
      dueDate: next.dueAt,
      state: next.state,
    };
    // 模式锁的补写规则（含"新题必须在 create 分支写锁"）收在 `lockPatchOf` 里 ——
    // 留在这里会让本方法多出 2 个分支，而它的说明已经够长了
    const lockPatch = lockPatchOf(existing, input.mode, day);
    const countColumn = countColumnOf(input.module);
    const bump = { [countColumn]: 1 };

    await this.prisma.$transaction([
      this.prisma.practiceStudyLog.upsert({
        where: { userId_day: { userId: input.userId, day } },
        update: {
          ...incrementOf(countColumn),
          passCount: { increment: input.pass ? 1 : 0 },
          failCount: { increment: input.pass ? 0 : 1 },
        },
        create: {
          userId: input.userId,
          day,
          ...bump,
          passCount: input.pass ? 1 : 0,
          failCount: input.pass ? 0 : 1,
        },
      }),
      this.prisma.practiceAttempt.create({
        data: {
          userId: input.userId,
          kind: input.kind,
          refId: input.refId,
          mode: input.mode,
          // ⚠️ 列名是 `passed`（不是 `pass`）：`pass` 在 SQL 里是保留字，
          // 而 `passed` 既避开保留字又读得通。写错的话 Prisma 报
          // "Unknown argument 'pass'"，看起来像 schema 没生成 —— 实际只是名字不同
          passed: input.pass,
          score: input.score,
          // 作文动辄上千字符，`submitted` 是 Text 列；截到 4000 是防"粘贴了一整篇文章"
          // 那种输入把行撑爆（DTO 层的上限也是 4000，这里再兜一次）
          submitted: input.submitted.slice(0, ATTEMPT_TEXT_MAX),
          elapsedMs: input.elapsedMs ?? null,
          detail: input.detail as object,
        },
      }),
      this.prisma.practiceProgress.upsert({
        where: { userId_kind_refId: { userId: input.userId, kind: input.kind, refId: input.refId } },
        update: {
          ...schedule,
          ...lockPatch,
          passCount: { increment: input.pass ? 1 : 0 },
          attemptCount: { increment: 1 },
          lastScore: input.score,
        },
        create: {
          userId: input.userId,
          kind: input.kind,
          refId: input.refId,
          ...schedule,
          // 新题首次作答：**必须**把本次模式锁一并写入，否则下次作答会重抽模式 → 换题
          modeLock: input.mode,
          modeLockDay: day,
          passCount: input.pass ? 1 : 0,
          attemptCount: 1,
          lastScore: input.score,
        },
      }),
    ]);

    // 作文单独记一行日志。**不是**为了审计提交（流水表已经有了），
    // 而是为了在"作文分数长期为 0"时能一眼看出是"批改一直失败"还是"用户写得差" ——
    // 后者不会在日志里留下任何痕迹，前者会
    if (input.module === 'write') {
      this.logger.log(
        `作文已提交 userId=${input.userId} refId=${input.refId} score=${input.score} pass=${input.pass}`,
        'Practice',
      );
    }

    return { intervalDays: next.intervalDays, dueAt: next.dueAt, state: next.state };
  }
}

/** 库里的 SRS 状态 → `review()` 要的形状（没有进度行时用初始值） */
function srsStateOf(
  existing: { easeFactor: number; intervalDays: number; repetitions: number } | null,
) {
  if (!existing) return INITIAL_SRS_STATE;
  return {
    easeFactor: existing.easeFactor,
    intervalDays: existing.intervalDays,
    repetitions: existing.repetitions,
  };
}

/**
 * 当天计数列的增量写法。
 *
 * `{ [countColumn]: { increment: 1 } }` 这种动态键在 TS 里会被推成
 * `{ [x: string]: ... }`，Prisma 的精确类型接不住，所以拆成一个显式分支的函数 ——
 * 三个 `if` 换来的是编译期能查出拼错的列名。
 */
function incrementOf(column: 'sentenceCount' | 'speakCount' | 'writeCount') {
  if (column === 'sentenceCount') return { sentenceCount: { increment: 1 } };
  if (column === 'speakCount') return { speakCount: { increment: 1 } };
  return { writeCount: { increment: 1 } };
}

/**
 * 模式锁的补写规则。
 *
 * ⚠️ 三档的差别是**核心语义**，不是优化：
 *   · 新题（`existing === null`）→ 返回 `{}`，由调用方在 **create 分支**里写锁。
 *     在这里写没用 —— upsert 的 create 分支不会带 update 的字段。
 *   · 当天已锁 → `{}`，**不覆盖**（那正是要保护的"同一天重试不换题"）。
 *   · 当天未锁（跨天了）→ 写本次模式。
 */
function lockPatchOf(
  existing: { modeLockDay: Date | null } | null,
  mode: PracticeMode,
  day: Date,
) {
  if (!existing) return {};
  if (sameBizDay(existing.modeLockDay, day)) return {};
  return { modeLock: mode, modeLockDay: day };
}

export interface PracticeWriteInput {
  userId: string;
  module: 'sentence' | 'speak' | 'write';
  kind: 'sentence' | 'topic';
  refId: string;
  mode: PracticeMode;
  /** 是否算通过（句子=全对；口语≥60%；作文=写够词数） */
  pass: boolean;
  score: number;
  /** 用户提交的原文（句子=拼出的英文；口语=ASR 转写；作文=全文） */
  submitted: string;
  elapsedMs?: number;
  grade: Grade;
  /** 附加信息（句子/口语存逐词结果，作文存维度分） */
  detail: unknown;
}

/** 作答原文的落库上限（与 `PracticeSubmitSchema.text` 的上限一致） */
const ATTEMPT_TEXT_MAX = 4000;

/** 模块 → 当天计数列名 */
export function countColumnOf(
  module: 'sentence' | 'speak' | 'write',
): 'sentenceCount' | 'speakCount' | 'writeCount' {
  if (module === 'sentence') return 'sentenceCount';
  if (module === 'speak') return 'speakCount';
  return 'writeCount';
}

/**
 * 作文分数 → SM-2 评分（85+ 通过 / 60+ 勉强 / 其余回炉）。
 *
 * ⚠️ 与句子题的映射（全对=5 / 接近对=3 / 其余=1）分开写：
 * 作文的"85 分"与句子的"全对"不是同一个概念，混在一个函数里
 * 会让将来调句子门槛时误动作文。
 */
export function gradeOfEssay(total: number): Grade {
  if (total >= 85) return gradeFromOutcome('right');
  if (total >= 60) return gradeFromOutcome('vague');
  return gradeFromOutcome('wrong');
}

/**
 * 作文**多长算"完成了一次练习"**（不是"写得好"）。
 *
 * `pass` 对作文的含义只能是这个 —— 见 `practice-submit.service.ts` 文件头。
 */
export function essayPassed(tooShort: boolean): boolean {
  return !tooShort;
}

/**
 * 两个日期是不是**同一个学习日**。
 *
 * ⚠️ 与 `vocab-quiz.ts` / `vocab-answer.service.ts` 的同名函数是同一套判据：
 * 直接比 `Date` 会因为 UTC 零点与本地零点而**永远判不相等**，
 * 于是模式锁每天失效（表现是"同一天重试会换题"，且没有任何报错）。
 */
export function sameBizDay(a: Date | null, b: Date): boolean {
  if (!a) return false;
  return bizDayDate(a).getTime() === bizDayDate(b).getTime();
}
