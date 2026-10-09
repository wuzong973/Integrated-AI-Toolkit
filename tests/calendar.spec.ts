/**
 * 系统日历导出单测
 *
 * 为什么值得写：
 *   这个功能的错法是**"看起来成功、日期完全不对"** ——
 *   时区用错（UTC 构造）会让全天事件落到前一天；
 *   时间戳单位用错会让事件跑到 1970 年或几万年后。
 *   两种错在代码里都毫无异样，所以这里把两条都钉死：
 *     **① 回读必须是本地当天 00:00**（防时区错）
 *     **② 结果必须是 13 位毫秒**（把"单位选择"变成可测断言）
 *
 * ⚠️ 若你因为真机表现把 `utils/calendar.ts` 的 `TIMESTAMP_DIVISOR` 改成了 1000，
 *    请同步把本文件"13 位毫秒"那条改成 10 位秒 —— 这条断言的作用就是**提醒你两处要一起改**。
 */
import { describe, expect, it } from 'vitest';

import {
  dayStartMs,
  EXAM_ALARM_OFFSET_SEC,
  toExamCalendarEvent,
  type CalendarSource,
} from '../apps/mp/utils/calendar';
import type { DateParts } from '../apps/mp/utils/date-parts';

/** 覆盖普通日 / 月初月末 / 年末年初 / 闰日 / 闰年二月 */
const CASES: DateParts[] = [
  { y: 2026, m: 12, d: 19 },
  { y: 2026, m: 1, d: 1 },
  { y: 2026, m: 12, d: 31 },
  { y: 2026, m: 2, d: 28 },
  { y: 2024, m: 2, d: 29 },
  { y: 2024, m: 3, d: 1 },
  { y: 2000, m: 1, d: 1 },
  { y: 2999, m: 12, d: 31 },
];

describe('dayStartMs', () => {
  it('⭐ 回读必须是本地当天 00:00（用 UTC 构造会让全天事件落到前一天）', () => {
    for (const day of CASES) {
      const back = new Date(dayStartMs(day));
      const label = `${day.y}-${day.m}-${day.d}`;
      expect(back.getFullYear(), label).toBe(day.y);
      expect(back.getMonth(), label).toBe(day.m - 1);
      expect(back.getDate(), label).toBe(day.d);
      expect(back.getHours(), label).toBe(0);
      expect(back.getMinutes(), label).toBe(0);
    }
  });

  it('⭐ 是毫秒级而非秒级（单位选择被钉成断言，改单位会在这里红）', () => {
    // ⚠️ 判据不能用"13 位"—— 2000-01-01 的毫秒戳是 946656000000，只有 12 位。
    //    用 1e11 分界更本质：秒级时间戳要到 5138 年才会超过它。
    for (const day of CASES) {
      expect(dayStartMs(day)).toBeGreaterThan(1e11);
    }
  });

  it('严格随时间递增（同一天内不会出现倒挂）', () => {
    const list = [...CASES].sort(
      (a, b) => Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d),
    );
    for (let i = 1; i < list.length; i += 1) {
      expect(dayStartMs(list[i])).toBeGreaterThan(dayStartMs(list[i - 1]));
    }
  });

  it('相邻两天的差值在 23~25 小时之间（容忍夏令时地区，不写死 24 小时）', () => {
    const HOUR = 3_600_000;
    const pairs: [DateParts, DateParts][] = [
      [{ y: 2026, m: 1, d: 31 }, { y: 2026, m: 2, d: 1 }],
      [{ y: 2026, m: 12, d: 31 }, { y: 2027, m: 1, d: 1 }],
      [{ y: 2024, m: 2, d: 28 }, { y: 2024, m: 2, d: 29 }],
    ];
    for (const [a, b] of pairs) {
      const diff = dayStartMs(b) - dayStartMs(a);
      expect(diff).toBeGreaterThanOrEqual(23 * HOUR);
      expect(diff).toBeLessThanOrEqual(25 * HOUR);
    }
  });

  it('返回整数，不含小数毫秒', () => {
    for (const day of CASES) expect(Number.isInteger(dayStartMs(day))).toBe(true);
  });
});

describe('toExamCalendarEvent', () => {
  const exam: CalendarSource = { name: '四六级', date: { y: 2026, m: 12, d: 19 } };

  it('全天事件：allDay 为真，startTime 落在当天 00:00', () => {
    const e = toExamCalendarEvent(exam);
    expect(e.allDay).toBe(true);
    expect(e.startTime).toBe(dayStartMs(exam.date));
  });

  it('默认开提醒，提前一天（86400 秒）', () => {
    const e = toExamCalendarEvent(exam);
    expect(e.alarm).toBe(true);
    expect(e.alarmOffset).toBe(EXAM_ALARM_OFFSET_SEC);
    expect(e.alarmOffset).toBe(86_400);
  });

  it('标题去掉首尾空白', () => {
    expect(toExamCalendarEvent({ ...exam, name: '  考研初试  ' }).title).toBe('考研初试');
  });

  it('⭐ 标题为空时兜底成「考试」，不写一个空标题进系统日历', () => {
    expect(toExamCalendarEvent({ ...exam, name: '' }).title).toBe('考试');
    expect(toExamCalendarEvent({ ...exam, name: '   ' }).title).toBe('考试');
    expect(
      toExamCalendarEvent({ ...exam, name: undefined as unknown as string }).title,
    ).toBe('考试');
  });

  it('描述里带日期与来源，方便用户在系统日历里认出它', () => {
    const e = toExamCalendarEvent(exam);
    expect(e.description).toContain('2026-12-19');
    expect(e.description).toContain('青智校园');
  });

  it('不产生 endTime（避开官方声明里的 string/number 歧义，全天事件只需 startTime）', () => {
    expect(toExamCalendarEvent(exam)).not.toHaveProperty('endTime');
  });
});
