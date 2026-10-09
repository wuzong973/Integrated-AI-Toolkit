/**
 * 日期差计算（纯函数，不依赖 wx API）
 *
 * ## 为什么在小程序侧自己写，而不是 `packages/core`
 *
 * 小程序**不能 `import '@qz/core'`**（开发者工具解析不到，`project.config.json` 的
 * `packNpmRelationList` 是空的，同 `utils/gpa.ts` 文件头那条约束）。
 * 但**日历日原语绝不另造一套**：`daysBetween` / `addDays` / `formatDate` /
 * `isValidDate` / `mondayOf` 一律用 `utils/date-parts.ts`。
 * 这里只放"日期差"这一件事的**口径与人话文案** —— 两份 `new Date(...)` 实现必然漂移，
 * 而漂移的表现是"某一行差一天"，没有任何报错。
 *
 * ## 与"工作日 / 节假日"无关（这是刻意的边界）
 *
 * 只数**日历天数**：不含法定节假日、不含调休、不含寒暑假。
 * "还有几个工作日"需要一份权威的当年放假安排，那是每年由官方发布的，
 * 本地算不出来，凭印象编出来的一定是错的（红线 8：不假装知道）。
 * 页面上把这行边界写明，不让用户以为结果里已经扣过假。
 *
 * ## 脏输入一律返回 null / 空串，不抛错
 *
 * 页面把它当"没填完"处理（显示引导空态），而不是弹错误提示 ——
 * 边选边算的中间态是常态，中间态报错会让人以为工具坏了。
 */
import {
  addDays,
  daysBetween,
  formatDate,
  isValidDate,
  mondayOf,
  type DateParts,
} from './date-parts';

/** 一周七天的标签，**周一在前**（中国习惯，详见 `weekdayLabel`） */
const WEEKDAY_LABELS: readonly string[] = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/**
 * 间隔方向：`future` = 目标日在起始日之后（"还有 N 天"），
 * `past` = 目标日在起始日之前（"已经过去 N 天"），`same` = 同一天。
 */
export type DiffDirection = 'future' | 'past' | 'same';

export interface DiffSummary {
  /** **绝对**天数差（同一天为 0）；方向由 `direction` 表达，不在这里带符号 */
  days: number;
  /** `days` 拆出的整周数 */
  weeks: number;
  /** 整周之外的余数（0~6） */
  restDays: number;
  direction: DiffDirection;
  /** 起始日是周几（已算好的中文，界面直接显示） */
  fromWeekday: string;
  /** 目标日是周几 */
  toWeekday: string;
}

/** 推算结果：`date` 是 `YYYY-MM-DD`（`formatDate` 出来的，能直接渲染） */
export interface AddedDay {
  date: string;
  weekday: string;
}

/**
 * 某个日期是周几，返回"周一"…"周日"。
 *
 * ⚠️ **口径必须写清楚，否则以后一定有人改错**：
 *   中国习惯把**周一**排在一周的第一位，而 `Date.getDay()` / `getUTCDay()`
 *   把**周日**当成第一天（返回值 0 = 周日）。两张表直接换用会让**周六、周日整体错位**
 *   —— 而且不报错，界面上只是"看起来对"。
 *   本仓库的 `mondayOf()` 已经是周一口径（课表按它排周次），
 *   所以这里刻意用 `daysBetween(mondayOf(x), x)` 取"距本周周一几天"（恒 0~6），
 *   让"一周之始"在全仓库只有 `date-parts.ts` 这一个定义点。
 *
 * 非法日期（如 2026-02-30）返回空串而不是抛错。
 */
export function weekdayLabel(parts: DateParts): string {
  if (!isValidDate(parts)) return '';
  return WEEKDAY_LABELS[daysBetween(mondayOf(parts), parts)] ?? '';
}

/**
 * 两个日期的间隔（绝对天数 + 整周拆分 + 方向 + 两端各是周几）。
 * 任一非法（含 `null`，即用户还没选）返回 `null`。
 */
export function diffSummary(
  from: DateParts | null,
  to: DateParts | null,
): DiffSummary | null {
  if (!from || !to || !isValidDate(from) || !isValidDate(to)) return null;
  const signed = daysBetween(from, to);
  const days = Math.abs(signed);
  return {
    days,
    weeks: Math.floor(days / 7),
    restDays: days % 7,
    direction: signed > 0 ? 'future' : signed < 0 ? 'past' : 'same',
    fromWeekday: weekdayLabel(from),
    toWeekday: weekdayLabel(to),
  };
}

/**
 * 结果卡上的"多少个星期"这一行。
 *
 * `不足一周` 单独说：`0 周 3 天` 是机器话，`3 天，不足一周` 才是人话。
 * 整除时也不说 `4 周 0 天`，而说 `4 周整`。
 */
export function spanLabel(summary: DiffSummary): string {
  if (summary.days === 0) return '就是这一天';
  if (summary.days < 7) return `${summary.days} 天，不足一周`;
  return summary.restDays === 0
    ? `${summary.weeks} 周整`
    : `${summary.weeks} 周 ${summary.restDays} 天`;
}

/** 完整句里用的括号补充（与 `spanLabel` 分工不同：这里前面已经写了"202 天"，不重复天数） */
function weekParen(summary: DiffSummary): string {
  if (summary.days < 7) return '';
  return summary.restDays === 0
    ? `（${summary.weeks} 周整）`
    : `（${summary.weeks} 周 ${summary.restDays} 天）`;
}

/**
 * 从 `parts` 往后（`n` 为负则往前）推 `n` 天，给出目标日与它星期几。
 *
 * 越界（结果落在 `date-parts` 认可的 1970~2999 之外）或非有限 `n` 返回 `null`，
 * 而不是把 `NaN` 拼成 `NaN-NaN-NaN` 显示给用户。
 */
export function addDaysLabel(parts: DateParts | null, n: number): AddedDay | null {
  if (!parts || !isValidDate(parts) || !Number.isFinite(n)) return null;
  const target = addDays(parts, Math.round(n));
  if (!isValidDate(target)) return null;
  return { date: formatDate(target), weekday: weekdayLabel(target) };
}

/**
 * 一句话人话：`2026-06-01 到 2026-12-20 还有 202 天（28 周 6 天），
 * 起始日是周一，目标日是周日`。
 *
 * 任一日期非法或未选返回空串（页面据此显示引导空态）。
 */
export function dateRangeHint(from: DateParts | null, to: DateParts | null): string {
  const summary = diffSummary(from, to);
  if (!summary || !from || !to) return '';

  const a = formatDate(from);
  const b = formatDate(to);
  if (summary.direction === 'same') {
    return `${a} 与 ${b} 是同一天（${summary.fromWeekday}）`;
  }
  const walk = summary.direction === 'future' ? '还有' : '已经过去';
  return (
    `${a} 到 ${b} ${walk} ${summary.days} 天${weekParen(summary)}，` +
    `起始日是${summary.fromWeekday}，目标日是${summary.toWeekday}`
  );
}
