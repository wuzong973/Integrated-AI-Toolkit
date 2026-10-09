import { describe, expect, it } from 'vitest';

import { bizNo, formatUuidV4, idempotencyKey, orderNo, taskNo, uuid } from '../id';

describe('ID 工具', () => {
  it('uuid 唯一且格式正确', () => {
    const a = uuid();
    const b = uuid();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('idempotencyKey 与 uuid 同源（幂等键必须是强随机）', () => {
    expect(idempotencyKey()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('业务单号带前缀与时间戳', () => {
    const at = new Date(2026, 8, 17, 10, 30, 25);
    const no = bizNo('QZ', at);
    expect(no.startsWith('QZ20260917103025')).toBe(true);
    expect(no).toHaveLength(22);
  });

  it('订单号 / 任务号前缀不同', () => {
    const at = new Date(2026, 8, 17, 10, 30, 25);
    expect(orderNo(at).startsWith('QZ')).toBe(true);
    expect(taskNo(at).startsWith('QT')).toBe(true);
  });

  // 这条分支只在非安全上下文（http 非 localhost）的浏览器里走到，
  // 刚好是最不容易被发现、又最容易被写错的那个 —— 版本位/变体位是硬约束。
  describe('formatUuidV4（getRandomValues 降级路径）', () => {
    it('无论输入字节如何，版本位恒为 4、变体位恒为 10xx', () => {
      expect(formatUuidV4(new Uint8Array(16))).toBe('00000000-0000-4000-8000-000000000000');
      expect(formatUuidV4(new Uint8Array(16).fill(0xff))).toBe(
        'ffffffff-ffff-4fff-bfff-ffffffffffff',
      );
    });

    it('随机字节产出合法 UUID 文本', () => {
      const out = formatUuidV4(globalThis.crypto.getRandomValues(new Uint8Array(16)));
      expect(out).toHaveLength(36);
      expect(out).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });
});
