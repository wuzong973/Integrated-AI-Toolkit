/**
 * 单次逻辑调用的时间预算。
 *
 * ## 为什么需要它（本项目最贵的一个坑）
 *
 * 对外部 AI 服务的超时是**乘法放大**的：
 *
 * ```
 * 模型数 × (重试次数 × 单次超时 + 退避总和)
 * ```
 *
 * 实测过的两处：
 * - LLM：2 个模型 × (3 次 × 60s + 退避 1s+4s) = **370 秒**
 * - ASR：单次超时被设成 120s，而实测成功耗时只有 78~97ms
 *
 * 而小程序侧 `request.ts` 的超时只有 **30 秒**。也就是说：用户在 30 秒时已经看到
 * "网络开小差了"，后端却还在继续打请求，把供应商额度烧到几分钟后。
 * **钱花了、用户什么都没得到、日志里还看不出异常** —— 这类故障最难发现。
 *
 * 这个类把"总时长"变成一个**不变量**：无论配置里有多少模型、多少次重试，
 * 一次逻辑调用的墙钟时间都不会超过 `totalMs`。
 *
 * ## 两个刻意的设计选择
 *
 * 1. **预算耗尽时主动停下，而不是"再试最后一次"**。
 *    剩余时间不足一次典型请求时再发出去只会超时，却照样消耗配额。
 * 2. **退避等待会被压缩**。原定的 `16s` 退避放进 `20s` 预算里会一口吃掉整个额度，
 *    导致后面明明还有额度却发不出请求。
 *
 * ## 可测性
 *
 * 时间源通过构造参数注入，单测可以传假时钟，不必真的 sleep ——
 * 否则"验证 370 秒不会发生"的用例本身就要跑 370 秒。
 */
export class TimeBudget {
  private readonly deadline: number;

  constructor(
    totalMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.deadline = now() + Math.max(0, totalMs);
  }

  /** 剩余预算（毫秒），不为负 */
  remaining(): number {
    return Math.max(0, this.deadline - this.now());
  }

  /**
   * 本次尝试可用的超时：取「per-attempt 上限」与「剩余预算」的较小值。
   * 这样最后一次尝试不会因为"单次超时 60s"而把总预算冲爆。
   */
  attemptTimeout(perAttemptMs: number): number {
    return Math.max(1, Math.min(perAttemptMs, this.remaining()));
  }

  /** 剩余时间是否还够发一次请求 */
  canAttempt(): boolean {
    return this.remaining() >= MIN_ATTEMPT_MS;
  }

  /**
   * 退避等待时长。
   *
   * 若原定退避会把预算耗尽，则**缩短到"刚好留出一次尝试"**；
   * 连一次尝试都留不出时返回 0（跳过等待，让循环在下一轮判定中收尾）。
   */
  backoff(rawMs: number): number {
    const left = this.remaining() - MIN_ATTEMPT_MS;
    if (left <= 0) return 0;
    return Math.min(rawMs, left);
  }
}

/**
 * 一次逻辑调用**至少**要留出这么多剩余时间，才值得再发一次请求。
 *
 * 依据：本项目实测耗时 —— LLM 意图 4s / 大纲 6~25s；ASR 成功 78~97ms 但偶发挂起。
 * 剩余不足 3 秒时请求几乎必然超时，而超时同样消耗供应商配额 ——
 * 所以"不再尝试"比"再试一次"更划算：用户更早拿到失败提示，平台少花一次钱。
 */
export const MIN_ATTEMPT_MS = 3000;
