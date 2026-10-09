/**
 * 单位换算（纯函数，不依赖 wx API）
 *
 * ## 为什么自包含在这里，而不是 `packages/core`
 *
 * ⚠️ **小程序不能 `import '@qz/core'`** —— 微信开发者工具解析不到（要"构建 npm"，
 * 而 `project.config.json` 的 `packNpmRelationList` 是空的）。与 `utils/gpa.ts` 同一条约束。
 * 所以本文件**零 import、零依赖**，纯 Node 可测（`tests/unit-convert.spec.ts`）。
 *
 * ## 口径先说清楚，别让用户猜
 *
 * · 每组都有一个**基准单位**（长度=米、重量=千克、面积=平方米、容量=升、存储=字节、时间=秒），
 *   单位只描述"1 个该单位等于多少基准单位"（`factor`）；
 * · 换算只做**一次乘除**（`值 × from.factor ÷ to.factor`），不链式跳几跳，误差最小；
 * · **存储用 1024 进制**：1 KB = 1024 字节。这是**有分歧的口径** ——
 *   SI / 硬盘厂商按 1000（1 GB = 10 亿字节，所以"1 GB 的盘"在电脑里显示不足 1 GB），
 *   操作系统 / 文件属性按 1024。这里**表态选 1024**，因为"换算容量"几乎都发生在看设备；
 *   要另一口径请把 `BINARY` 换成 1000，但**不要两种混着显示**。
 * · **温度是例外**：见下面的 `TEMP_FORMULAS` —— 它不走 factor 乘算。
 */

/** 七组类别（顺序即界面 chip 顺序） */
export type UnitGroupKey =
  | 'length'
  | 'weight'
  | 'area'
  | 'volume'
  | 'storage'
  | 'temperature'
  | 'duration';

export interface UnitDef {
  readonly key: string;
  /** 界面显示名 */
  readonly label: string;
  /**
   * 1 个该单位 = 多少基准单位。
   *
   * ⚠️ 温度组的 `factor` 是**每度的步长**（1 ℃ 温差 = 1 K、1 ℉ 温差 = 5/9 K），
   * 只给"温差说明"用；温度的数值换算**绝不乘它**（见 `baseOf`）。
   */
  readonly factor: number;
}

export interface UnitGroupDef {
  readonly key: UnitGroupKey;
  readonly label: string;
  /** 基准单位的 key（也就是该组里 factor = 1 的那一个） */
  readonly baseKey: string;
  /** 默认源/目标单位：切组别时重置成这一对（该组最常用的一次换算） */
  readonly defaults: readonly [string, string];
  readonly units: readonly UnitDef[];
}

/** 存储的进制：见文件头"1024 还是 1000"那条表态 */
const BINARY = 1024;

/** 构造一个单位，省掉表里重复的字段名 */
const unit = (key: string, label: string, factor: number): UnitDef => ({ key, label, factor });

/**
 * 换算矩阵。
 *
 * ⚠️ `亩` 写成 `10000 / 15` 而不是截断小数（1 公顷 = 15 亩 是定义）——
 * 写成 666.67 会让"1 亩 = 60 平方丈"这类核对差出零点几平方米。
 */
export const UNIT_GROUPS: readonly UnitGroupDef[] = [
  {
    key: 'length',
    label: '长度',
    baseKey: 'm',
    defaults: ['m', 'cm'],
    units: [
      unit('mm', '毫米', 0.001),
      unit('cm', '厘米', 0.01),
      unit('dm', '分米', 0.1),
      unit('m', '米', 1),
      unit('km', '公里', 1000),
      unit('in', '英寸', 0.0254),
      unit('ft', '英尺', 0.3048),
      unit('mile', '英里', 1609.344),
    ],
  },
  {
    key: 'weight',
    label: '重量',
    baseKey: 'kg',
    defaults: ['kg', 'jin'],
    units: [
      unit('mg', '毫克', 0.000001),
      unit('g', '克', 0.001),
      unit('kg', '千克', 1),
      unit('t', '吨', 1000),
      unit('jin', '斤', 0.5),
      unit('liang', '两', 0.05),
      unit('lb', '磅', 0.45359237),
    ],
  },
  {
    key: 'area',
    label: '面积',
    baseKey: 'm2',
    defaults: ['m2', 'mu'],
    units: [
      unit('cm2', '平方厘米', 0.0001),
      unit('dm2', '平方分米', 0.01),
      unit('m2', '平方米', 1),
      unit('mu', '亩', 10000 / 15),
      unit('ha', '公顷', 10000),
      unit('km2', '平方公里', 1000000),
    ],
  },
  {
    key: 'volume',
    label: '容量',
    baseKey: 'l',
    defaults: ['l', 'ml'],
    units: [
      unit('ml', '毫升', 0.001),
      unit('cm3', '立方厘米', 0.001),
      unit('l', '升', 1),
      unit('m3', '立方米', 1000),
      unit('gal', '美制加仑', 3.785411784),
      unit('igal', '英制加仑', 4.54609),
    ],
  },
  {
    key: 'storage',
    label: '存储',
    baseKey: 'b',
    defaults: ['mb', 'gb'],
    units: [
      unit('b', '字节', 1),
      unit('kb', 'KB', BINARY),
      unit('mb', 'MB', BINARY ** 2),
      unit('gb', 'GB', BINARY ** 3),
      unit('tb', 'TB', BINARY ** 4),
      unit('pb', 'PB', BINARY ** 5),
    ],
  },
  {
    key: 'temperature',
    label: '温度',
    baseKey: 'k',
    defaults: ['c', 'f'],
    /** factor 这里只是"每度步长（折成 K）"，见 `UnitDef.factor` 的警告 */
    units: [
      unit('c', '摄氏度', 1),
      unit('f', '华氏度', 5 / 9),
      unit('k', '开尔文', 1),
      unit('r', '兰氏度', 5 / 9),
      unit('re', '列氏度', 5 / 4),
    ],
  },
  {
    key: 'duration',
    label: '时间',
    baseKey: 's',
    defaults: ['h', 'min'],
    units: [
      unit('ms', '毫秒', 0.001),
      unit('s', '秒', 1),
      unit('min', '分钟', 60),
      unit('h', '小时', 3600),
      unit('d', '天', 86400),
      unit('wk', '周', 604800),
    ],
  },
];

/**
 * 温度的换算式（**仿射**：既有斜率又有零点）。
 *
 * 为什么温度不能和其他组一样乘 factor：摄氏 / 华氏 / 兰氏各自的"0 度"
 * 不是同一个物理状态（0 ℃ = 273.15 K、0 ℉ ≈ 255.37 K）。
 * 只乘系数的话，0 ℃ 会被算成 0 ℉ —— 差 32 度，而且**看起来像个正常结果**。
 * 所以温度只走这里的 `toK` / `fromK`，中间量统一取**开尔文**。
 *
 * 温度组只有 5 种刻度是有意为之：常用的是前三种，兰氏 / 列氏凑个常见工程口径，
 * 再多就是没人用的噪音。
 */
const ZERO_C_IN_K = 273.15;

interface TempScale {
  readonly toK: (v: number) => number;
  readonly fromK: (k: number) => number;
}

const TEMP_FORMULAS: Readonly<Record<string, TempScale>> = {
  c: { toK: (v) => v + ZERO_C_IN_K, fromK: (k) => k - ZERO_C_IN_K },
  f: { toK: (v) => ((v - 32) * 5) / 9 + ZERO_C_IN_K, fromK: (k) => ((k - ZERO_C_IN_K) * 9) / 5 + 32 },
  k: { toK: (v) => v, fromK: (k) => k },
  r: { toK: (v) => (v * 5) / 9, fromK: (k) => (k * 9) / 5 },
  re: { toK: (v) => (v * 5) / 4 + ZERO_C_IN_K, fromK: (k) => ((k - ZERO_C_IN_K) * 4) / 5 },
};

export function findGroup(group: string): UnitGroupDef | null {
  return UNIT_GROUPS.find((g) => g.key === group) ?? null;
}

export function findUnit(group: UnitGroupDef, key: string): UnitDef | null {
  return group.units.find((u) => u.key === key) ?? null;
}

/**
 * 把用户输入解析成一个数。
 *
 * 空 / 非数字 → `null`（不返回 0 —— 把"没填"当成 0 会显示一个煞有介事的结果）。
 * 允许 `1,024` 这种从文档里粘来的千分位写法，但**只在整体形如分组数字时**才去掉逗号，
 * 免得 `1,5`（有人当小数用）被悄悄读成 15。
 */
export function parseUnitInput(raw: string | number): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const plain = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text) ? text.replace(/,/g, '') : text;
  const n = Number(plain);
  return Number.isFinite(n) ? n : null;
}

/** 值 → 基准量（温度的基准量是开尔文）；单位不属于该组时为 NaN，由调用方收敛成 null */
function baseOf(g: UnitGroupDef, u: UnitDef, value: number): number {
  if (g.key === 'temperature') {
    const f = TEMP_FORMULAS[u.key];
    return f ? f.toK(value) : Number.NaN;
  }
  return value * u.factor;
}

/** 基准量 → 值 */
function outOf(g: UnitGroupDef, u: UnitDef, base: number): number {
  if (g.key === 'temperature') {
    const f = TEMP_FORMULAS[u.key];
    return f ? f.fromK(base) : Number.NaN;
  }
  return base / u.factor;
}

/** 换到该组的基准单位（线性组就是乘 factor，温度走公式） */
export function toBase(group: string, unitKey: string, value: number): number | null {
  const g = findGroup(group);
  if (!g) return null;
  const u = findUnit(g, unitKey);
  if (!u || !Number.isFinite(value)) return null;
  const base = baseOf(g, u, value);
  return Number.isFinite(base) ? base : null;
}

/** 从该组的基准单位换到指定单位 */
export function fromBase(group: string, unitKey: string, base: number): number | null {
  const g = findGroup(group);
  if (!g) return null;
  const u = findUnit(g, unitKey);
  if (!u || !Number.isFinite(base)) return null;
  const out = outOf(g, u, base);
  return Number.isFinite(out) ? out : null;
}

/**
 * 换算：`group` 组里把 `value`（可带单位字符串）从 `fromKey` 换到 `toKey`。
 *
 * 组不存在、单位不属于该组（**跨组拿 'm' 去重量组**也算）、值不是数字 ——
 * 一律返回 `null` 而不抛错：页面边打字边算，异常会把输入框卡死。
 */
export function convertUnit(
  group: string,
  value: number | string,
  fromKey: string,
  toKey: string,
): number | null {
  const num = parseUnitInput(value);
  if (num === null) return null;
  const base = toBase(group, fromKey, num);
  if (base === null) return null;
  return fromBase(group, toKey, base);
}

/** 最多保留几位小数（再多的位数是浮点噪声，不是信息） */
const MAX_DECIMALS = 6;
/** 绝对值到这两个界限之外改用科学计数法：一长串 0 与 0.000000 都不如 1.1259e+15 好读 */
const EXP_UP = 1e12;
const EXP_DOWN = 1e-6;

/** 科学计数法，并把尾数的多余零剪掉 */
function trimExponential(v: number): string {
  const [mantissa, exponent] = v.toExponential(MAX_DECIMALS).split('e');
  const trimmed = mantissa.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return `${trimmed}e${exponent}`;
}

/**
 * 可读输出：最多 6 位小数、去尾随零，极大/极小走科学计数法。
 *
 * 存在的理由就一个浮点例子：`0.1 + 0.2` 是 `0.30000000000000004`，
 * 直接 `String()` 出去，用户会以为换算精度只有十几位有效数字那么可疑。
 */
export function formatConvert(v: number): string {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= EXP_UP || abs < EXP_DOWN) return trimExponential(v);
  const fixed = Number(v.toFixed(MAX_DECIMALS));
  // 小于显示精度的值给 0，而不是 "-0"：负零在界面上看着像算错了
  return fixed === 0 ? '0' : String(fixed);
}

/**
 * 一句人话说明（"1 米 = 100 厘米"）。
 *
 * 两个刻意的取舍：
 *   ① **只说正数方向**：`1 厘米 = 0.01 米` 读起来别扭，而 `1 米 = 100 厘米` 一眼有用，
 *      所以比值小于 1 时把两端对调（`1 英寸 = 2.54 厘米` 同理，反过来说就成 0.393701 英寸）；
 *   ② **温度说"温差"**：温度的 factor 只是每度步长，说"1 摄氏度 = 1.8 华氏度"
 *      会被读成数值相等（其实 20 ℃ = 68 ℉），所以必须写成"1 摄氏度的温差"。
 *
 * 除不尽的（亩、千克↔磅）用 `≈`，不用 `=` —— 精确与近似要一眼分得开。
 */
export function unitRatioText(group: string, fromKey: string, toKey: string): string {
  const g = findGroup(group);
  if (!g) return '';
  const from = findUnit(g, fromKey);
  const to = findUnit(g, toKey);
  if (!from || !to) return '';
  if (from.key === to.key) return `同一个单位，数值不变（${from.label} 就是它自己）`;

  const direct = from.factor / to.factor;
  const flipped = direct < 1;
  const value = flipped ? to.factor / from.factor : direct;
  const a = flipped ? to : from;
  const b = flipped ? from : to;
  /**
   * 什么时候写 `=`：比值在 4 位小数内就收得住（1.8、12、1000），
   * 写 `=` 才不刺眼；收不住的（亩 666.666…、千克→磅 2.2046…）必须写 `≈`。
   *
   * ⚠️ 判据不能只问"是不是整数" —— 第一版就是这样，于是
   * `1 摄氏度的温差 ≈ 1.8 华氏度`：**1.8 明明是精确值**，却被标成近似。
   * 顺带还得容忍 `0.3048 / 0.0254 = 12.000000000000002` 这种浮点噪声。
   */
  const short = Number(value.toFixed(4));
  const mark = Math.abs(value - short) < 1e-9 ? '=' : '≈';
  return `1 ${a.label}${g.key === 'temperature' ? '的温差' : ''} ${mark} ${formatConvert(value)} ${b.label}`;
}
