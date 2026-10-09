/**
 * 抽签 / 点名 / 随机分组单测
 *
 * 为什么这些用例值得写：
 *   抽签是"错了也看不出来"的最典型场景 —— 用有偏的算法抽 100 次，
 *   每一次的结果都长得完全正常，只有把 10000 次的结果统计起来才看得出偏差。
 *   所以这里重点钉住四件事：
 *     **① 无偏**（每个元素落到每个位置的概率相等）
 *     **② 守恒**（分组不丢人、不重复人）
 *     **③ 拒绝采样真的在拒绝**（不是"写了注释但没生效"）
 *     **④ 可复现**（同随机源 → 同结果；否则"同样输入不同结果"无法排查）
 */
import { describe, expect, it } from 'vitest';

import {
  cleanName,
  draw,
  formatDrawText,
  formatGroupText,
  groupInto,
  parseRoster,
  randomFromBytes,
  randomInt,
  shuffle,
  weakRandom,
  type RandomFn,
} from '../apps/mp/utils/lottery';

/**
 * 可复现的伪随机源（xorshift32，周期 2^32−1）。
 *
 * ⚠️ 刻意**不用 LCG**：LCG 的低位周期极短（低 k 位周期只有 2^k），
 * 而 `randomInt` 内部会做 `v % bound`，正好用到低位 —— 用它做均匀性检验
 * 会把"检验方法自身的缺陷"当成"被测代码的偏差"。
 */
function prng(seed: number): RandomFn {
  let s = seed >>> 0 || 1;
  return (): number => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

/** 按顺序吐出给定值的随机源（用于精确验证分支走向） */
function seq(values: number[]): RandomFn {
  let i = 0;
  return (): number => values[Math.min(i++, values.length - 1)];
}

describe('randomInt', () => {
  it('n <= 1 时返回 0（"从 1 个人里抽 1 个"是合法输入）', () => {
    expect(randomInt(prng(1), 1)).toBe(0);
    expect(randomInt(prng(1), 0)).toBe(0);
    expect(randomInt(prng(1), -3)).toBe(0);
  });

  it('结果始终落在 [0, n) 内', () => {
    const rand = prng(20260920);
    for (let i = 0; i < 5000; i += 1) {
      const v = randomInt(rand, 7);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });

  it('⭐ 拒绝采样真的生效：落在拒绝区的样本被丢弃，而不是直接取模', () => {
    // n = 2^31 + 1 → limit 恰好等于 n 本身，拒绝区 = [n, 2^32)，非常大
    const n = 2147483649;
    const limit = Math.floor(4294967296 / n) * n;
    expect(limit).toBe(n);

    // 第一个值落在拒绝区（若直接取模会得到 852516351），第二个值合法
    const v = randomInt(seq([3000000000, 5]), n);
    expect(v).toBe(5);
    expect(3000000000 % n).not.toBe(5);
  });

  it('⭐ n = 3 时最后一个 u32 被拒绝（否则 0 会多出一次机会）', () => {
    // 4294967295 是 2^32 − 1，`% 3 === 0` —— 直接取模会让下标 0 被多算一次
    expect(randomInt(seq([4294967295, 7]), 3)).toBe(1);
    expect(4294967295 % 3).toBe(0);
  });

  it('随机源是"永远落在拒绝区"的常量时，兜底返回合法值而不是死循环', () => {
    const v = randomInt(seq([4294967295]), 3);
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(3);
  });

  it('随机源越界 / 非整数时不会被当成合法样本', () => {
    // -1 与 NaN 都非法 → 走兜底分支，仍然给出 [0, n) 内的值
    for (const bad of [-1, Number.NaN, 4294967296]) {
      const v = randomInt(seq([bad, 2]), 5);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(5);
    }
  });
});

describe('shuffle', () => {
  const items = ['A', 'B', 'C', 'D', 'E'];

  it('不改入参，且元素集合与长度不变', () => {
    const src = items.slice();
    const out = shuffle(src, prng(7));
    expect(src).toEqual(items);
    expect(out).toHaveLength(items.length);
    expect([...out].sort()).toEqual([...items].sort());
  });

  it('空数组与单元素数组不报错', () => {
    expect(shuffle([], prng(1))).toEqual([]);
    expect(shuffle(['x'], prng(1))).toEqual(['x']);
  });

  it('⭐ 同样随机源 → 同样结果（否则线上问题无法复现）', () => {
    const a = shuffle(items, prng(12345));
    const b = shuffle(items, prng(12345));
    expect(a).toEqual(b);
  });

  it('⭐ 无偏：每个元素落到每个位置的概率都接近 1/n（10 万次采样）', () => {
    const rand = prng(20260920);
    const n = items.length;
    const ROUNDS = 100000;
    const hits = items.map(() => new Array<number>(n).fill(0));

    for (let r = 0; r < ROUNDS; r += 1) {
      const out = shuffle(items, rand);
      out.forEach((name, pos) => {
        hits[items.indexOf(name)][pos] += 1;
      });
    }

    const expected = ROUNDS / n; // 20000
    const tolerance = expected * 0.06; // ±6%，约 8σ，既拦得住偏差也不误报
    for (const row of hits) {
      for (const count of row) {
        expect(Math.abs(count - expected)).toBeLessThan(tolerance);
      }
    }
  });

  it('⭐ 无偏：第一个位置上的元素分布也是均匀的（不被排序算法偏爱）', () => {
    const rand = prng(99991);
    const n = items.length;
    const ROUNDS = 60000;
    const first = new Map<string, number>(items.map((x) => [x, 0]));
    for (let r = 0; r < ROUNDS; r += 1) {
      const name = shuffle(items, rand)[0];
      first.set(name, first.get(name)! + 1);
    }
    const expected = ROUNDS / n;
    for (const count of first.values()) {
      expect(Math.abs(count - expected)).toBeLessThan(expected * 0.06);
    }
  });
});

describe('randomFromBytes', () => {
  it('同一批字节 → 同一序列（可复现）', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const a = randomFromBytes(bytes);
    const b = randomFromBytes(bytes);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('按小端拼 uint32', () => {
    const rand = randomFromBytes(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0x80]));
    expect(rand()).toBe(1);
    expect(rand()).toBe(0x80000000);
  });

  it('字节不足 4 个时降级，但仍返回合法 uint32', () => {
    const v = randomFromBytes(new Uint8Array([1, 2]))();
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(4294967296);
  });

  it('⭐ 字节用尽后从头重放，绝不返回常量或 NaN', () => {
    const rand = randomFromBytes(new Uint8Array([9, 0, 0, 0]));
    const values = Array.from({ length: 6 }, () => rand());
    expect(values).toEqual([9, 9, 9, 9, 9, 9]);
    for (const v of values) expect(Number.isInteger(v)).toBe(true);
  });
});

describe('weakRandom', () => {
  it('返回 [0, 2^32) 内的整数（降级源也必须遵守 RandomFn 契约）', () => {
    for (let i = 0; i < 2000; i += 1) {
      const v = weakRandom();
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(4294967296);
    }
  });
});

describe('cleanName', () => {
  it('去掉行首序号（Excel / 学号表粘贴的常态）', () => {
    expect(cleanName('1. 张三')).toBe('张三');
    expect(cleanName('12、李四')).toBe('李四');
    expect(cleanName('3) 王五')).toBe('王五');
    expect(cleanName('4] 赵六')).toBe('赵六');
    expect(cleanName('5．钱七')).toBe('钱七');
  });

  it('⚠️ 只吃行首序号，名字中间的字符一个都不动', () => {
    expect(cleanName('李三 3')).toBe('李三 3');
    expect(cleanName('2024级 张同学')).toBe('2024级 张同学');
    expect(cleanName('张三.李四')).toBe('张三.李四');
  });

  it('折叠多余空白，空行返回空串', () => {
    expect(cleanName('  张   三  ')).toBe('张 三');
    expect(cleanName('   ')).toBe('');
    expect(cleanName('')).toBe('');
  });
});

describe('parseRoster', () => {
  it('一行一个名字，忽略空行', () => {
    const r = parseRoster('张三\n李四\n\n王五\n');
    expect(r.names).toEqual(['张三', '李四', '王五']);
    expect(r.blankLines).toBe(2);
    expect(r.duplicates).toEqual([]);
  });

  it('兼容 CRLF（Windows 里复制出来的文本）', () => {
    expect(parseRoster('张三\r\n李四\r\n').names).toEqual(['张三', '李四']);
  });

  it('⭐ 重名保留首次出现并如实报告，而不是悄悄合并', () => {
    const r = parseRoster('张三\n李四\n张三\n李四\n张三');
    expect(r.names).toEqual(['张三', '李四']);
    expect(r.duplicates).toEqual(['张三', '李四', '张三']);
  });

  it('带序号与空行的混合输入', () => {
    const r = parseRoster('1. 张三\n\n2、李四\n   \n3) 王五');
    expect(r.names).toEqual(['张三', '李四', '王五']);
    expect(r.blankLines).toBe(2);
  });

  it('空输入 / 纯空白 / 非字符串都不报错', () => {
    expect(parseRoster('').names).toEqual([]);
    expect(parseRoster('  \n \n').names).toEqual([]);
    expect(parseRoster(undefined as unknown as string).names).toEqual([]);
  });
});

describe('draw', () => {
  const names = ['A', 'B', 'C', 'D', 'E'];

  it('抽 1 个：结果属于名单，remaining 递减', () => {
    const r = draw(names, 1, prng(3));
    expect(r.error).toBe('');
    expect(r.picked).toHaveLength(1);
    expect(names).toContain(r.picked[0]);
    expect(r.remaining).toBe(4);
  });

  it('⭐ 抽 n 个：互不重复，且都来自名单', () => {
    const r = draw(names, 3, prng(42));
    expect(r.error).toBe('');
    expect(r.picked).toHaveLength(3);
    expect(new Set(r.picked).size).toBe(3);
    for (const p of r.picked) expect(names).toContain(p);
  });

  it('抽满全部：结果是名单的一个排列', () => {
    const r = draw(names, 5, prng(8));
    expect([...r.picked].sort()).toEqual([...names].sort());
    expect(r.remaining).toBe(0);
  });

  it('exclude 生效：抽过的人不再出现（不重复点名）', () => {
    const r = draw(names, 2, prng(11), ['A', 'B']);
    expect(r.error).toBe('');
    for (const p of r.picked) expect(['A', 'B']).not.toContain(p);
    expect(r.remaining).toBe(1);
  });

  it('⭐ 候选不够时报错并清空结果，而不是少给几个', () => {
    const r = draw(names, 3, prng(1), ['A', 'B', 'C', 'D']);
    expect(r.error).not.toBe('');
    expect(r.picked).toEqual([]);
  });

  it('全部抽完后再抽 → 提示重置', () => {
    const r = draw(names, 1, prng(1), names);
    expect(r.error).toContain('都已经抽过');
    expect(r.picked).toEqual([]);
    expect(r.remaining).toBe(0);
  });

  it('人数非法 / 名单为空 → 报错而不是返回空结果当成功', () => {
    expect(draw(names, 0, prng(1)).error).not.toBe('');
    expect(draw(names, Number.NaN, prng(1)).error).not.toBe('');
    expect(draw([], 1, prng(1)).error).not.toBe('');
  });

  it('⭐ 每个候选被抽中的概率相同（单人抽取 6 万次）', () => {
    const rand = prng(20260921);
    const ROUNDS = 60000;
    const counted = new Map<string, number>(names.map((x) => [x, 0]));
    for (let i = 0; i < ROUNDS; i += 1) {
      const p = draw(names, 1, rand).picked[0];
      counted.set(p, counted.get(p)! + 1);
    }
    const expected = ROUNDS / names.length;
    for (const c of counted.values()) {
      expect(Math.abs(c - expected)).toBeLessThan(expected * 0.06);
    }
  });
});

describe('groupInto', () => {
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

  it('⭐ 守恒：各组人数之和等于名单人数，且不重不漏', () => {
    for (let k = 1; k <= names.length; k += 1) {
      const r = groupInto(names, k, prng(100 + k));
      expect(r.error).toBe('');
      expect(r.groups).toHaveLength(k);
      const flat = r.groups.flat();
      expect(flat).toHaveLength(names.length);
      expect([...flat].sort()).toEqual([...names].sort());
    }
  });

  it('⭐ 人数尽量平均：组间人数差不超过 1', () => {
    for (let k = 1; k <= names.length; k += 1) {
      const r = groupInto(names, k, prng(200 + k));
      const sizes = r.groups.map((g) => g.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
  });

  it('除不尽时多出来的人分给靠前的组（7 人分 3 组 = 3+2+2）', () => {
    const r = groupInto(names, 3, prng(7));
    expect(r.groups.map((g) => g.length)).toEqual([3, 2, 2]);
  });

  it('⚠️ 不承诺"最优分组"：只保证人数平均，组员是随机的', () => {
    const a = groupInto(names, 3, prng(1)).groups;
    const b = groupInto(names, 3, prng(2)).groups;
    expect(a).not.toEqual(b);
  });

  it('⭐ 同样随机源 → 同样分组', () => {
    expect(groupInto(names, 3, prng(555)).groups).toEqual(groupInto(names, 3, prng(555)).groups);
  });

  it('组数多于人数 / 组数非法 / 名单为空 → 报错', () => {
    expect(groupInto(names, 8, prng(1)).error).not.toBe('');
    expect(groupInto(names, 0, prng(1)).error).not.toBe('');
    expect(groupInto([], 2, prng(1)).error).not.toBe('');
  });

  it('1 人分 1 组不报错（边界）', () => {
    const r = groupInto(['独苗'], 1, prng(1));
    expect(r.error).toBe('');
    expect(r.groups).toEqual([['独苗']]);
  });
});

describe('分享文案', () => {
  it('抽签结果一行一个', () => {
    expect(formatDrawText(['张三', '李四'])).toBe('张三\n李四');
  });

  it('分组结果每组一段，带组号', () => {
    expect(formatGroupText([['A', 'B'], ['C']])).toBe('第 1 组：A、B\n第 2 组：C');
  });
});
