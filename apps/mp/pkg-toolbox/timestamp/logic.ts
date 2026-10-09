/**
 * 时间戳转换（纯函数，不依赖 wx API）
 *
 * 口径：
 *   · 时间戳支持**秒**（10 位）与**毫秒**（13 位）两种口径，界面用 chip 切换；
 *   · 日期时间的"今天"与解析都用**本地时区** —— 用户眼中的"现在"就是本地时间，
 *     用 UTC 会在界面上差出一个时区小时数（课程表 / 倒计时同一条经验）；
 *   · 脏输入一律返回 null，不抛错：页面把它当"还没填完"处理（边打字边算的中间态是常态）。
 */

/** 时间戳口径 */
export type TsUnit = 's' | 'ms';

/** 毫秒 → 指定口径的整数时间戳（秒口径向下取整） */
export function toUnitStamp(ms: number, unit: TsUnit): number {
  return unit === 's' ? Math.floor(ms / 1000) : Math.round(ms);
}

/** 用户输入的时间戳 → 毫秒；空 / 非数字 / 超出 Date 范围返回 null */
export function parseStamp(text: string, unit: TsUnit): number | null {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  const ms = unit === 's' ? n * 1000 : n;
  return Number.isNaN(new Date(ms).getTime()) ? null : ms;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const p2 = (n: number): string => String(n).padStart(2, '0');

/**
 * 毫秒 → `2026-10-08 14:30:05 周四`（本地时区，带星期几）。
 * 入参已由 `parseStamp` 保证可构造成 Date，这里只做展示。
 */
export function formatStamp(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` +
    ` ${WEEKDAYS[d.getDay()]}`
  );
}

/** 日期时间字段（m 是 1~12 的人话口径） */
export interface DateTimeFields {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
}

/**
 * 日期时间字段 → 指定口径的时间戳；构造发生进位（如 2 月 30 日）返回 null。
 *
 * ⚠️ `new Date(y, m-1, d, …)` 对非法日期会**静默滚动**到下个月，
 * 只比较 y/m/d 是否原样回来才能挡掉它 —— 和 utils/date-parts.ts 同一条经验。
 */
export function fieldsToStamp(f: DateTimeFields, unit: TsUnit): number | null {
  const d = new Date(f.y, f.m - 1, f.d, f.hh, f.mm);
  const rolled =
    d.getFullYear() !== f.y || d.getMonth() !== f.m - 1 || d.getDate() !== f.d;
  return rolled ? null : toUnitStamp(d.getTime(), unit);
}
