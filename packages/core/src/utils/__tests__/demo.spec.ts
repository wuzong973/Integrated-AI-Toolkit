import { describe, expect, it } from 'vitest';

import { DEMO_TASK_NO_PREFIX, isDemoTaskNo } from '../demo';

/**
 * 演示数据识别（红线 10 / 排查报告 P2-7）
 *
 * 两种 bug 形态都很贵：
 * - **漏判**（示例数据当成真实任务）→ 用户看到 4 条像模像样的任务，
 *   分不清是平台真实需求还是初始化脚本造的数据；
 * - **误判**（真实任务当成示例）→ 界面上给真实任务挂"演示数据"角标，
 *   发布者会觉得自己的需求被当成假的。
 * 因此两个方向都要覆盖。
 */
describe('isDemoTaskNo —— 示例数据必须可辨识', () => {
  it('识别 QZ-DEMO- 前缀的编号', () => {
    expect(isDemoTaskNo('QZ-DEMO-0001')).toBe(true);
    expect(isDemoTaskNo('QZ-DEMO-0004')).toBe(true);
  });

  it('大小写不敏感（编号可能由不同来源生成）', () => {
    expect(isDemoTaskNo('qz-demo-0001')).toBe(true);
    expect(isDemoTaskNo('Qz-Demo-0001')).toBe(true);
  });

  it('空值不炸，且不算示例', () => {
    expect(isDemoTaskNo('')).toBe(false);
    expect(isDemoTaskNo(null)).toBe(false);
    expect(isDemoTaskNo(undefined)).toBe(false);
  });
});

describe('isDemoTaskNo —— 真实编号绝不能误判', () => {
  it('常规编号不算示例', () => {
    expect(isDemoTaskNo('QZ-0001')).toBe(false);
    expect(isDemoTaskNo('QZ-20260918-0001')).toBe(false);
  });

  it('前缀必须完整匹配（QZ-DEMO 少了结尾的连字符不算）', () => {
    // 这是最容易写错的一格：用 startsWith('QZ-DEMO') 会把 QZ-DEMOFOO 也判成示例
    expect(isDemoTaskNo('QZ-DEMO')).toBe(false);
    expect(isDemoTaskNo('QZ-DEMOFOO-0001')).toBe(false);
  });

  it('中间含 DEMO 但前缀不是，不算示例', () => {
    expect(isDemoTaskNo('QZ-2026-DEMO-0001')).toBe(false);
  });

  it('前缀常量本身与判定一致（防止改了一边忘了另一边）', () => {
    expect(isDemoTaskNo(`${DEMO_TASK_NO_PREFIX}0001`)).toBe(true);
  });
});
