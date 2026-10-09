/**
 * 单位换算单测
 *
 * 为什么这些用例值得写：
 *   换算是"算错了也看不出来"的典型 —— 界面会把 `0.30000000000000004`
 *   和一个正确数字用同样认真的排版显示出来。所以这里重点钉三件事：
 *   ① **口径**（存储必须 1024 进制 —— 1000/1024 是有分歧的地方，代码表了态就要有测试兜着）；
 *   ② **温度的零点**（0 ℃ = 32 ℉ 而不是 0 ℉，按 factor 乘算会安静地错 32 度）；
 *   ③ **算不出来时返回 null 而不是 0 / NaN**（页面靠它区分"没填"与"填错了"）。
 */
import { describe, expect, it } from 'vitest';

import {
  convertUnit,
  findGroup,
  formatConvert,
  fromBase,
  parseUnitInput,
  toBase,
  UNIT_GROUPS,
  unitRatioText,
} from '../apps/mp/utils/unit-convert';

/** 取组；表结构本身坏了就直接炸，别让后面几十条断言"假装通过" */
const groupOf = (key: string) => {
  const g = findGroup(key);
  if (!g) throw new Error(`组「${key}」不存在`);
  return g;
};

/** 换算并取结果 —— 算不出就直接失败，而不是让 toBeCloseTo 拿到 undefined */
const v = (group: string, amount: number | string, from: string, to: string): number => {
  const out = convertUnit(group, amount, from, to);
  if (out === null) throw new Error(`${group}: ${amount} ${from}→${to} 换算不出结果`);
  return out;
};

describe('UNIT_GROUPS 的自证', () => {
  it('恰好 7 组，key、中文名与界面 chip 顺序完全一致', () => {
    expect(UNIT_GROUPS.map((g) => `${g.key}:${g.label}`)).toEqual([
      'length:长度',
      'weight:重量',
      'area:面积',
      'volume:容量',
      'storage:存储',
      'temperature:温度',
      'duration:时间',
    ]);
  });

  it('每组单位够用但不堆砌（5~9 个），组内 key 不重复、都有中文名', () => {
    for (const g of UNIT_GROUPS) {
      expect(g.units.length, `${g.key} 单位太少`).toBeGreaterThanOrEqual(5);
      expect(g.units.length, `${g.key} 单位太多`).toBeLessThanOrEqual(9);
      const keys = g.units.map((u) => u.key);
      expect(new Set(keys).size, `${g.key} 有重复单位`).toBe(keys.length);
      for (const u of g.units) expect(u.label, `${g.key}.${u.key} 缺名字`).not.toBe('');
    }
  });

  it('每组的默认单位对都真在该组里；线性组的基准单位 factor 恰为 1', () => {
    for (const g of UNIT_GROUPS) {
      for (const key of g.defaults) {
        expect(g.units.some((u) => u.key === key), `${g.key} 的默认单位 ${key} 不在组里`).toBe(
          true,
        );
      }
      if (g.key === 'temperature') continue;
      const base = g.units.find((u) => u.key === g.baseKey);
      expect(base?.factor, `${g.key} 的基准单位 ${g.baseKey} 不是 1`).toBe(1);
    }
  });

  it('⭐ 存储是 1024 进制，不是硬盘厂商那套 1000', () => {
    const f = Object.fromEntries(groupOf('storage').units.map((u) => [u.key, u.factor]));
    expect(f).toEqual({
      b: 1,
      kb: 1024,
      mb: 1024 ** 2,
      gb: 1024 ** 3,
      tb: 1024 ** 4,
      pb: 1024 ** 5,
    });
    expect(f.gb).not.toBe(1000 ** 3);
  });

  it('温度的 factor 只是"每度步长（折成 K）"，不是倍数', () => {
    const f = Object.fromEntries(groupOf('temperature').units.map((u) => [u.key, u.factor]));
    expect(f.c).toBe(1);
    expect(f.k).toBe(1);
    expect(f.f).toBeCloseTo(5 / 9, 12);
    expect(f.r).toBeCloseTo(5 / 9, 12);
    expect(f.re).toBeCloseTo(5 / 4, 12);
  });
});

describe('convertUnit · 线性组', () => {
  it('长度：米↔厘米、公里→米、英尺↔英寸=12、英寸→厘米=2.54', () => {
    expect(v('length', 1, 'm', 'cm')).toBe(100);
    expect(v('length', 1, 'cm', 'm')).toBe(0.01);
    expect(v('length', 3, 'km', 'm')).toBe(3000);
    expect(v('length', 1, 'ft', 'in')).toBeCloseTo(12, 9);
    expect(v('length', 1, 'in', 'cm')).toBe(2.54);
    expect(v('length', 1, 'mile', 'km')).toBe(1.609344);
    expect(v('length', 100, 'mm', 'cm')).toBe(10);
  });

  it('重量：千克→斤=2、斤→两=10、吨→克、磅→千克', () => {
    expect(v('weight', 1, 'kg', 'jin')).toBe(2);
    expect(v('weight', 1, 'jin', 'liang')).toBe(10);
    expect(v('weight', 1, 't', 'g')).toBe(1000000);
    expect(v('weight', 1, 'lb', 'kg')).toBe(0.45359237);
    expect(v('weight', 500, 'g', 'kg')).toBe(0.5);
  });

  it('面积：公顷→亩 = 15（亩按 10000/15 定义，不写截断小数）', () => {
    expect(v('area', 1, 'ha', 'mu')).toBe(15);
    expect(v('area', 1, 'mu', 'm2')).toBeCloseTo(10000 / 15, 6);
    expect(v('area', 1, 'm2', 'dm2')).toBe(100);
    expect(v('area', 1, 'km2', 'ha')).toBe(100);
  });

  it('容量：立方米→升=1000，且 1 立方厘米 = 1 毫升', () => {
    expect(v('volume', 1, 'm3', 'l')).toBe(1000);
    expect(v('volume', 1, 'l', 'ml')).toBe(1000);
    expect(v('volume', 1, 'cm3', 'ml')).toBe(1);
    expect(v('volume', 1, 'gal', 'l')).toBe(3.785411784);
  });

  it('⭐ 存储：1 GB = 1024 MB = 1073741824 字节', () => {
    expect(v('storage', 1, 'gb', 'mb')).toBe(1024);
    expect(v('storage', 1, 'gb', 'b')).toBe(1073741824);
    expect(v('storage', 1, 'kb', 'b')).toBe(1024);
    expect(v('storage', 1, 'tb', 'gb')).toBe(1024);
    expect(v('storage', 2, 'mb', 'kb')).toBe(2048);
    expect(v('storage', 1, 'pb', 'tb')).toBe(1024);
  });

  it('时间：周→天=7、小时→秒=3600、分钟→毫秒=60000', () => {
    expect(v('duration', 1, 'wk', 'd')).toBe(7);
    expect(v('duration', 1, 'h', 's')).toBe(3600);
    expect(v('duration', 1, 'min', 'ms')).toBe(60000);
  });

  it('同单位恒等 —— 遍历七组的每一个单位换算到自己都得原值', () => {
    for (const g of UNIT_GROUPS) {
      for (const u of g.units) {
        expect(v(g.key, 7.5, u.key, u.key), `${g.key}.${u.key}`).toBeCloseTo(7.5, 9);
      }
    }
  });

  it('零与负数照算', () => {
    expect(v('length', 0, 'm', 'cm')).toBe(0);
    expect(v('length', -5, 'm', 'cm')).toBe(-500);
  });

  it('字符串输入也接：带空格、千分位、小数', () => {
    expect(v('storage', '1,024', 'kb', 'b')).toBe(1048576);
    expect(v('length', ' 2.5 ', 'm', 'cm')).toBe(250);
    expect(v('weight', '0.5', 'kg', 'g')).toBe(500);
  });
});

describe('convertUnit · 温度（非线性，走 toBase / fromBase）', () => {
  it('⭐ 边界值：0℃=32℉、100℃=212℉、-40℃=-40℉、0K=-273.15℃', () => {
    expect(v('temperature', 0, 'c', 'f')).toBe(32);
    expect(v('temperature', 100, 'c', 'f')).toBe(212);
    expect(v('temperature', -40, 'c', 'f')).toBe(-40);
    expect(v('temperature', 0, 'k', 'c')).toBeCloseTo(-273.15, 6);
  });

  it('开尔文是中间量：0℃=273.15K、0K=-459.67℉、0℃=491.67°R、100℃=80 列氏', () => {
    expect(v('temperature', 0, 'c', 'k')).toBeCloseTo(273.15, 6);
    expect(v('temperature', 0, 'k', 'f')).toBeCloseTo(-459.67, 6);
    expect(v('temperature', 0, 'c', 'r')).toBeCloseTo(491.67, 6);
    expect(v('temperature', 100, 'c', 're')).toBeCloseTo(80, 9);
  });

  it('⭐ 温度绝不能按 factor 乘算：那样 0℃ 会被算成 0℉', () => {
    expect(v('temperature', 0, 'c', 'f')).not.toBe(0);
    expect(v('temperature', 20, 'c', 'f')).toBeCloseTo(68, 9);
    expect(v('temperature', -273.15, 'c', 'k')).toBeCloseTo(0, 6);
  });

  it('来回换算回到原值（仿射的正逆必须成对）', () => {
    for (const t of [-273.15, -40, 0, 20, 37, 100, 1000]) {
      const f = v('temperature', t, 'c', 'f');
      expect(v('temperature', f, 'f', 'c'), String(t)).toBeCloseTo(t, 6);
      const k = v('temperature', t, 'c', 'k');
      expect(v('temperature', k, 'k', 'c'), String(t)).toBeCloseTo(t, 6);
    }
  });

  it('华氏与兰氏每度步长相同（零点不同），比值说的是"温差"', () => {
    expect(v('temperature', 0, 'k', 'r')).toBe(0);
    expect(v('temperature', 50, 'f', 'r')).toBeCloseTo(509.67, 6);
    expect(unitRatioText('temperature', 'f', 'r')).toBe('1 华氏度的温差 = 1 兰氏度');
  });
});

describe('convertUnit · 算不出来只返回 null（不抛错、不给 0）', () => {
  it('组不存在、单位拼错、单位跨组', () => {
    expect(convertUnit('lenght', 1, 'm', 'cm')).toBeNull();
    expect(convertUnit('length', 1, 'm', 'cms')).toBeNull();
    expect(convertUnit('length', 1, 'nope', 'cm')).toBeNull();
    // 重量组的"千克"拿去长度组用 —— 必须判 null，而不是错着算下去
    expect(convertUnit('length', 1, 'kg', 'cm')).toBeNull();
    expect(convertUnit('volume', 1, 'm2', 'l')).toBeNull();
  });

  it('空值、非数字、NaN、Infinity', () => {
    for (const bad of ['', '   ', 'abc', '1.2.3', '-', '1e', '0x', '12,5', '5%']) {
      expect(convertUnit('length', bad, 'm', 'cm'), `「${bad}」应当被拒绝`).toBeNull();
    }
    expect(convertUnit('length', Number.NaN, 'm', 'cm')).toBeNull();
    expect(convertUnit('length', Number.POSITIVE_INFINITY, 'm', 'cm')).toBeNull();
  });

  it('parseUnitInput：区分"没填"与"填错了"，并接受千分位', () => {
    expect(parseUnitInput('')).toBeNull();
    expect(parseUnitInput('  ')).toBeNull();
    expect(parseUnitInput('0')).toBe(0);
    expect(parseUnitInput('-40')).toBe(-40);
    expect(parseUnitInput(' 2.5 ')).toBe(2.5);
    expect(parseUnitInput('1,024,576')).toBe(1024576);
    // 把逗号当小数点用的写法不猜，直接判非法（猜错就是 1.5 变 15）
    expect(parseUnitInput('1,5')).toBeNull();
    expect(parseUnitInput('abc')).toBeNull();
    expect(parseUnitInput(Number.NaN)).toBeNull();
  });

  it('toBase / fromBase 单独可用（温度的基准量是开尔文）', () => {
    expect(toBase('length', 'm', 2)).toBe(2);
    expect(toBase('storage', 'kb', 2)).toBe(2048);
    expect(toBase('temperature', 'c', 0)).toBeCloseTo(273.15, 6);
    expect(fromBase('temperature', 'c', 273.15)).toBeCloseTo(0, 6);
    expect(fromBase('length', 'm', 2)).toBe(2);
    expect(toBase('length', 'kg', 1)).toBeNull();
    expect(fromBase('nope', 'm', 1)).toBeNull();
    expect(toBase('length', 'm', Number.NaN)).toBeNull();
  });
});

describe('formatConvert', () => {
  it('⭐ 去掉浮点噪声与尾随零', () => {
    expect(formatConvert(0.1 + 0.2)).toBe('0.3');
    expect(formatConvert(0.30000000000000004)).toBe('0.3');
    // 英尺→英寸的真实值是 12.000000000000002，界面上必须是"12"
    expect(formatConvert(v('length', 1, 'ft', 'in'))).toBe('12');
    expect(formatConvert(2.54)).toBe('2.54');
    expect(formatConvert(100)).toBe('100');
    expect(formatConvert(0.01)).toBe('0.01');
  });

  it('最多 6 位小数', () => {
    expect(formatConvert(1 / 3)).toBe('0.333333');
    expect(formatConvert(10000 / 15)).toBe('666.666667');
  });

  it('极大 / 极小走科学计数法并剪尾零；1e12 之内仍给完整数字', () => {
    expect(formatConvert(1024 ** 5)).toBe('1.1259e+15');
    expect(formatConvert(1e13)).toBe('1e+13');
    expect(formatConvert(1e-9)).toBe('1e-9');
    expect(formatConvert(1.5e-8)).toBe('1.5e-8');
    expect(formatConvert(-0.0000001)).toBe('-1e-7');
    // 容量换算最常停在十亿位，写成 1.073742e+9 反而没人看得懂
    expect(formatConvert(1073741824)).toBe('1073741824');
  });

  it('零、负零与非有限数', () => {
    expect(formatConvert(0)).toBe('0');
    expect(formatConvert(-0)).toBe('0');
    expect(formatConvert(Number.NaN)).toBe('');
    expect(formatConvert(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('unitRatioText', () => {
  it('⭐ 只说正数方向：反过来问也得到"1 米 = 100 厘米"', () => {
    expect(unitRatioText('length', 'm', 'cm')).toBe('1 米 = 100 厘米');
    expect(unitRatioText('length', 'cm', 'm')).toBe('1 米 = 100 厘米');
    expect(unitRatioText('length', 'in', 'cm')).toBe('1 英寸 = 2.54 厘米');
    expect(unitRatioText('length', 'cm', 'in')).toBe('1 英寸 = 2.54 厘米');
    expect(unitRatioText('length', 'ft', 'in')).toBe('1 英尺 = 12 英寸');
    expect(unitRatioText('weight', 'kg', 'jin')).toBe('1 千克 = 2 斤');
    expect(unitRatioText('weight', 'jin', 'kg')).toBe('1 千克 = 2 斤');
    expect(unitRatioText('storage', 'b', 'gb')).toBe('1 GB = 1073741824 字节');
    expect(unitRatioText('duration', 'h', 'min')).toBe('1 小时 = 60 分钟');
  });

  it('精确的写 =，除不尽的写 ≈', () => {
    expect(unitRatioText('area', 'm2', 'mu')).toBe('1 亩 ≈ 666.666667 平方米');
    expect(unitRatioText('weight', 'kg', 'lb')).toBe('1 千克 ≈ 2.204623 磅');
    expect(unitRatioText('area', 'ha', 'mu')).toBe('1 公顷 = 15 亩');
  });

  it('⭐ 温度只能说"温差"，否则会被读成数值相等（20℃ 其实是 68℉）', () => {
    expect(unitRatioText('temperature', 'c', 'f')).toBe('1 摄氏度的温差 = 1.8 华氏度');
    expect(unitRatioText('temperature', 'f', 'c')).toBe('1 摄氏度的温差 = 1.8 华氏度');
    expect(unitRatioText('temperature', 'k', 'c')).toBe('1 开尔文的温差 = 1 摄氏度');
  });

  it('同一单位给一句话，非法输入给空串而不是抛错', () => {
    expect(unitRatioText('length', 'm', 'm')).toContain('同一个单位');
    expect(unitRatioText('nope', 'm', 'cm')).toBe('');
    expect(unitRatioText('length', 'm', 'kg')).toBe('');
  });
});
