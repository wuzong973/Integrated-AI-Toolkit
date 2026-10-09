import { describe, expect, it } from 'vitest';

import { asJsonArray, asJsonObject, asStringArray } from '../json';

/**
 * Json 列取值工具（MySQL 迁移配套）
 * 关键约定：脏数据一律安全降级，绝不抛错、绝不把非字符串混进数组。
 */
describe('Json 列取值工具', () => {
  it('正常数组原样返回', () => {
    expect(asStringArray(['摄影', '后期修图'])).toEqual(['摄影', '后期修图']);
    expect(asStringArray([])).toEqual([]);
  });

  it('非数组输入降级为空数组', () => {
    expect(asStringArray(null)).toEqual([]);
    expect(asStringArray(undefined)).toEqual([]);
    expect(asStringArray('摄影')).toEqual([]);
    expect(asStringArray({ 0: '摄影' })).toEqual([]);
    expect(asStringArray(0)).toEqual([]);
  });

  it('数组内的非字符串项被丢弃（防止脏数据流入业务）', () => {
    expect(asStringArray(['摄影', 1, null, { a: 1 }, '摄像'])).toEqual(['摄影', '摄像']);
  });

  it('asJsonArray 保留元素原样，仅保证是数组', () => {
    expect(asJsonArray([1, 'a', null])).toEqual([1, 'a', null]);
    expect(asJsonArray({ a: 1 })).toEqual([]);
    expect(asJsonArray(null)).toEqual([]);
  });

  it('asJsonObject 只接受普通对象', () => {
    expect(asJsonObject({ a: 1 })).toEqual({ a: 1 });
    expect(asJsonObject([1, 2])).toBeNull();
    expect(asJsonObject('str')).toBeNull();
    expect(asJsonObject(null)).toBeNull();
  });
});
