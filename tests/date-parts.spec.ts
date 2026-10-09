/**
 * 日历日原语单测
 *
 * 重点钉住三件事：
 *   ① **跨夏令时/跨时区的天数差** —— 毫秒直除会在切换日差一天，且只在特定日期暴露；
 *   ② **非法日期必须被挡住**（2 月 30 日、13 月、`2026-2-31`）；
 *   ③ **周一是"距周一几天"的锚点** —— 用 `getUTCDay()` 直接减会让周日算到下一周。
 */
import { describe, expect, it } from 'vitest';

import {
  addDays,
  daysBetween,
  formatDate,
  isValidDate,
  mondayOf,
  parseDate,
  todayParts,
  type DateParts,
} from '../apps/mp/utils/date-parts';

const D = (y: number, m: number, d: number): DateParts => ({ y, m, d });

describe('daysBetween', () => {
  it('同一天为 0，跨月跨年正确', () => {
    expect(daysBetween(D(2026, 9, 20), D(2026, 9, 20))).toBe(0);
    expect(daysBetween(D(2026, 9, 20), D(2026, 9, 21))).toBe(1);
    expect(daysBetween(D(2026, 9, 20), D(2026, 10, 1))).toBe(11);
    expect(daysBetween(D(2026, 12, 31), D(2027, 1, 1))).toBe(1);
    expect(daysBetween(D(2026, 1, 1), D(2027, 1, 1))).toBe(365);
    expect(daysBetween(D(2024, 1, 1), D(2025, 1, 1))).toBe(366); // 闰年
  });

  it('反向为负，且绝对值与正向一致', () => {
    expect(daysBetween(D(2026, 9, 21), D(2026, 9, 20))).toBe(-1);
    const a = D(2026, 3, 1);
    const b = D(2026, 11, 7);
    expect(daysBetween(b, a)).toBe(-daysBetween(a, b));
  });

  it('⭐ 跨夏令时切换日仍是一整天（毫秒直除会算出 0.958 天）', () => {
    // 美国 2026 夏令时：3/8 开始、11/1 结束。取切换日两侧各一天。
    expect(daysBetween(D(2026, 3, 7), D(2026, 3, 8))).toBe(1);
    expect(daysBetween(D(2026, 3, 8), D(2026, 3, 9))).toBe(1);
    expect(daysBetween(D(2026, 10, 31), D(2026, 11, 1))).toBe(1);
    expect(daysBetween(D(2026, 11, 1), D(2026, 11, 2))).toBe(1);
  });
});

describe('isValidDate', () => {
  it('接受真实存在的日期', () => {
    expect(isValidDate(D(2026, 2, 28))).toBe(true);
    expect(isValidDate(D(2024, 2, 29))).toBe(true);
    expect(isValidDate(D(2026, 12, 31))).toBe(true);
  });

  it('挡住不存在的日期与越界月份', () => {
    expect(isValidDate(D(2026, 2, 29))).toBe(false); // 2026 不是闰年
    expect(isValidDate(D(2026, 2, 30))).toBe(false);
    expect(isValidDate(D(2026, 4, 31))).toBe(false);
    expect(isValidDate(D(2026, 13, 1))).toBe(false);
    expect(isValidDate(D(2026, 0, 10))).toBe(false);
    expect(isValidDate(D(2026, 9, 0))).toBe(false);
  });

  it('挡住非整数与非对象', () => {
    expect(isValidDate({ y: 2026, m: 9, d: 20.5 })).toBe(false);
    expect(isValidDate({ y: '2026', m: 9, d: 20 })).toBe(false);
    expect(isValidDate(null)).toBe(false);
    expect(isValidDate('2026-09-20')).toBe(false);
  });
});

describe('parseDate / formatDate', () => {
  it('接受宽松写法，输出补零格式', () => {
    expect(parseDate('2026-9-2')).toEqual(D(2026, 9, 2));
    expect(formatDate(parseDate('2026-9-2')!)).toBe('2026-09-02');
  });

  it('非法输入返回 null（而不是"默认今天"这种会误导的值）', () => {
    for (const bad of ['', '2026/09/20', '2026-2-30', '26-09-20', 'abc']) {
      expect(parseDate(bad), `「${bad}」应当返回 null`).toBeNull();
    }
  });
});

describe('addDays', () => {
  it('跨月跨年自动进位', () => {
    expect(addDays(D(2026, 9, 30), 1)).toEqual(D(2026, 10, 1));
    expect(addDays(D(2026, 12, 31), 1)).toEqual(D(2027, 1, 1));
    expect(addDays(D(2027, 1, 1), -1)).toEqual(D(2026, 12, 31));
    expect(addDays(D(2024, 2, 28), 1)).toEqual(D(2024, 2, 29));
  });
});

describe('mondayOf', () => {
  it('周一到周日都归到同一个周一', () => {
    // 2026-09-21 是周一
    expect(mondayOf(D(2026, 9, 21))).toEqual(D(2026, 9, 21));
    expect(mondayOf(D(2026, 9, 23))).toEqual(D(2026, 9, 21));
    expect(mondayOf(D(2026, 9, 27))).toEqual(D(2026, 9, 21)); // 周日
  });

  it('⭐ 周日不能算成下一周的起点（差一周的经典错法）', () => {
    // 2026-09-20 是周日，它属于 09-14 那一周
    expect(mondayOf(D(2026, 9, 20))).toEqual(D(2026, 9, 14));
    expect(daysBetween(mondayOf(D(2026, 9, 20)), D(2026, 9, 20))).toBe(6);
  });
});

describe('todayParts', () => {
  it('取的是本地日历日，不是 UTC 日', () => {
    // 本地时间 2026-09-20 23:30 —— UTC 下可能已经是 21 号
    const local = new Date(2026, 8, 20, 23, 30, 0);
    expect(todayParts(local)).toEqual(D(2026, 9, 20));
  });
});
