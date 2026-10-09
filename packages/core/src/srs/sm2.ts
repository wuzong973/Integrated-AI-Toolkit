/**
 * SM-2 间隔重复调度（记单词 / 四六级词汇训练）
 *
 * ## 为什么放在 `packages/core` 而不是后端
 *
 * 它是**业务规则**（"这个词下次什么时候该复习"），不是端侧或服务端逻辑：
 * 后端用它落库、界面用它显示"下次复习：3 天后"、助手能力以后也要用它。
 * 两边各写一份必然漂移，而漂移的表现是**界面说"明天见"、实际后天才会出现** ——
 * 用户只会觉得"这功能时好时坏"，往代码上找却找不到。
 *
 * ## 为什么 EF 用整数（百分之一）而不是小数
 *
 * SM-2 的 EF 是个小数（1.3 起，每次复习微调）。浮点会在**同一序列被重复计算**时累积误差，
 * 而复习调度是长期、可重复、要能对账的：同一天、同样的答题记录算两次，
 * 必须得到**同一个到期日**。所以 EF 全程用 `×100` 的整数（`250` = 2.50），
 * 只有算间隔时做一次整数乘除。字段注释见 `schema.prisma` 的 `UserWordProgress`。
 *
 * ## 与教材版 SM-2 的一致与三处刻意偏离
 *
 * 一致：`q < 3` 视为没答上 → 连续次数归零、间隔回到 1 天；`q >= 3` 时
 * n=0 → 1 天、n=1 → 6 天、n≥2 → 上次间隔 × EF；EF 增量公式与 1.3 下限原样照搬。
 *
 * 偏离（都写清楚，避免以后被当成 bug 改掉）：
 *   ① **间隔有上限** `MAX_INTERVAL_DAYS`。原始 SM-2 无上限，长期使用会算出几万天，
 *      一旦将来调整权重就再也追不回来；上限把"最长约一年半"变成明确约定。
 *   ② **算间隔用「旧」EF、之后才更新 EF** —— 这是原始论文的语句顺序。
 *      不少实现写成"先用新 EF 算"，两者结果不同；这里与论文一致并用单测钉住。
 *   ③ **答错也更新 EF**（同样照论文）。很多实现选择答错不动 EF，那是另一种口径。
 *
 * ## 本模块**不管**"答错的词今天要不要再练一遍"
 *
 * 答错时间隔一律回到 1 天，也就是明天见。而"四选一答错后立刻回到今日队列再练一遍"
 * 是**当次学习流程**的编排（后端/界面层决定），不是跨天调度。
 * 把两者混在一起会让 SM-2 的语义变模糊，也让测试没法断言。
 */
import { MS, addDays, bizDayStart, isDueOnOrBefore } from '../utils/time';

/** 评分档位（SM-2 原生 0-5）。`< 3` 记为"没答上" */
export const GRADES = [0, 1, 2, 3, 4, 5] as const;
export type Grade = (typeof GRADES)[number];

/** 通过线：≥ 此分才算"复述成功"，连续次数才会累加 */
export const PASS_GRADE = 3;

/** EF 下限（1.30 的百分之一）—— 低于它会出现"越背越密"的死循环 */
export const EF_MIN = 130;

/** 初始 EF（2.50 的百分之一） */
export const EF_INITIAL = 250;

/** 间隔上限：约一年半 */
export const MAX_INTERVAL_DAYS = 540;

/**
 * 成熟度阈值（天）。取 Anki 的"成熟卡"口径（21 天），
 * 好处是以后想对照 Anki 的行为不需要重新推一遍。
 */
export const REVIEW_INTERVAL_DAYS = 21;
export const MASTERED_INTERVAL_DAYS = 60;

export type SrsStateName = 'new' | 'learning' | 'review' | 'mastered';

/** 调度状态（与 `UserWordProgress` 的 ease_factor / interval_days / repetitions 一一对应） */
export interface SrsState {
  /** EF × 100 */
  easeFactor: number;
  intervalDays: number;
  /** 连续复述成功次数（SM-2 的 n） */
  repetitions: number;
}

/** 新词的初始状态。到期时刻由调用方给（首次学就是"现在"） */
export const INITIAL_SRS_STATE: SrsState = {
  easeFactor: EF_INITIAL,
  intervalDays: 0,
  repetitions: 0,
};

/** 一次复习的结果 */
export interface SrsReviewResult extends SrsState {
  /** 下次到期时刻 */
  dueAt: Date;
  /** 由间隔推导的成熟度 */
  state: SrsStateName;
}

/**
 * 由间隔推导成熟度。
 *
 * 刻意**只看 interval**：这样它天然单调 —— 不会出现"越背越久反而降级"，
 * 也不需要在状态里额外存一个字段（多一个字段就多一处可能不一致）。
 */
export function deriveState(intervalDays: number): SrsStateName {
  if (intervalDays <= 0) return 'new';
  if (intervalDays < REVIEW_INTERVAL_DAYS) return 'learning';
  if (intervalDays < MASTERED_INTERVAL_DAYS) return 'review';
  return 'mastered';
}

/** 评分合法性（库里的 lastGrade 是 Int，读写时都要收口，避免脏值进算法） */
export function isGrade(v: unknown): v is Grade {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 5;
}

/**
 * EF 增量：`EF' = EF + (0.1 - (5-q) × (0.08 + (5-q) × 0.02))`。
 *
 * 换成"百分之一"的整数后是 `10 - miss × (8 + miss × 2)`（`miss = 5 - q`），
 * 与论文逐项对应：q=5 → +10、q=4 → 0、q=3 → -14、q=2 → -32、q=1 → -54、q=0 → -80。
 */
function nextEaseFactor(easeFactor: number, grade: Grade): number {
  const miss = 5 - grade;
  return Math.max(EF_MIN, easeFactor + (10 - miss * (8 + miss * 2)));
}

/**
 * 下次间隔（天）。用**旧** EF 计算，见文件头偏离 ②。
 *
 * 三层兜底都不是多余的：`>= 1` 防"间隔 0 天 = 永远到期"；
 * `MAX_INTERVAL_DAYS` 见文件头偏离 ①；`Math.round` 而非 `floor`，
 * 否则 EF 略小于 1 的组合（理论到不了，但脏数据能）会把间隔压成 0。
 */
function nextIntervalDays(state: SrsState, grade: Grade): number {
  if (grade < PASS_GRADE) return 1;
  if (state.repetitions <= 0) return 1;
  if (state.repetitions === 1) return 6;
  const grown = Math.round((state.intervalDays * state.easeFactor) / 100);
  return Math.min(MAX_INTERVAL_DAYS, Math.max(1, grown));
}

/**
 * 复习一次，得到新的调度状态与到期时刻。
 *
 * @param state 当前状态（新词传 `INITIAL_SRS_STATE`）
 * @param grade 0-5
 * @param at    本次复习时刻（**必须由调用方传入**，不在这里取 now()：同一个作业里
 *              多个词要共享同一个"现在"，否则同一批复习会算出不同基准日）
 */
export function review(state: SrsState, grade: Grade, at: Date): SrsReviewResult {
  if (!isGrade(grade)) {
    throw new Error(`非法评分：${String(grade)}（应为 0-5 的整数）`);
  }
  const intervalDays = nextIntervalDays(state, grade);
  const easeFactor = nextEaseFactor(state.easeFactor, grade);
  const repetitions = grade < PASS_GRADE ? 0 : state.repetitions + 1;

  return {
    easeFactor,
    intervalDays,
    repetitions,
    dueAt: addDays(bizDayStart(at), intervalDays),
    state: deriveState(intervalDays),
  };
}

/**
 * 由界面动作映射到评分。
 *
 * 把这些映射**集中在一处**（而不是散在页面里各写一个 5/3/1）：
 * 它们直接决定复习节奏，改一处不同步就变成"同样答对、有的词排得远有的排得近"。
 *
 * ⚠️ 名字带 `FromOutcome` 是刻意的：`@qz/core` 里已有一个 `gradeOf`
 * （`quality/standard.ts`，AI 产出质量分档），两者语义无关，
 * 同名会让 `export *` 在 barrel 处直接冲突（TS2308），也会让读代码的人以为是同一个东西。
 *
 * @param outcome 自评/答题结果
 */
export function gradeFromOutcome(
  outcome: 'known' | 'vague' | 'unknown' | 'right' | 'wrong',
): Grade {
  switch (outcome) {
    case 'known':
      return 5;
    // 「有点印象，但答案不是自己写出来的」—— 通过线，但间隔涨得慢
    case 'vague':
    case 'right':
      return 3;
    case 'unknown':
    case 'wrong':
      return 1;
  }
}

/** 是否已到期（按业务日比较，见 `bizDayStart` 的说明） */
export function isDue(dueDate: Date | number, at: Date = new Date()): boolean {
  return isDueOnOrBefore(dueDate, at);
}

/** 距今还有几天到期（负数 = 已过期）。用于界面显示"3 天后" */
export function daysUntilDue(dueDate: Date | number, at: Date = new Date()): number {
  const diff = bizDayStart(dueDate).getTime() - bizDayStart(at).getTime();
  return Math.round(diff / MS.day);
}
