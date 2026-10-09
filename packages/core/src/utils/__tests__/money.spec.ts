import { describe, expect, it } from 'vitest';

import {
  calcPlatformFee,
  calcProviderIncome,
  centsToYuan,
  formatCents,
  isValidCents,
  yuanToCents,
} from '../money';

describe('金额工具（单位：分）', () => {
  it('元转分', () => {
    expect(yuanToCents(199)).toBe(19900);
    expect(yuanToCents('199.99')).toBe(19999);
    expect(yuanToCents(0.1)).toBe(10);
  });

  it('分转元', () => {
    expect(centsToYuan(19900)).toBe('199.00');
    expect(centsToYuan(10)).toBe('0.10');
  });

  it('格式化', () => {
    expect(formatCents(19900)).toBe('¥199.00');
    expect(formatCents(19900, { dropZero: true })).toBe('¥199');
    expect(formatCents(19900, { withSymbol: false })).toBe('199.00');
  });

  it('合法性校验', () => {
    expect(isValidCents(0)).toBe(true);
    expect(isValidCents(19900)).toBe(true);
    expect(isValidCents(-1)).toBe(false);
    expect(isValidCents(1.5)).toBe(false);
  });

  it('平台服务费：5% 且封顶 20 元', () => {
    expect(calcPlatformFee(10000)).toBe(500); // ¥100 → ¥5
    expect(calcPlatformFee(100000)).toBe(2000); // ¥1000 → 封顶 ¥20
    expect(calcPlatformFee(1000)).toBe(50); // ¥10 → ¥0.5
  });

  it('服务者收入 = 订单金额 - 平台服务费', () => {
    expect(calcProviderIncome(10000)).toBe(9500);
    expect(calcProviderIncome(100000)).toBe(98000);
  });
});
