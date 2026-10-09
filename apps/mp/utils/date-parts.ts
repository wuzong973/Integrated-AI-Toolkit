/**
 * 日历日原语（纯函数，不依赖 wx API）
 *
 * ## 为什么单独成文件
 *
 * 倒计时与课程表都要做"日期差 / 周次 / 补零格式化"，而且都要**避开两个坑**：
 *   ① `(t2 - t1) / 86400000` 在夏令时切换日会得到 0.958… 天，取整后差一天；
 *   ② 用户眼里的"今天"是**本地**日历日，不是 UTC 的今天。
 * 把这两件事收敛到一处，比在每个页面各写一遍 `new Date(...)` 靠谱得多。
 *
 * ## 口径约定
 *
 * · `m` 是 **1~12**（`Date` 是 0~11，这里统一成人话口径，只在构造时 `-1`）；
 * · 天数差一律把两端归一到 **UTC 零点** 再相减，跨时区 / 夏令时都稳定；
 * · `mondayOf` 以**周一为一周之始**（中国课表口径）。
 */

/** 日历日（`m` 是 1~12） */
export interface DateParts {
  y: number;
  m: number;
  d: number;
}

const DAY_MS = 86_400_000;

/** 整数且落在 `[lo, hi]` 内 */
const isIntIn = (n: unknown, lo: number, hi: number): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi;

/** 用 UTC 构造再回读，能自动挡掉"2 月 30 日"（会被规范化成 3 月 2 日） */
function isPlainDay(y: number, m: number, d: number): boolean {
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** 校验一个日期是不是真实存在的日历日（挡掉 2 月 30 日这类） */
export function isValidDate(v: unknown): v is DateParts {
  if (!v || typeof v !== 'object') return false;
  const { y, m, d } = v as DateParts;
  if (!isIntIn(y, 1970, 2999) || !isIntIn(m, 1, 12) || !isIntIn(d, 1, 31)) return false;
  return isPlainDay(y, m, d);
}

/** 取"用户本地的今天"（不是 UTC 的今天） */
export function todayParts(now: Date = new Date()): DateParts {
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
}

/** 天数差：`b - a`，正值表示 `b` 在未来 */
export function daysBetween(a: DateParts, b: DateParts): number {
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);
}

/** 加（减）天数，自动跨月跨年 */
export function addDays(a: DateParts, n: number): DateParts {
  return todayParts(new Date(a.y, a.m - 1, a.d + n));
}

/** `2026-09-20` 形式（补零，方便排序与比对） */
export function formatDate(v: DateParts): string {
  return `${v.y}-${String(v.m).padStart(2, '0')}-${String(v.d).padStart(2, '0')}`;
}

/** 解析 `2026-09-20`；非法返回 null（不返回"默认今天"这种会误导的值） */
export function parseDate(text: string): DateParts | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const v: DateParts = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  return isValidDate(v) ? v : null;
}

/**
 * 该日期所在周的**周一**（周一为一周之始）。
 *
 * `getUTCDay()` 里 0 是周日，所以 `(wd + 6) % 7` 才是"距周一几天"。
 * 直接用 `wd` 会让周日算成下一周的起点 —— 课表里正好错一周。
 */
export function mondayOf(a: DateParts): DateParts {
  const wd = new Date(Date.UTC(a.y, a.m - 1, a.d)).getUTCDay();
  return addDays(a, -((wd + 6) % 7));
}
