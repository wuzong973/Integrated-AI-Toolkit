/**
 * 课程表单测
 *
 * 重点钉住四件事：
 *   ① **周次与单双周的边界**（第 1 周 / 最后一周 / 单双周切换）；
 *   ② **`weekOfTerm` 在开学前返回 ≤ 0** —— 界面据此说"学期还没开始"，
 *      强行夹到第 1 周会显示一份看起来很像真的的课表；
 *   ③ **网格百分比** —— 第 1 节从 0% 开始、跨 2 节占 25%（8 节/天）；
 *   ④ **存储反序列化的形状校验**（end<start、13 月、非法 parity 都要挡住）。
 */
import { describe, expect, it } from 'vitest';

import type { DateParts } from '../apps/mp/utils/date-parts';
import {
  coursesOfWeek,
  isActiveInWeek,
  layoutOf,
  parseCourses,
  parseTimetable,
  periodText,
  PERIOD_COUNT,
  weekOfTerm,
  type Course,
} from '../apps/mp/utils/timetable';

const D = (y: number, m: number, d: number): DateParts => ({ y, m, d });

const course = (over: Partial<Course> = {}): Course => ({
  id: 'c1',
  name: '高等数学',
  teacher: '张老师',
  location: 'A301',
  weekday: 1,
  start: 1,
  end: 2,
  fromWeek: 1,
  toWeek: 16,
  parity: 'all',
  ...over,
});

describe('periodText', () => {
  it('单节说"第 N 节"，跨节说"N-M 节"', () => {
    expect(periodText(3, 3)).toBe('第 3 节');
    expect(periodText(3, 4)).toBe('3-4 节');
  });
});

describe('isActiveInWeek', () => {
  const c = course({ fromWeek: 3, toWeek: 8, parity: 'all' });

  it('周次范围是闭区间', () => {
    expect(isActiveInWeek(c, 2)).toBe(false);
    expect(isActiveInWeek(c, 3)).toBe(true);
    expect(isActiveInWeek(c, 8)).toBe(true);
    expect(isActiveInWeek(c, 9)).toBe(false);
  });

  it('单周 / 双周只在对应奇偶周生效', () => {
    const odd = course({ parity: 'odd' });
    const even = course({ parity: 'even' });
    expect([1, 2, 3, 4].map((w) => isActiveInWeek(odd, w))).toEqual([true, false, true, false]);
    expect([1, 2, 3, 4].map((w) => isActiveInWeek(even, w))).toEqual([false, true, false, true]);
  });

  it('单双周与周次范围叠加：范围外一律不上', () => {
    const odd = course({ fromWeek: 5, toWeek: 6, parity: 'odd' });
    expect(isActiveInWeek(odd, 4)).toBe(false); // 双周且在范围外
    expect(isActiveInWeek(odd, 5)).toBe(true); // 单周且在范围内
    expect(isActiveInWeek(odd, 6)).toBe(false); // 双周
  });
});

describe('weekOfTerm', () => {
  const termStart = D(2026, 9, 21); // 周一

  it('开学当天是第 1 周，第 7 天仍是第 1 周，第 8 天进第 2 周', () => {
    expect(weekOfTerm(termStart, D(2026, 9, 21))).toBe(1);
    expect(weekOfTerm(termStart, D(2026, 9, 27))).toBe(1); // 周日
    expect(weekOfTerm(termStart, D(2026, 9, 28))).toBe(2);
  });

  it('⭐ 开学前返回 ≤ 0（界面据此说"学期还没开始"，而不是假装第 1 周）', () => {
    expect(weekOfTerm(termStart, D(2026, 9, 20))).toBe(0);
    expect(weekOfTerm(termStart, D(2026, 9, 14))).toBe(0);
    expect(weekOfTerm(termStart, D(2026, 9, 13))).toBe(-1);
  });

  it('跨月跨年都对', () => {
    expect(weekOfTerm(D(2026, 12, 28), D(2027, 1, 4))).toBe(2);
  });
});

describe('coursesOfWeek', () => {
  const list = [
    course({ id: 'a', fromWeek: 1, toWeek: 4 }),
    course({ id: 'b', fromWeek: 5, toWeek: 8 }),
    course({ id: 'c', parity: 'odd', fromWeek: 1, toWeek: 8 }),
  ];

  it('按周次与单双周过滤', () => {
    expect(coursesOfWeek(list, 1).map((c) => c.id)).toEqual(['a', 'c']);
    expect(coursesOfWeek(list, 2).map((c) => c.id)).toEqual(['a']);
    expect(coursesOfWeek(list, 5).map((c) => c.id)).toEqual(['b', 'c']);
    expect(coursesOfWeek(list, 9)).toEqual([]);
  });
});

describe('layoutOf', () => {
  it('七天都有列，标签是中文数字', () => {
    const cols = layoutOf([], 1);
    expect(cols).toHaveLength(7);
    expect(cols.map((c) => c.label)).toEqual(['一', '二', '三', '四', '五', '六', '日']);
    expect(cols.every((c) => c.blocks.length === 0)).toBe(true);
  });

  it('⭐ 百分比：第 1 节从 0% 开始，跨 2 节占 2/8 = 25%', () => {
    const cols = layoutOf([course({ start: 1, end: 2 })], 1);
    const block = cols[0].blocks[0];
    expect(block.top).toBe(0);
    expect(block.height).toBe(25); // 2 / 8
    expect(block.periodText).toBe('1-2 节');
  });

  it('第 3-4 节：top = 2/8 = 25%，height = 25%', () => {
    const cols = layoutOf([course({ start: 3, end: 4 })], 1);
    expect(cols[0].blocks[0].top).toBe(25);
    expect(cols[0].blocks[0].height).toBe(25);
  });

  it('单节高度 = 1/8 = 12.5%，最后一节 top = 7/8 = 87.5%', () => {
    const cols = layoutOf([course({ start: PERIOD_COUNT, end: PERIOD_COUNT })], 1);
    expect(cols[0].blocks[0].top).toBe(87.5);
    expect(cols[0].blocks[0].height).toBe(12.5);
  });

  it('同一格多门课按起始节次排序（顺序稳定，界面才不会"跳"）', () => {
    const cols = layoutOf(
      [
        course({ id: 'late', name: 'C', start: 5, end: 6 }),
        course({ id: 'early', name: 'A', start: 1, end: 2 }),
        course({ id: 'mid', name: 'B', start: 3, end: 4 }),
      ],
      1,
    );
    expect(cols[0].blocks.map((b) => b.id)).toEqual(['early', 'mid', 'late']);
  });

  it('只排当前周生效的课，其他周次的课不出现', () => {
    const cols = layoutOf([course({ fromWeek: 5, toWeek: 8 })], 1);
    expect(cols[0].blocks).toEqual([]);
    expect(layoutOf([course({ fromWeek: 5, toWeek: 8 })], 5)[0].blocks).toHaveLength(1);
  });
});

describe('parseCourses（存储反序列化当不可信输入）', () => {
  const ok = { ...course() };

  it('保留合法条目并清掉两端空白', () => {
    const out = parseCourses([{ ...ok, name: '  高数  ', teacher: ' 张老师 ', location: ' A301 ' }]);
    expect(out[0]).toMatchObject({ name: '高数', teacher: '张老师', location: 'A301' });
  });

  it('挡住不合法的节次关系', () => {
    expect(parseCourses([{ ...ok, start: 5, end: 3 }])).toEqual([]);
    expect(parseCourses([{ ...ok, start: 0 }])).toEqual([]);
    expect(parseCourses([{ ...ok, end: PERIOD_COUNT + 1 }])).toEqual([]);
  });

  it('挡住不合法的星期 / 周次 / 单双周', () => {
    expect(parseCourses([{ ...ok, weekday: 0 }])).toEqual([]);
    expect(parseCourses([{ ...ok, weekday: 8 }])).toEqual([]);
    expect(parseCourses([{ ...ok, fromWeek: 9, toWeek: 3 }])).toEqual([]);
    expect(parseCourses([{ ...ok, toWeek: 99 }])).toEqual([]);
    expect(parseCourses([{ ...ok, parity: 'sometimes' }])).toEqual([]);
  });

  it('缺 id / 缺名称的条目被丢掉', () => {
    expect(parseCourses([{ ...ok, id: '' }])).toEqual([]);
    expect(parseCourses([{ ...ok, name: '   ' }])).toEqual([]);
  });

  it('teacher / location 缺失时补空串（而不是 undefined 渲染成 "undefined"）', () => {
    const { teacher, location, ...rest } = ok;
    const out = parseCourses([rest]);
    expect(out[0].teacher).toBe('');
    expect(out[0].location).toBe('');
    expect(teacher).toBeDefined();
    expect(location).toBeDefined();
  });

  it('重复 id 只留第一条；整体不是数组时返回空', () => {
    expect(parseCourses([ok, { ...ok, name: '后到' }])).toHaveLength(1);
    expect(parseCourses(null)).toEqual([]);
    expect(parseCourses('[]')).toEqual([]);
  });
});

describe('parseTimetable', () => {
  it('合法 termStart 保留，非法 termStart 变 null（不是"默认今天"）', () => {
    const courses = [course()];
    expect(parseTimetable({ termStart: D(2026, 9, 21), courses }).termStart).toEqual(
      D(2026, 9, 21),
    );
    expect(parseTimetable({ termStart: D(2026, 2, 30), courses }).termStart).toBeNull();
    expect(parseTimetable({ termStart: null, courses }).termStart).toBeNull();
  });

  it('坏 courses 不影响 termStart，反之亦然', () => {
    const out = parseTimetable({ termStart: D(2026, 9, 21), courses: 'nope' });
    expect(out.termStart).toEqual(D(2026, 9, 21));
    expect(out.courses).toEqual([]);
  });

  it('整体非法时返回全空状态，而不是抛错', () => {
    expect(parseTimetable(null)).toEqual({ termStart: null, courses: [] });
    expect(parseTimetable('x')).toEqual({ termStart: null, courses: [] });
  });
});
