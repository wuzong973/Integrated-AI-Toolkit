import { describe, expect, it } from 'vitest';

import {
  addDaysLabel,
  dateRangeHint,
  diffSummary,
  spanLabel,
  weekdayLabel,
} from '../apps/mp/utils/date-calc';
import { parseDate, type DateParts } from '../apps/mp/utils/date-parts';

/**
 * 日期差计算单测。
 *
 * ⚠️ 位置：小程序的测试**必须放 `tests/`**，不能放 `apps/mp/` 里 ——
 * `miniprogramRoot` 就是发布包本身，包内的 spec 文件会被开发者工具
 * 「过滤无依赖文件」点名（见 `vitest.config.ts`）。
 *
 * 重点钉住四类"错了也不报错"的事：
 *   ① **周口径**：中国把周一排第一，`Date.getDay()` 把周日排第一（返回 0）——
 *      两张表直接换用只会让周六周日整体错位，界面上看不出来；
 *   ② **闰年 2/29 与不存在的日期**（2026-02-29、2026-02-30）；
 *   ③ **跨年 / 跨月的天数差**，以及 `from > to` 时必须给绝对值而不是负数；
 *   ④ **文案里的周几**必须与真实日历一致（例子里写的"2026-12-20 是周一"其实
 *      是周日 —— 这正是"照抄一句示例"会错的地方，所以这里按真实日期钉住）。
 */

/** 直接造 `DateParts`，用来测"绕过 parseDate 的坏数据"（存储里可能有历史版本） */
const p = (y: number, m: number, d: number): DateParts => ({ y, m, d });

describe('weekdayLabel —— 周一在一周第一位', () => {
  it('周一与周日各归其位（这两头最容易错）', () => {
    // 2026-06-01 确实是周一，因此 06-06 是周六、06-07 是周日
    expect(weekdayLabel(p(2026, 6, 1))).toBe('周一');
    expect(weekdayLabel(p(2026, 6, 6))).toBe('周六');
    expect(weekdayLabel(p(2026, 6, 7))).toBe('周日');
  });

  it('⭐ 与 `Date.getDay()` 的口径必须能区分开（用那张表会把周日说成周一）', () => {
    // new Date(2026,5,7).getDay() === 0（周日=0），照 0 位取标签会得到「周一」
    expect(new Date(Date.UTC(2026, 5, 7)).getUTCDay()).toBe(0);
    expect(weekdayLabel(p(2026, 6, 7))).not.toBe('周一');
    // 跨年同样成立，不能只在同一个月内对
    expect(weekdayLabel(p(2027, 1, 1))).toBe('周五');
  });

  it('非法日期返回空串而不是抛错', () => {
    expect(weekdayLabel(p(2026, 2, 30))).toBe('');
    expect(weekdayLabel(p(2026, 13, 1))).toBe('');
    expect(weekdayLabel(p(1900, 1, 1))).toBe(''); // 落在 date-parts 认可的 1970~2999 之外
  });
});

describe('diffSummary —— 绝对天数 + 整周拆分 + 方向', () => {
  it('跨年：2026-12-28 → 2027-01-05 是 8 天（1 周 1 天）', () => {
    const r = diffSummary(p(2026, 12, 28), p(2027, 1, 5));
    expect(r).toEqual({
      days: 8,
      weeks: 1,
      restDays: 1,
      direction: 'future',
      fromWeekday: '周一',
      toWeekday: '周二',
    });
  });

  it('跨月：2026-01-31 → 2026-03-01 是 29 天（2026 年 2 月只有 28 天）', () => {
    const r = diffSummary(p(2026, 1, 31), p(2026, 3, 1));
    expect(r?.days).toBe(29);
    expect(r?.weeks).toBe(4);
    expect(r?.restDays).toBe(1);
  });

  it('同一天：days=0 且 direction=same（不能给"相差 -0 天"这种话）', () => {
    const r = diffSummary(p(2026, 6, 1), p(2026, 6, 1));
    expect(r?.days).toBe(0);
    expect(r?.weeks).toBe(0);
    expect(r?.restDays).toBe(0);
    expect(r?.direction).toBe('same');
    expect(r?.fromWeekday).toBe('周一');
    expect(r?.toWeekday).toBe('周一');
  });

  it('from > to：给绝对天数，方向标成 past（符号留在方向里，不污染数字）', () => {
    const r = diffSummary(p(2027, 1, 5), p(2026, 12, 28));
    expect(r?.days).toBe(8);
    expect(r?.weeks).toBe(1);
    expect(r?.restDays).toBe(1);
    expect(r?.direction).toBe('past');
  });

  it('整周与余数：7 天 = 1 周 0 天，8 天 = 1 周 1 天', () => {
    expect(diffSummary(p(2026, 5, 1), p(2026, 5, 8))).toMatchObject({
      days: 7,
      weeks: 1,
      restDays: 0,
    });
    expect(diffSummary(p(2026, 5, 1), p(2026, 5, 9))).toMatchObject({
      days: 8,
      weeks: 1,
      restDays: 1,
    });
  });

  it('⭐ 闰年 2/29：2028-02-28 → 2028-03-01 是 2 天，平年同期只有 1 天', () => {
    expect(diffSummary(p(2028, 2, 28), p(2028, 3, 1))?.days).toBe(2);
    expect(diffSummary(p(2026, 2, 28), p(2026, 3, 1))?.days).toBe(1);
    // 2028-02-29 本身是真实存在的日子，不能被当成非法输入挡掉
    expect(weekdayLabel(p(2028, 2, 29))).toBe('周二');
  });

  it('脏输入一律 null：未选（null）、不存在的日期、坏形状', () => {
    expect(diffSummary(null, p(2026, 6, 1))).toBeNull();
    expect(diffSummary(p(2026, 6, 1), null)).toBeNull();
    expect(diffSummary(null, null)).toBeNull();
    expect(diffSummary(p(2026, 2, 30), p(2026, 6, 1))).toBeNull();
    expect(diffSummary(p(2026, 6, 1), p(2026, 6, 31))).toBeNull();
  });

  it('经 `parseDate` 进来的字符串：非法格式与不存在的日期都得到 null，于是没有结果', () => {
    for (const bad of ['', '  ', '2026-13-01', '2026-02-30', '2026-02-29', 'abc', '2026/6/1']) {
      expect(parseDate(bad)).toBeNull();
      expect(dateRangeHint(parseDate(bad), p(2026, 6, 1))).toBe('');
    }
    expect(parseDate('2028-02-29')).toEqual(p(2028, 2, 29));
  });
});

describe('spanLabel —— 周数怎么说才像人话', () => {
  it('不足一周不写「0 周 3 天」，整除不写「4 周 0 天」', () => {
    expect(spanLabel(diffSummary(p(2026, 6, 1), p(2026, 6, 4))!)).toBe('3 天，不足一周');
    expect(spanLabel(diffSummary(p(2026, 6, 1), p(2026, 6, 29))!)).toBe('4 周整');
    expect(spanLabel(diffSummary(p(2026, 6, 1), p(2026, 12, 20))!)).toBe('28 周 6 天');
  });

  it('同一天说「就是这一天」', () => {
    expect(spanLabel(diffSummary(p(2026, 6, 1), p(2026, 6, 1))!)).toBe('就是这一天');
  });
});

describe('addDaysLabel —— 基准日 ± 天数', () => {
  it('往后推跨年：2026-12-20 + 60 = 2027-02-18（周四）', () => {
    expect(addDaysLabel(p(2026, 12, 20), 60)).toEqual({ date: '2027-02-18', weekday: '周四' });
  });

  it('⭐ 负数往前推：2026-01-15 - 100 = 2025-10-07（周二），跨年不能算错', () => {
    expect(addDaysLabel(p(2026, 1, 15), -100)).toEqual({ date: '2025-10-07', weekday: '周二' });
    expect(addDaysLabel(p(2026, 3, 1), -31)).toEqual({ date: '2026-01-29', weekday: '周四' });
  });

  it('0 天就是基准日本身；闰日 +1 落到 3 月 1 日', () => {
    expect(addDaysLabel(p(2026, 6, 1), 0)).toEqual({ date: '2026-06-01', weekday: '周一' });
    expect(addDaysLabel(p(2028, 2, 29), 1)).toEqual({ date: '2028-03-01', weekday: '周三' });
  });

  it('小数按整天四舍五入，超范围与非有限数返回 null', () => {
    expect(addDaysLabel(p(2026, 6, 1), 1.4)).toEqual({ date: '2026-06-02', weekday: '周二' });
    expect(addDaysLabel(p(2026, 6, 1), Number.NaN)).toBeNull();
    expect(addDaysLabel(p(2026, 6, 1), Number.POSITIVE_INFINITY)).toBeNull();
    expect(addDaysLabel(p(2026, 6, 1), 1e9)).toBeNull();
    expect(addDaysLabel(null, 10)).toBeNull();
    expect(addDaysLabel(p(2026, 2, 30), 10)).toBeNull();
  });
});

describe('dateRangeHint —— 一句能直接读出来的话', () => {
  it('⭐ 文案里的周几必须与真实日历一致（2026-12-20 是周日，不是周一）', () => {
    expect(dateRangeHint(p(2026, 6, 1), p(2026, 12, 20))).toBe(
      '2026-06-01 到 2026-12-20 还有 202 天（28 周 6 天），起始日是周一，目标日是周日',
    );
  });

  it('过去的方向说「已经过去」，而不是负数', () => {
    const hint = dateRangeHint(p(2027, 1, 5), p(2026, 12, 28));
    expect(hint).toContain('已经过去 8 天（1 周 1 天）');
    expect(hint).toContain('起始日是周二');
    expect(hint).toContain('目标日是周一');
  });

  it('整周不写「0 天」，不足一周不写括号', () => {
    expect(dateRangeHint(p(2026, 6, 1), p(2026, 6, 29))).toContain('（4 周整）');
    const short = dateRangeHint(p(2026, 6, 1), p(2026, 6, 4));
    expect(short).toContain('还有 3 天');
    expect(short).not.toContain('（');
  });

  it('同一天自成一句', () => {
    expect(dateRangeHint(p(2026, 6, 1), p(2026, 6, 1))).toBe('2026-06-01 与 2026-06-01 是同一天（周一）');
  });

  it('非法输入返回空串（页面据此显示引导空态，而不是弹错误）', () => {
    expect(dateRangeHint(null, p(2026, 6, 1))).toBe('');
    expect(dateRangeHint(p(2026, 2, 30), p(2026, 6, 1))).toBe('');
  });
});
