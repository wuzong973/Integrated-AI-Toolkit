/**
 * 把日程写进手机系统日历（纯函数，页面负责调 wx API）
 *
 * ## 为什么不用 `ics` 包
 *
 * 生成 `.ics` 文件在小程序里**没有出口**：`wx.openDocument` 不支持 `.ics`，
 * 只能走"复制文本"或"转发文件"，用户还得自己找 App 导入 —— 体验远不如原生。
 * 而微信自己就有 `wx.addPhoneCalendar`（基础库 2.15.0+）：直接写系统日历、
 * 一次调用、零依赖。
 *
 * 引 `ics` 的代价反而是实打实的：要改 `project.config.json` 的
 * `packNpmRelationList`（当前是空的）、占主包体积、还要登记 License 台账。
 * **能跑通的功能不需要多一个依赖。**
 *
 * ## ⚠️ 时间戳单位：官方文档没写，这里只能选一个（选毫秒）
 *
 * 微信官方文档（中文版与英文版都一样）对 `startTime` 只写了一句 "unix 时间戳"，
 * **没有说明是秒还是毫秒**；而 `endTime` 的类型列官方写成了 `string`，
 * 与"时间戳"自相矛盾（`miniprogram-api-typings` 照抄了这个笔误）。
 *
 * 这里取 **毫秒**（13 位），依据两条：
 *   · 社区实践（多处完整示例）用毫秒，并专门在"注意事项"里强调过；
 *   · 与 `Date.now()` / `new Date().getTime()` 一致，是小程序生态的惯例。
 *
 * **这不是"猜完就算了"**：这个错**不静默** —— 事件会立刻出现在系统日历里，
 * 日期对不对用户一眼就能看见。若真机上发现日期跑到 1970 年或几万年后，
 * 把下面 `TIMESTAMP_DIVISOR` 改成 `1000` 即可，**这是唯一需要改的地方**。
 *
 * ## 为什么用本地时区构造，而不是 UTC
 *
 * `DateParts` 里的 `2026-12-19` 是**用户眼里的日历日**。
 * 若用 `Date.UTC` 构造，在东八区会得到本地 08:00 —— 全天事件会被系统日历
 * 落到**前一天**，跨时区时更乱。所以这里一律用 `new Date(y, m-1, d)` 本地构造。
 *
 * ## 为什么不传 `endTime`
 *
 * 文档写明"默认与开始时间相同"，而它的类型声明本身有歧义（见上）。
 * 全天事件只需要 `startTime` —— **能少传一个有歧义的参数就少传**。
 */
import { formatDate, type DateParts } from './date-parts';

/**
 * 时间戳换算系数：本地毫秒时间戳 ÷ 该系数 = 交给系统日历的值。
 *   `1`    → 毫秒（当前采用，依据见文件头）
 *   `1000` → 秒（**若真机上日期不对，改成这个**）
 */
const TIMESTAMP_DIVISOR = 1;

/** 提醒提前量（秒）：提前一天提醒，比"当天 0 点提醒"有用得多 */
export const EXAM_ALARM_OFFSET_SEC = 86_400;

/** 交给 `wx.addPhoneCalendar` 的事件参数 */
export interface CalendarEvent {
  title: string;
  /** 本地日历日 00:00 的 unix 时间戳（毫秒，见文件头） */
  startTime: number;
  allDay: boolean;
  alarm: boolean;
  /** 提前多少秒提醒 */
  alarmOffset: number;
  description: string;
}

/** 一个日程的最简形状（鸭子类型：不 import `countdown.ts` 的 `Exam`，避免耦合） */
export interface CalendarSource {
  name: string;
  date: DateParts;
}

/** 本地日历日 00:00 的 unix 时间戳（单位见文件头） */
export function dayStartMs(day: DateParts): number {
  const local = new Date(day.y, day.m - 1, day.d, 0, 0, 0, 0).getTime();
  return Math.floor(local / TIMESTAMP_DIVISOR);
}

/**
 * 把一场考试转成系统日历事件。
 *
 * 名称留空时兜底成「考试」：系统日历里一个空标题的事件等于没加，
 * 用户回看时完全认不出它是什么。
 */
export function toExamCalendarEvent(exam: CalendarSource): CalendarEvent {
  const title = String(exam.name ?? '').trim() || '考试';
  return {
    title,
    startTime: dayStartMs(exam.date),
    allDay: true,
    alarm: true,
    alarmOffset: EXAM_ALARM_OFFSET_SEC,
    description: `${formatDate(exam.date)} · 来自青智校园「考试倒计时」`,
  };
}
