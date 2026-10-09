/**
 * 展示格式化。全部对**缺失值**友好：后端字段可能为 null / 空串 / 非法日期，
 * 格式化函数一律返回 `—` 而不是 `null` / `Invalid Date` 这类会被渲染成
 * "看起来像 bug"的字符串。
 */

/** 缺失值统一占位符（全站一致，便于一眼区分"没有"和"解析失败"） */
export const EMPTY = '—';

/** 分 → 元（金额**全链路用分**，只有展示这一层转元） */
export function formatMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return EMPTY;
  const yuan = cents / 100;
  // 整数不显示 .00（看板上"¥1200"比"¥1200.00"更好读）
  return `¥${Number.isInteger(yuan) ? yuan.toLocaleString('zh-CN') : yuan.toFixed(2)}`;
}

/** 本地时间 `YYYY-MM-DD HH:mm` */
export function formatDateTime(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return EMPTY;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 仅日期 */
export function formatDate(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return EMPTY;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 相对时间（列表里"3 分钟前"比绝对时间更容易判断新鲜度） */
export function formatRelative(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return EMPTY;
  const diff = Date.now() - d.getTime();
  if (diff < 0) return formatDateTime(iso);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatDate(iso);
}

/** 耗时（毫秒 → `1分20秒`），用于 Job 的"跑了多久" */
export function formatDuration(startIso: string | null, endIso: string | null): string {
  const a = parseDate(startIso);
  const b = parseDate(endIso);
  if (!a || !b) return EMPTY;
  const ms = b.getTime() - a.getTime();
  if (ms < 0) return EMPTY;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  if (min < 60) return rest ? `${min} 分 ${rest} 秒` : `${min} 分`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}

/** 长 ID / 长 JSON 的展示截断（保留首尾，便于肉眼比对） */
export function shorten(value: string | null | undefined, head = 8, tail = 4): string {
  if (!value) return EMPTY;
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** JSON 美化（`before` / `after` / `params` 展示用） */
export function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return EMPTY;
  try {
    const text = JSON.stringify(value, null, 2);
    return text === '{}' || text === '[]' || text === 'null' ? EMPTY : text;
  } catch {
    return String(value);
  }
}

function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
