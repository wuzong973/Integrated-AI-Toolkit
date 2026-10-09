/**
 * 课程表（纯函数，不依赖 wx API）
 *
 * ## 为什么用「节次」而不是时钟时间
 *
 * 各校作息差异极大（第一节 8:00 / 8:30 / 7:50 都有）。写死一套时间表等于**编造作息**：
 * 学生照着它去上课，迟到了是它的错。所以网格按 **节次** 排布
 * （"周一 3-4 节有课"本来就是学生自己的说法），不出现任何时钟时间。
 * 也因此**不做上课提醒** —— 没有可信的时间点，提醒只会提醒错。
 *
 * ## 为什么用百分比定位而不是表格
 *
 * 微信的 WXML 没有 `rowspan`。用 `top/height` 百分比 + 绝对定位，
 * 让"跨 2 节的课"自然占两格高度，且格子高度由 SCSS 一处控制（改一处全对齐）。
 *
 * ## 存储反序列化必须当成不可信输入
 *
 * 同倒计时：`wx.getStorageSync` 拿到的是历史版本写下的东西。
 * `parseTimetable` 逐条校验、**坏的直接丢**，让页面永远能打开。
 */
import { daysBetween, isValidDate, type DateParts } from './date-parts';

/** 每天排多少节（各校 8~12 节不等，取最常见的 8 节） */
export const PERIOD_COUNT = 8;

export const PERIOD_LABELS: readonly string[] = Array.from(
  { length: PERIOD_COUNT },
  (_, i) => `第 ${i + 1} 节`,
);

export const WEEKDAY_LABELS: readonly string[] = ['一', '二', '三', '四', '五', '六', '日'];

/** 单双周 */
export type Parity = 'all' | 'odd' | 'even';

export const PARITY_LABELS: Record<Parity, string> = {
  all: '每周',
  odd: '单周',
  even: '双周',
};

export interface Course {
  id: string;
  name: string;
  teacher: string;
  location: string;
  /** 1 = 周一 … 7 = 周日 */
  weekday: number;
  /** 起始节次，1..PERIOD_COUNT */
  start: number;
  /** 结束节次，>= start */
  end: number;
  fromWeek: number;
  toWeek: number;
  parity: Parity;
}

/** 网格里的一块（`top` / `height` 是百分比，格子高度由 SCSS 决定） */
export interface CourseBlock {
  id: string;
  name: string;
  teacher: string;
  location: string;
  periodText: string;
  top: number;
  height: number;
}

export interface DayColumn {
  weekday: number;
  label: string;
  blocks: CourseBlock[];
}

export interface TimetableState {
  /** 学期第一周的周一；未设置时为 null（此时无法判断"第几周"） */
  termStart: DateParts | null;
  courses: Course[];
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

const isIntIn = (n: unknown, lo: number, hi: number): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi;

const MAX_WEEK = 30;
const PARITIES: readonly Parity[] = ['all', 'odd', 'even'];

/** 节次文案：单节说"第 3 节"，跨节说"3-4 节" */
export function periodText(start: number, end: number): string {
  return start === end ? `第 ${start} 节` : `${start}-${end} 节`;
}

/** 这门课在第 `week` 周上不上 */
export function isActiveInWeek(c: Course, week: number): boolean {
  if (week < c.fromWeek || week > c.toWeek) return false;
  if (c.parity === 'all') return true;
  return c.parity === 'odd' ? week % 2 === 1 : week % 2 === 0;
}

/**
 * 今天是学期第几周（`termStart` 应是第一周的周一）。
 *
 * 学期开始前会返回 **0 或负数** —— 这是有意的：界面据此显示"学期还没开始"，
 * 比强行夹到第 1 周更诚实（夹了会显示一份"第 1 周课表"，看起来像真的）。
 */
export function weekOfTerm(termStart: DateParts, today: DateParts): number {
  // 复用 date-parts 的天数差（已处理夏令时 / 时区），不要在这里再写一遍毫秒除法
  return Math.floor(daysBetween(termStart, today) / 7) + 1;
}

/** 第 `week` 周要上的课 */
export function coursesOfWeek(courses: readonly Course[], week: number): Course[] {
  return courses.filter((c) => isActiveInWeek(c, week));
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/**
 * 生成一周的网格数据。
 *
 * 同一格里有多门课时按起始节次排序 —— 顺序不稳定会让每次重算的叠放次序都变，
 * 用户会以为课表在跳。
 */
export function layoutOf(courses: readonly Course[], week: number): DayColumn[] {
  const active = coursesOfWeek(courses, week);
  return WEEKDAY_LABELS.map((label, i) => {
    const weekday = i + 1;
    const blocks = active
      .filter((c) => c.weekday === weekday)
      .sort((a, b) => a.start - b.start || a.end - b.end || a.name.localeCompare(b.name))
      .map((c) => ({
        id: c.id,
        name: c.name,
        teacher: c.teacher,
        location: c.location,
        periodText: periodText(c.start, c.end),
        top: round4(((c.start - 1) / PERIOD_COUNT) * 100),
        height: round4(((c.end - c.start + 1) / PERIOD_COUNT) * 100),
      }));
    return { weekday, label, blocks };
  });
}

/**
 * 节次 / 周次 / 星期 / 大小关系的整体校验。
 *
 * 拆成一个函数是为了把复杂度压到红线以内（≤10），
 * 顺带让"到底校了哪几件事"一眼可数。
 */
function hasValidRanges(c: Course): boolean {
  const periodsOk = isIntIn(c.start, 1, PERIOD_COUNT) && isIntIn(c.end, 1, PERIOD_COUNT);
  const weeksOk = isIntIn(c.fromWeek, 1, MAX_WEEK) && isIntIn(c.toWeek, 1, MAX_WEEK);
  const orderOk = c.end >= c.start && c.toWeek >= c.fromWeek;
  return isIntIn(c.weekday, 1, 7) && periodsOk && weeksOk && orderOk;
}

/** 单门课的形状校验：不合规返回 null */
function toCourse(item: unknown): Course | null {
  if (!item || typeof item !== 'object') return null;
  const c = item as Course;
  if (!isText(c.id) || !isText(c.name)) return null;
  if (!hasValidRanges(c)) return null;
  if (!PARITIES.includes(c.parity)) return null;
  return {
    id: c.id,
    name: c.name.trim(),
    teacher: typeof c.teacher === 'string' ? c.teacher.trim() : '',
    location: typeof c.location === 'string' ? c.location.trim() : '',
    weekday: c.weekday,
    start: c.start,
    end: c.end,
    fromWeek: c.fromWeek,
    toWeek: c.toWeek,
    parity: c.parity,
  };
}

/** 反序列化课程列表（坏条目直接丢，重复 id 只留第一条） */
export function parseCourses(raw: unknown): Course[] {
  if (!Array.isArray(raw)) return [];
  const out: Course[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const c = toCourse(item);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/** 反序列化整份课程表状态 */
export function parseTimetable(raw: unknown): TimetableState {
  const empty: TimetableState = { termStart: null, courses: [] };
  if (!raw || typeof raw !== 'object') return empty;
  const { termStart, courses } = raw as TimetableState;
  return {
    termStart: isValidDate(termStart) ? termStart : null,
    courses: parseCourses(courses),
  };
}
