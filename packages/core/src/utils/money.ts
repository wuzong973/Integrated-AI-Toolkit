/**
 * 金额工具（文档 9.1：金额一律用「分」的整数表示，禁止浮点）
 * 例：¥199.00 => 19900
 */

/** 校验是否为合法金额（非负整数分） */
export function isValidCents(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** 元 → 分（四舍五入到分） */
export function yuanToCents(yuan: number | string): number {
  const n = typeof yuan === 'string' ? Number(yuan) : yuan;
  if (!Number.isFinite(n)) throw new Error(`非法金额：${yuan}`);
  return Math.round(n * 100);
}

/** 分 → 元（保留两位小数的字符串，用于展示） */
export function centsToYuan(cents: number): string {
  if (!isValidCents(cents)) throw new Error(`非法金额（分）：${cents}`);
  return (cents / 100).toFixed(2);
}

/** 分 → 展示文案，如 ¥199.00 / ¥199 */
export function formatCents(
  cents: number,
  opts?: { withSymbol?: boolean; dropZero?: boolean },
): string {
  const withSymbol = opts?.withSymbol ?? true;
  const dropZero = opts?.dropZero ?? false;
  const yuan = cents / 100;
  const text = dropZero && Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2);
  return withSymbol ? `¥${text}` : text;
}

/**
 * 平台服务费计算（任务清单 M3-13：学生 5% 且封顶 20 元）
 * @param amountCents 订单金额（分）
 * @param rate 费率，默认 0.05
 * @param capCents 封顶（分），默认 2000（20 元）
 */
export function calcPlatformFee(amountCents: number, rate = 0.05, capCents = 2000): number {
  if (!isValidCents(amountCents)) throw new Error(`非法金额（分）：${amountCents}`);
  return Math.min(Math.round(amountCents * rate), capCents);
}

/** 服务者可提现金额 = 订单金额 - 平台服务费 */
export function calcProviderIncome(amountCents: number, rate = 0.05, capCents = 2000): number {
  return amountCents - calcPlatformFee(amountCents, rate, capCents);
}
