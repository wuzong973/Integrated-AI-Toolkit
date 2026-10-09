/**
 * 考试倒计时单测
 *
 * 日期原语（天数差 / 解析 / 周一对齐）的测试在 `tests/date-parts.spec.ts`，
 * 这里只测倒计时自己的逻辑：文案、排序、存储反序列化。
 *
 * 为什么存储反序列化值得单测：`wx.getStorageSync` 拿到的是**历史版本写下的东西**，
 * 结构可能已经变了。坏数据若让页面崩掉，用户会再也进不去这一页
 * （因为坏数据还在存储里）—— 所以"坏条目只丢自己"必须被钉住。
 */
import { describe, expect, it } from 'vitest';

import {
  countdownText,
  parseExams,
  sortExams,
  weeksText,
  type Exam,
} from '../apps/mp/utils/countdown';
import type { DateParts } from '../apps/mp/utils/date-parts';

const D = (y: number, m: number, d: number): DateParts => ({ y, m, d });

describe('countdownText / weeksText', () => {
  it('0 与 1 说人话', () => {
    expect(countdownText(0)).toBe('就是今天');
    expect(countdownText(1)).toBe('就是明天');
    expect(countdownText(2)).toBe('还有 2 天');
    expect(countdownText(-1)).toBe('昨天已考');
    expect(countdownText(-30)).toBe('已过去 30 天');
  });

  it('周数向上取整，已过期不显示周数', () => {
    expect(weeksText(1)).toBe('约 1 周');
    expect(weeksText(7)).toBe('约 1 周');
    expect(weeksText(8)).toBe('约 2 周');
    expect(weeksText(0)).toBe('');
    expect(weeksText(-3)).toBe('');
  });
});

describe('sortExams', () => {
  const today = D(2026, 9, 20);
  const e = (id: string, date: DateParts): Exam => ({ id, name: id, date });

  it('未过期的在前且越近越前；已过期的在后且越近越前', () => {
    const list = [
      e('past-old', D(2026, 1, 1)),
      e('far', D(2027, 6, 1)),
      e('past-new', D(2026, 9, 1)),
      e('today', D(2026, 9, 20)),
      e('near', D(2026, 10, 1)),
    ];
    expect(sortExams(list, today).map((x) => x.id)).toEqual([
      'today',
      'near',
      'far',
      'past-new',
      'past-old',
    ]);
  });

  it('同一天时用名称做二级键，保证顺序稳定', () => {
    const list = [e('b', D(2026, 10, 1)), e('a', D(2026, 10, 1))];
    expect(sortExams(list, today).map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('空列表与单元素不出错，且不修改入参', () => {
    expect(sortExams([], today)).toEqual([]);
    expect(sortExams([e('x', D(2026, 10, 1))], today).map((x) => x.id)).toEqual(['x']);

    const list = [e('late', D(2027, 1, 1)), e('soon', D(2026, 10, 1))];
    const before = list.map((x) => x.id);
    sortExams(list, today);
    expect(list.map((x) => x.id)).toEqual(before);
  });
});

describe('parseExams（存储反序列化当不可信输入）', () => {
  it('保留合法条目', () => {
    const raw = [{ id: 'a', name: '四六级', date: D(2026, 12, 19) }];
    expect(parseExams(raw)).toEqual(raw);
  });

  it('坏条目只丢自己，不影响其他条目', () => {
    const raw = [
      null,
      'not-an-object',
      { id: '', name: '空 id', date: D(2026, 12, 19) },
      { id: 'b', name: '   ', date: D(2026, 12, 19) },
      { id: 'c', name: '二月三十', date: D(2026, 2, 30) },
      { id: 'd', name: '正常', date: D(2026, 12, 19) },
    ];
    expect(parseExams(raw).map((x) => x.id)).toEqual(['d']);
  });

  it('名称两端空白被清掉（避免"  四六级"这种看不见的差异）', () => {
    const raw = [{ id: 'a', name: '  四六级  ', date: D(2026, 12, 19) }];
    expect(parseExams(raw)[0].name).toBe('四六级');
  });

  it('重复 id 只保留第一条（避免列表 key 冲突导致渲染错乱）', () => {
    const raw = [
      { id: 'dup', name: '先来', date: D(2026, 12, 19) },
      { id: 'dup', name: '后到', date: D(2026, 12, 20) },
    ];
    const out = parseExams(raw);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('先来');
  });

  it('整体不是数组 / 是 null 时返回空列表，而不是抛错', () => {
    expect(parseExams(null)).toEqual([]);
    expect(parseExams({ a: 1 })).toEqual([]);
    expect(parseExams('[]')).toEqual([]);
  });
});
