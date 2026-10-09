import { describe, expect, it } from 'vitest';

import { computeGpa, toPoint } from '../apps/mp/utils/gpa';

/**
 * GPA 计算的测试。
 *
 * ⚠️ 位置说明：小程序的测试**必须放 `tests/`**，不能放 `apps/mp/` 里 ——
 * `miniprogramRoot` 就是 `apps/mp/`，即发布包本身，包内的 spec 文件会被
 * 开发者工具"过滤无依赖文件"点名，也有被误打包的风险（见 `vitest.config.ts`）。
 */

describe('GPA 计算 —— 区间表口径', () => {
  it('按学分加权（不是简单平均）', () => {
    // 4 学分的 90 分（4.0）+ 3 学分的 80 分（3.0）
    // 加权 = (4.0×4 + 3.0×3) / 7 = 25/7 ≈ 3.57；简单平均会得到 3.5，两者必须能区分
    const r = computeGpa([
      { name: '高数', score: 90, credit: 4 },
      { name: '英语', score: 80, credit: 3 },
    ]);
    expect(r.gpa).toBe(3.57);
    expect(r.totalCredits).toBe(7);
    expect(r.average).toBe(85.71);
  });

  it('⭐ 区间表是降序的：高分必须匹配到高档，而不是被低档截胡', () => {
    // 升序表会让 95 分匹配到 60 分那一档（1.0），且不会报错 —— 最坏的错法
    expect(toPoint(95)).toBe(4.0);
    expect(toPoint(90)).toBe(4.0);
    expect(toPoint(89)).toBe(3.7);
    expect(toPoint(60)).toBe(1.0);
    expect(toPoint(59)).toBe(0);
  });

  it('边界值逐个钉住（改表时不会悄悄漂）', () => {
    expect(toPoint(100)).toBe(4.0);
    expect(toPoint(85)).toBe(3.7);
    expect(toPoint(82)).toBe(3.3);
    expect(toPoint(78)).toBe(3.0);
    expect(toPoint(75)).toBe(2.7);
    expect(toPoint(72)).toBe(2.3);
    expect(toPoint(68)).toBe(2.0);
    expect(toPoint(64)).toBe(1.5);
    expect(toPoint(63)).toBe(1.0);
  });
});

describe('GPA 计算 —— 5.0 公式口径', () => {
  it('60 分 = 1.0，每 10 分 +1，上限 5.0', () => {
    expect(toPoint(60, 'formula5')).toBe(1.0);
    expect(toPoint(70, 'formula5')).toBe(2.0);
    expect(toPoint(90, 'formula5')).toBe(4.0);
    expect(toPoint(100, 'formula5')).toBe(5.0);
  });

  it('不及格记 0（不是负数）', () => {
    // 公式 (score-50)/10 在 50 分以下会变负，必须显式拦掉
    expect(toPoint(50, 'formula5')).toBe(0);
    expect(toPoint(0, 'formula5')).toBe(0);
  });
});

describe('GPA 计算 —— 脏输入', () => {
  it('空数组返回零值而不是 NaN', () => {
    const r = computeGpa([]);
    expect(r.gpa).toBe(0);
    expect(r.average).toBe(0);
    expect(r.totalCredits).toBe(0);
    expect(r.items).toEqual([]);
  });

  it('学分 <= 0 的条目被忽略（边填边算的中间态很常见）', () => {
    const r = computeGpa([
      { name: '已填', score: 90, credit: 3 },
      { name: '还没填学分', score: 95, credit: 0 },
      { name: '学分是负的', score: 95, credit: -1 },
    ]);
    expect(r.items).toHaveLength(1);
    expect(r.totalCredits).toBe(3);
  });

  it('成绩超范围被夹到 0~100（不是原样参与计算）', () => {
    expect(toPoint(120)).toBe(4.0);
    expect(toPoint(-10)).toBe(0);
    const r = computeGpa([{ name: '手滑', score: 120, credit: 2 }]);
    expect(r.average).toBe(100);
  });

  it('NaN 成绩被忽略，不会污染整体结果', () => {
    const r = computeGpa([
      { name: '正常', score: 90, credit: 2 },
      { name: '坏数据', score: Number.NaN, credit: 3 },
    ]);
    expect(r.totalCredits).toBe(2);
    expect(r.gpa).toBe(4);
  });

  it('明细逐门保留，界面可以直接渲染表格', () => {
    const r = computeGpa([{ name: '线性代数', score: 82, credit: 3 }]);
    expect(r.items).toEqual([{ name: '线性代数', score: 82, credit: 3, point: 3.3 }]);
  });
});
