/** 时间工具（文档 9.1：对外一律 ISO8601） */

export const MS = {
  second: 1000,
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
} as const;

/** 当前时间（便于测试注入） */
export function now(): Date {
  return new Date();
}

/** 格式化为 ISO8601（本地时区 +08:00 风格由后端统一处理，这里输出标准 ISO） */
export function toIso(d: Date | number | string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) throw new Error(`非法时间：${String(d)}`);
  return date.toISOString();
}

/** 加减时间 */
export function addMs(base: Date | number, ms: number): Date {
  const t = base instanceof Date ? base.getTime() : base;
  return new Date(t + ms);
}

export function addMinutes(base: Date | number, m: number): Date {
  return addMs(base, m * MS.minute);
}

export function addDays(base: Date | number, d: number): Date {
  return addMs(base, d * MS.day);
}

/* ==================== 业务日（记单词的到期与打卡） ==================== */

/**
 * 业务时区固定为 **东八区**。
 *
 * ## 为什么写死而不是用服务器本地时区
 *
 * "今天该复习哪些词"、"今天打卡了没有"都是**按日**判定的。如果按服务器本地时区算，
 * 同一份数据在开发机（+08）与线上容器（默认 UTC）会算出**不同的日期** ——
 * 表现是"本地好好的、上线后复习计划整体错一天"，而且两边日志都正常，极难定位。
 *
 * 用户全在国内校园，固定 +08:00 是明确且可控的约定；将来真要支持跨时区，
 * 也是把用户时区存下来按用户算，而不是退回"跟随服务器"。
 */
export const BIZ_TZ_OFFSET_MINUTES = 8 * 60;

const BIZ_TZ_MS = BIZ_TZ_OFFSET_MINUTES * 60 * 1000;

/**
 * 业务日的起点（该日 00:00 对应的时刻，UTC 基准）。
 *
 * ⚠️ 到期判定必须用它**按日取整**再比较，不能直接比时刻：
 * 晚上 21:00 学的词，`dueDate = 次日 21:00`，直接比时刻会让它**次日一整天都不出现**
 * （要等到晚上 21:00 才"到期"），用户看到的是"昨天背的词今天没进复习队列"。
 */
export function bizDayStart(at: Date | number = now()): Date {
  const t = at instanceof Date ? at.getTime() : at;
  return new Date(Math.floor((t + BIZ_TZ_MS) / MS.day) * MS.day - BIZ_TZ_MS);
}

/** 业务日的 `YYYY-MM-DD`（用于 `@db.Date` 列与打卡日历的分组键） */
export function bizDayKey(at: Date | number = now()): string {
  const t = at instanceof Date ? at.getTime() : at;
  return new Date(t + BIZ_TZ_MS).toISOString().slice(0, 10);
}

/**
 * 到期判定：`dueDate` 所在业务日 ≤ `at` 所在业务日 即算到期。
 *
 * 见 `bizDayStart` 的说明 —— 这是"当天任意时刻都算到期"，而不是"到点才到期"。
 */
export function isDueOnOrBefore(dueDate: Date | number, at: Date | number = now()): boolean {
  return bizDayStart(dueDate).getTime() <= bizDayStart(at).getTime();
}

/**
 * 业务日对应的「日期值」——写进 `@db.Date` 列（`word_study_log.day`）的那个 Date。
 *
 * ⚠️ **不能直接把 `bizDayStart()` 写进 `@db.Date` 列**：它返回的是 UTC 基准的
 * "前一天 16:00"（东八区的 00:00 折算成 UTC 就是 16:00）。Prisma 写 DATE 列时
 * 按 **UTC** 取 `YYYY-MM-DD`，于是东八区 09-20 的一天会被存成 `2026-09-19` ——
 * 打卡日历整体错位一格，而两端都不会报任何错。
 *
 * 读回来的值（Prisma 给的是当日 UTC 00:00）再用 `bizDayKey()` 折回东八区，
 * 得到的正是同一天，所以写入/读出这一对是自洽的。
 */
export function bizDayDate(at: Date | number = now()): Date {
  return new Date(`${bizDayKey(at)}T00:00:00.000Z`);
}

/** 判断是否已超时（用于订单 30min 关闭、7 天自动验收） */
export function isExpired(deadline: Date | number, at: Date | number = now()): boolean {
  const d = deadline instanceof Date ? deadline.getTime() : deadline;
  const a = at instanceof Date ? at.getTime() : at;
  return a >= d;
}

/** 人类可读的相对时间（如"3 分钟前"），用于列表展示 */
export function timeAgo(target: Date | number, at: Date | number = now()): string {
  const t = target instanceof Date ? target.getTime() : target;
  const a = at instanceof Date ? at.getTime() : at;
  const diff = Math.max(0, a - t);
  if (diff < MS.minute) return '刚刚';
  if (diff < MS.hour) return `${Math.floor(diff / MS.minute)} 分钟前`;
  if (diff < MS.day) return `${Math.floor(diff / MS.hour)} 小时前`;
  if (diff < 30 * MS.day) return `${Math.floor(diff / MS.day)} 天前`;
  return new Date(t).toISOString().slice(0, 10);
}

/** 格式化倒计时（如"02:15:30"），用于任务截止 */
export function countdown(deadline: Date | number, at: Date | number = now()): string {
  const d = deadline instanceof Date ? deadline.getTime() : deadline;
  const a = at instanceof Date ? at.getTime() : at;
  const diff = Math.max(0, d - a);
  const h = Math.floor(diff / MS.hour);
  const m = Math.floor((diff % MS.hour) / MS.minute);
  const s = Math.floor((diff % MS.minute) / MS.second);
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}
