/**
 * AA 分账单测
 *
 * 为什么这些用例值得写：
 *   分账是"算错了也看不出来"的典型 —— 界面会把一份错方案显示得很正常，
 *   只有真的按它转账、最后发现有人多出/少了一分钱，才会暴露。
 *   所以这里重点钉住三件事：**守恒（Σ 净额 = 0）、精确（Σ 份额 = 总额）、确定性（同输入同方案）**。
 */
import { describe, expect, it } from 'vitest';

import {
  computeSplit,
  formatCents,
  parseYuanToCents,
  type SplitExpense,
  type SplitMember,
} from '../apps/mp/utils/split-bill';

const M = (...names: string[]): SplitMember[] => names.map((name) => ({ id: name, name }));

/** 三个人的标准场景：A 付了 300 元，三人平摊 */
const THREE: SplitMember[] = M('A', 'B', 'C');
const one = (payerId: string, amountCents: number, memberIds: string[]): SplitExpense => ({
  payerId,
  amountCents,
  memberIds,
});

describe('parseYuanToCents', () => {
  it('接受整数、一位小数、两位小数', () => {
    expect(parseYuanToCents('12')).toBe(1200);
    expect(parseYuanToCents('12.3')).toBe(1230);
    expect(parseYuanToCents('12.34')).toBe(1234);
    expect(parseYuanToCents('0')).toBe(0);
    expect(parseYuanToCents(' 8.5 ')).toBe(850);
  });

  it('拒绝空值、非数字、超过两位小数、负数、以点开头', () => {
    for (const bad of ['', '   ', 'abc', '12.345', '-5', '.5', '1e3', '12,5']) {
      expect(parseYuanToCents(bad), `「${bad}」应当被拒绝`).toBeNull();
    }
  });

  it('超出安全整数的金额返回 null，而不是一个失真的数', () => {
    expect(parseYuanToCents('999999999999999999')).toBeNull();
  });
});

describe('formatCents', () => {
  it('补足两位小数并保留符号', () => {
    expect(formatCents(1200)).toBe('12.00');
    expect(formatCents(1234)).toBe('12.34');
    expect(formatCents(5)).toBe('0.05');
    expect(formatCents(-1234)).toBe('-12.34');
    expect(formatCents(0)).toBe('0.00');
  });
});

describe('computeSplit', () => {
  it('三人平摊 300 元：付钱的人收回 200，另两人各付 100', () => {
    const r = computeSplit(THREE, [one('A', 30000, ['A', 'B', 'C'])]);
    expect(r.error).toBe('');
    expect(r.totalCents).toBe(30000);

    const net = Object.fromEntries(r.balances.map((b) => [b.name, b.netCents]));
    expect(net).toEqual({ A: 20000, B: -10000, C: -10000 });

    // 两笔转账，且总额恰好 200 元
    expect(r.settlements).toHaveLength(2);
    expect(r.settlements.reduce((a, s) => a + s.amountCents, 0)).toBe(20000);
    for (const s of r.settlements) expect(s.toName).toBe('A');
  });

  it('⭐ 除不尽时余数逐个补分，份额之和恒等于总额（100 分 3 人）', () => {
    const r = computeSplit(THREE, [one('A', 100, ['A', 'B', 'C'])]);
    expect(r.error).toBe('');
    // 34 + 33 + 33 = 100，不会出现 33.33 这种分不出来的数
    const owed = r.balances.map((b) => b.owedCents).sort((a, b) => b - a);
    expect(owed).toEqual([34, 33, 33]);
    expect(owed.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('⭐ 任意人数 × 任意总额：净额守恒且份额之和 == 总额', () => {
    for (let n = 2; n <= 7; n += 1) {
      const members = M(...Array.from({ length: n }, (_, i) => `m${i}`));
      const ids = members.map((m) => m.id);
      for (const total of [1, 7, 99, 100, 12345, 999999]) {
        const r = computeSplit(members, [one(ids[0], total, ids)]);
        expect(r.error).toBe('');
        expect(r.balances.reduce((a, b) => a + b.netCents, 0)).toBe(0);
        expect(r.balances.reduce((a, b) => a + b.owedCents, 0)).toBe(total);
        expect(r.balances.reduce((a, b) => a + b.paidCents, 0)).toBe(total);
      }
    }
  });

  it('部分人参与：没参与的人净额为 0，不参与分摊', () => {
    // A 付 300 元，只有 A、B 分摊 → A 收回 150
    const r = computeSplit(THREE, [one('A', 30000, ['A', 'B'])]);
    const net = Object.fromEntries(r.balances.map((b) => [b.name, b.netCents]));
    expect(net).toEqual({ A: 15000, B: -15000, C: 0 });
    expect(r.settlements).toHaveLength(1);
    expect(r.settlements[0]).toMatchObject({ fromName: 'B', toName: 'A', amountCents: 15000 });
  });

  it('多笔账互相冲抵后只剩一笔转账', () => {
    // A 付 100 三人摊；B 付 100 三人摊 → A、B 各该收回 100/3*2，C 欠 200/3
    // 用整数好算的例子：A 付 60 两人摊(A,B)，B 付 60 两人摊(A,B) → 两人都平，无需转账
    const r = computeSplit(M('A', 'B'), [one('A', 6000, ['A', 'B']), one('B', 6000, ['A', 'B'])]);
    expect(r.error).toBe('');
    expect(r.settlements).toHaveLength(0);
    expect(r.balances.every((b) => b.netCents === 0)).toBe(true);
  });

  it('重复勾选同一人不会让这笔钱被摊两次', () => {
    const r = computeSplit(THREE, [one('A', 30000, ['A', 'B', 'B', 'C'])]);
    expect(r.balances.reduce((a, b) => a + b.owedCents, 0)).toBe(30000);
    const net = Object.fromEntries(r.balances.map((b) => [b.name, b.netCents]));
    expect(net).toEqual({ A: 20000, B: -10000, C: -10000 });
  });

  it('空金额 / 零 / 负数被跳过，而不是算进账里', () => {
    const r = computeSplit(THREE, [
      one('A', 0, ['A', 'B', 'C']),
      one('A', Number.NaN, ['A', 'B', 'C']),
      one('A', -100, ['A', 'B', 'C']),
      one('A', 30000, ['A', 'B', 'C']),
    ]);
    expect(r.error).toBe('');
    expect(r.totalCents).toBe(30000);
  });

  it('一笔账没勾参与人 → 报错，而不是当作"这笔不用分"', () => {
    const r = computeSplit(THREE, [one('A', 30000, [])]);
    expect(r.error).not.toBe('');
    expect(r.settlements).toEqual([]);
    expect(r.balances).toEqual([]);
  });

  it('付款人不在名单 / 勾了已删除的成员 → 报错，不给半份结果', () => {
    expect(computeSplit(THREE, [one('X', 100, ['A'])]).error).not.toBe('');
    expect(computeSplit(THREE, [one('A', 100, ['A', 'X'])]).error).not.toBe('');
  });

  it('单人 / 无人：不报错，也不产生转账', () => {
    expect(computeSplit(M('A'), [one('A', 100, ['A'])]).settlements).toEqual([]);
    expect(computeSplit([], []).settlements).toEqual([]);
  });

  it('⭐ 同样输入永远得到同样方案（排序有确定性二级键）', () => {
    const members = M('A', 'B', 'C', 'D');
    const expenses = [one('A', 10000, ['A', 'B', 'C', 'D']), one('B', 3333, ['A', 'B', 'D'])];
    const a = computeSplit(members, expenses);
    const b = computeSplit([...members].reverse(), expenses);
    const key = (r: typeof a) => r.settlements.map((s) => `${s.fromName}->${s.toName}:${s.amountCents}`);
    expect(key(a)).toEqual(key(b));
  });

  it('转账笔数不超过 人数 − 1', () => {
    for (let n = 2; n <= 8; n += 1) {
      const members = M(...Array.from({ length: n }, (_, i) => `m${i}`));
      const ids = members.map((m) => m.id);
      // 每人轮流付一笔，制造尽可能碎的债务关系
      const expenses = ids.map((id, i) => one(id, 1000 + i * 137, ids));
      const r = computeSplit(members, expenses);
      expect(r.error).toBe('');
      expect(r.settlements.length).toBeLessThanOrEqual(n - 1);
      // 方案执行后每个人都应结清
      const net = new Map(r.balances.map((b) => [b.id, b.netCents]));
      for (const s of r.settlements) {
        net.set(s.fromId, net.get(s.fromId)! + s.amountCents);
        net.set(s.toId, net.get(s.toId)! - s.amountCents);
      }
      expect([...net.values()].every((v) => v === 0)).toBe(true);
    }
  });
});
