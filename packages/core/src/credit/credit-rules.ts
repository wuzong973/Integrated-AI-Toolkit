/**
 * 信用分规则（任务清单 M3-16；文档 6.6.4）
 *
 * 纯函数、零依赖：小程序与后端共用同一份口径，避免"页面上写着 +2、
 * 实际加了几分"这种两边各算一遍必然走偏的问题。
 *
 * ## 与小程序信用页的对应关系（**改这里必须同时改那里**）
 *
 * `apps/mp/pkg-mine/credit/index.ts` 的 `RULES` 数组是本文件的**展示镜像**
 * （小程序不参与 npm workspaces、import 不到 @qz/core，只能镜像一份）：
 *
 * | 本函数返回            | mp RULES 条目            |
 * | -------------------- | ----------------------- |
 * | `creditDeltaForRating(5) === +2` | `{ action: '完成一单（5 星）', delta: '+2' }` |
 * | `creditDeltaForRating(4) === +1` | `{ action: '完成一单（4 星）', delta: '+1' }` |
 * | `creditDeltaForRating(1..2) === -3` | `{ action: '收到差评', delta: '-3' }` |
 * | `creditDeltaForRating(3) === 0`  | ——（文档 6.6.4"3 星及以下 0"，中性档不展示） |
 *
 * mp RULES 里另有"按时交付 +1 / 超时交付 -5 / 违约 -10 / 仲裁判责 -15"四条，
 * 它们**不由评价产生**（依赖交付超时统计与平台仲裁，M3-15/M4 尚未开工），
 * 因此本文件只覆盖"评价 → 信用"这一段，不给尚未实现的触发器摆规则。
 */

/** 信用分下限（文档 6.6.4：范围 0~100） */
export const CREDIT_SCORE_MIN = 0;
/** 信用分上限：100 分封顶，评价再多也不会溢出 */
export const CREDIT_SCORE_MAX = 100;
/** 新账号初始分（与 `user_profile.credit_score` 的默认值一致） */
export const CREDIT_SCORE_DEFAULT = 80;

/** 差评线：≤ 该星级视为"差评"（文档 6.6.4"收到差评（1~2 星）−3"） */
export const BAD_RATING_MAX = 2;

/**
 * 星级 → 信用分增减（文档 6.6.4 表格的"完成一单"三行 + "收到差评"一行）。
 *
 * @param rating 1~5 的整数星级
 * @throws 星级不是 1~5 的整数时抛错。**不静默按 0 处理** ——
 *   那会让"上游校验漏了"变成一个永远查不出来的"分数怎么没变"。
 *   调用方（验收流程）已用 `AcceptReviewSchema` 卡过区间，这里抛错等于"不可能发生"，
 *   真发生了就是 bug，必须炸在事务里而不是把错账写进库。
 */
export function creditDeltaForRating(rating: number): number {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error(`非法星级：${rating}`);
  }
  if (rating >= 5) return 2;
  if (rating === 4) return 1;
  if (rating <= BAD_RATING_MAX) return -3;
  return 0; // 3 星：中性，不奖不罚
}

/**
 * 把分数夹回 0~100（文档 6.6.4 的取值范围）。
 *
 * 为什么必须由本函数负责而不是交给数据库：`user_profile.credit_score` 是 `Int`，
 * 没有 CHECK 约束，写进 101 或 -3 不会报错，只会让"信用 101"出现在页面上，
 * 并且此后无论再扣多少分都回不到正常区间。非整数一律向下取整（分数是整数，红线）。
 */
export function clampCreditScore(score: number): number {
  if (!Number.isFinite(score)) throw new Error(`非法信用分：${score}`);
  const int = Math.trunc(score);
  if (int < CREDIT_SCORE_MIN) return CREDIT_SCORE_MIN;
  if (int > CREDIT_SCORE_MAX) return CREDIT_SCORE_MAX;
  return int;
}

/**
 * 已有增减值 → 新分数（先夹旧值、再加、再夹结果）。
 *
 * 单独导出这一层是因为写入方常常**已经知道 delta**（比如刚用它记完流水），
 * 这时再按星级算一遍就是两处换算 —— 一旦两处不一致，没人说得清该信谁。
 * 夹取顺序也不能反：先加后夹会让 99 分收到 +2 直接写进 101。
 */
export function advanceCreditScore(currentScore: number, delta: number): number {
  if (!Number.isInteger(delta)) throw new Error(`非法信用增减值：${delta}`);
  return clampCreditScore(clampCreditScore(currentScore) + delta);
}

/**
 * 星级 + 当前分 → 新分（"评价 → 信用"这一跳的完整一步）。
 *
 * 本质就是 `advanceCreditScore(current, creditDeltaForRating(rating))`，
 * 单列一个函数是为了让调用方**只经一次换算**就拿到分数。
 */
export function nextCreditScore(currentScore: number, rating: number): number {
  return advanceCreditScore(currentScore, creditDeltaForRating(rating));
}
