import { describe, expect, it } from 'vitest';

import { MIN_ATTEMPT_MS, TimeBudget } from '../time-budget';

/**
 * 时间预算（排查报告 P1-3）
 *
 * 这个文件存在的唯一理由：**超时是乘法放大的**。
 * 曾经 LLM 的 `模型数 × (重试次数 × 单次超时 + 退避)` 最坏能到 370 秒，
 * 而小程序请求超时只有 30 秒 —— 前端早断了，后端还在烧配额。
 *
 * 用假时钟而不是真的 sleep：否则"验证 370 秒不会发生"的用例本身要跑 370 秒。
 */
describe('TimeBudget —— 总预算是硬上限，不是建议值', () => {
  /** 可控时钟 */
  function fakeClock(start = 0) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it('剩余时间随时间流逝递减，且不为负', () => {
    const c = fakeClock();
    const b = new TimeBudget(10_000, c.now);
    expect(b.remaining()).toBe(10_000);
    c.advance(4_000);
    expect(b.remaining()).toBe(6_000);
    c.advance(99_000);
    expect(b.remaining()).toBe(0); // 绝不返回负数，否则 canAttempt 判断会反过来
  });

  it('单次尝试超时被剩余预算夹住（不能让最后一次冲爆总预算）', () => {
    const c = fakeClock();
    const b = new TimeBudget(10_000, c.now);
    // 剩余充足：用 per-attempt 上限
    expect(b.attemptTimeout(5_000)).toBe(5_000);
    // 只剩 2s：必须退到 2s，否则一次请求就能超出总预算
    c.advance(8_000);
    expect(b.attemptTimeout(5_000)).toBe(2_000);
    // 剩余为 0 时仍给出正数（AbortSignal.timeout 不接受 0），但配合 canAttempt 不会真的发出
    c.advance(5_000);
    expect(b.attemptTimeout(5_000)).toBeGreaterThan(0);
  });

  it('剩余不足一次典型请求时不再尝试（避免"必然超时还花钱"）', () => {
    const c = fakeClock();
    const b = new TimeBudget(10_000, c.now);
    expect(b.canAttempt()).toBe(true);
    c.advance(10_000 - MIN_ATTEMPT_MS + 1);
    expect(b.canAttempt()).toBe(false);
  });

  it('退避等待被夹到"刚好留出一次尝试"，不吞掉整个预算', () => {
    const c = fakeClock();
    const b = new TimeBudget(6_000, c.now);
    // 原定退避 16s，但只剩 6s → 只能等到 6s - MIN_ATTEMPT_MS
    expect(b.backoff(16_000)).toBe(6_000 - MIN_ATTEMPT_MS);
  });

  it('预算已不足以再尝试时，退避返回 0（跳过等待，让循环收尾）', () => {
    const c = fakeClock();
    const b = new TimeBudget(MIN_ATTEMPT_MS, c.now);
    expect(b.backoff(16_000)).toBe(0);
  });

  it('退避不超过原定值（预算充足时不额外延长）', () => {
    const c = fakeClock();
    const b = new TimeBudget(60_000, c.now);
    expect(b.backoff(1_000)).toBe(1_000);
    expect(b.backoff(4_000)).toBe(4_000);
  });
});
