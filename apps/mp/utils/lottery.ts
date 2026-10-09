/**
 * 抽签 / 点名 / 随机分组（纯函数，不依赖 wx API）
 *
 * ## 为什么放在小程序侧而不是 `packages/core`
 *
 * 与 `utils/gpa.ts` / `utils/split-bill.ts` 同一条约束：**小程序不能 `import @qz/core`**
 * （`project.config.json` 的 `packNpmRelationList` 是空的，开发者工具解析不到）。
 * 放进 core 只会得到一份零调用方的悬空实现。
 *
 * ## 一、随机源必须**可注入**，且默认走密码学随机
 *
 * 抽签是"错了也看不出来"的典型：用 `Math.random` 抽出来的结果**看起来完全正常**，
 * 但它可被预测、可被复现（同一状态序列能重放）。在"点名""分宿舍""抽奖"这类
 * 有利益关系的场景里，这是真实缺陷，而不是洁癖。
 *
 * 所以算法**不自己取随机数** —— 一律由调用方传入 `RandomFn`：
 *   · 页面侧优先用 `wx.getRandomValues`（密码学强度）构造随机源；
 *   · 取不到时降级到 `Math.random`，但把 `strong = false` **如实带到界面上**，
 *     不假装"反正都是随机的"；
 *   · 单测侧注入确定性序列，于是"同样随机源 → 同样结果"可以被断言。
 *
 * ## 二、洗牌必须用 Fisher-Yates，**不能** `sort(() => rand() - 0.5)`
 *
 * 后者不是"随机排序"：它依赖比较器的调用顺序，不同 JS 引擎结果不同，
 * 而且分布**有偏** —— 某些元素被排到前面的概率显著更高。
 * 最坏的地方是它**永远不报错**，抽签结果看上去毫无异样。
 *
 * ## 三、取模偏差要用拒绝采样消除
 *
 * `u32 % n` 在 n 不整除 2^32 时，前 `2^32 mod n` 个下标会多出一次机会。
 * n 小时偏差很小，但"抽签公平"是这一页的**唯一卖点**，没有理由在这里将就。
 * `randomInt` 因此采用拒绝采样，并给重抽次数设上限
 * （防止随机源被注入成"永远落在拒绝区"的常量时把页面挂住）。
 *
 * ## 四、不承诺"公平"以外的东西
 *
 * 分组只保证**人数尽量平均**（轮转发牌，组间人数差恒 ≤ 1），
 * **不保证**性别 / 宿舍 / 成绩等任何维度的均衡 —— 算法不知道这些维度。
 * 界面上也不写"最优分组"这类我们保证不了的话。
 */

/**
 * 随机源：返回 **[0, 2^32)** 的整数。
 *
 * ⚠️ 刻意不是 `[0, 1)` 浮点：拒绝采样需要"原始整数 + 已知值域"才能正确判断
 * 拒绝区间。用浮点做 `% n` 是错的，用浮点做拒绝采样也无法表达边界。
 */
export type RandomFn = () => number;

/** 2^32 */
const U32 = 4294967296;

/** 拒绝采样的重抽上限：随机源被注入成常量时，宁可兜底也不要死循环 */
const MAX_REJECT = 64;

/**
 * 降级随机源。
 *
 * `Math.random` 有 53 位精度，乘 2^32 取整后仍是均匀的 uint32，
 * 但它**可预测**（PRNG，状态可被推断、序列可被重放），
 * 所以它对应的 `strong` 永远是 `false` —— 调用方必须在界面上如实说明。
 */
export const weakRandom: RandomFn = (): number => Math.floor(Math.random() * U32);

/** 小端读一个 uint32 */
function readU32(bytes: Uint8Array, i: number): number {
  return (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
}

/**
 * 从字节构造随机源（每 4 字节拼一个小端 uint32）。
 *
 * 页面把 `wx.getRandomValues` 拿到的 `ArrayBuffer` 交给它 ——
 * 于是**算法侧完全不碰 wx API**，可以在 Node 里直接单测。
 *
 * ⚠️ 字节用尽后**从头重放**。这会让同一批字节被用第二遍，严格说降低了随机性；
 * 代价换来的是"绝不返回常量"（返回常量才是真正会毁掉抽签的那种错）。
 * 页面侧按 `8 字节 × 人数` 取字节，实测远早于用尽就出结果了。
 */
export function randomFromBytes(bytes: Uint8Array): RandomFn {
  let i = 0;
  return (): number => {
    if (bytes.length < 4) return weakRandom();
    if (i + 4 > bytes.length) i = 0;
    const v = readU32(bytes, i);
    i += 4;
    return v;
  };
}

/**
 * `[0, n)` 上的均匀整数（拒绝采样，见文件头第三节）。
 *
 * `n <= 1` 直接返回 0 —— 抽签场景里"从 1 个人里抽 1 个"是合法输入，不该报错。
 */
export function randomInt(rand: RandomFn, n: number): number {
  const bound = Math.floor(n);
  if (!Number.isFinite(bound) || bound <= 1) return 0;

  // 大于等于 limit 的取值会让 `% bound` 出现偏差，落在这一段的样本一律丢弃
  const limit = Math.floor(U32 / bound) * bound;
  for (let i = 0; i < MAX_REJECT; i += 1) {
    const v = Math.floor(rand());
    if (v >= 0 && v < U32 && v < limit) return v % bound;
  }
  // 兜底：随机源异常（常量 / 越界）时给一个合法下标，绝不返回 NaN 或挂住页面
  return Math.abs(Math.floor(rand())) % bound;
}

/**
 * Fisher-Yates 洗牌（返回新数组，不改入参）。
 *
 * 从后往前，每次在 `[0, i]` 里等概率挑一个换到位置 i。
 * 每一步的概率都由 `randomInt` 保证均匀，因此**每个排列等概率**。
 */
export function shuffle<T>(items: readonly T[], rand: RandomFn): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(rand, i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** 名单解析结果 */
export interface RosterParse {
  /** 去重、去空行后的名字（保持粘贴顺序） */
  names: string[];
  /** 被去重丢掉的名字（保留首次出现） */
  duplicates: string[];
  /** 空行数 */
  blankLines: number;
}

/**
 * 行首序号：`1.` `1、` `1)` `1]` `1．`
 *
 * 从 Excel、学号表、聊天记录里粘贴名单时**几乎必然带序号**。
 * ⚠️ 只吃行首：名字中间的字符一个都不动（"李三 3"要原样保留）。
 */
const LEADING_INDEX = /^\d+\s*[.、)\]．]\s*/;

/** 一行文本 → 干净的名字；空行返回 `''` */
export function cleanName(raw: string): string {
  const s = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  return s.replace(LEADING_INDEX, '').trim();
}

/**
 * 解析粘贴进来的名单：**一行一个名字**。
 *
 * · 空行直接忽略（粘贴的文本结尾几乎总带一个换行）；
 * · 重名**保留首次出现**，其余计入 `duplicates` —— 由界面如实告诉用户
 *   "忽略了 2 个重名"，而不是悄悄合并（用户更可能是把同一份名单粘了两遍，
 *   而重名会让这个人在抽签里被抽中的概率翻倍，属于必须说出来的一种偏差）。
 */
export function parseRoster(text: string): RosterParse {
  const names: string[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  let blankLines = 0;

  for (const line of String(text ?? '').split(/\r?\n/)) {
    const name = cleanName(line);
    if (!name) {
      blankLines += 1;
      continue;
    }
    if (seen.has(name)) {
      duplicates.push(name);
      continue;
    }
    seen.add(name);
    names.push(name);
  }

  return { names, duplicates, blankLines };
}

/** 抽签结果 */
export interface DrawResult {
  /** 抽中的人（按抽出的先后顺序） */
  picked: string[];
  /** 还有多少人从没被抽中过（"不重复点名"模式下才有意义） */
  remaining: number;
  /** 空串表示正常；非空表示**输入有问题，`picked` 不可用** */
  error: string;
}

/**
 * 从名单里抽 `count` 个**互不重复**的人。
 *
 * `exclude` 是已经抽中过的人（"不重复点名"用），先从候选池剔除。
 *
 * ⚠️ 候选不够时**报错，而不是少给几个**：
 * "要抽 5 个却只给了 3 个"在界面上看起来像抽签成功了，
 * 实际漏了两个人 —— 这是最容易蒙混过去的一类错。
 */
export function draw(
  names: readonly string[],
  count: number,
  rand: RandomFn,
  exclude: readonly string[] = [],
): DrawResult {
  const gone = new Set(exclude);
  const pool = names.filter((n) => !gone.has(n));
  const n = Math.floor(count);

  if (!pool.length) {
    return { picked: [], remaining: 0, error: '名单里的人都已经抽过了，先重置再来一轮' };
  }
  if (!Number.isFinite(n) || n < 1) {
    return { picked: [], remaining: pool.length, error: '要抽几个人？至少 1 个' };
  }
  if (n > pool.length) {
    return {
      picked: [],
      remaining: pool.length,
      error: `只剩 ${pool.length} 个人没抽过，抽不了 ${n} 个`,
    };
  }

  const picked = shuffle(pool, rand).slice(0, n);
  return { picked, remaining: pool.length - n, error: '' };
}

/** 分组结果 */
export interface GroupResult {
  groups: string[][];
  error: string;
}

/**
 * 把名单随机分成 `groupCount` 组。
 *
 * 做法：洗牌后**轮转发牌**（第 i 个人进第 `i % k` 组）。
 * 这样组间人数差恒 ≤ 1，且不必为"除不尽"写特例 ——
 * 5 人分 2 组得到 3 + 2，7 人分 3 组得到 3 + 2 + 2。
 *
 * ⚠️ 只保证人数尽量平均，**不保证任何维度上的均衡**（性别、宿舍、成绩…）。
 */
export function groupInto(names: readonly string[], groupCount: number, rand: RandomFn): GroupResult {
  const k = Math.floor(groupCount);

  if (!names.length) return { groups: [], error: '名单还是空的，先填几个人' };
  if (!Number.isFinite(k) || k < 1) return { groups: [], error: '分几组？至少 1 组' };
  if (k > names.length) {
    return { groups: [], error: `${names.length} 个人分不成 ${k} 组，每组至少要 1 人` };
  }

  const groups: string[][] = Array.from({ length: k }, () => []);
  shuffle(names, rand).forEach((name, i) => groups[i % k].push(name));
  return { groups, error: '' };
}

/** 抽签结果的分享文案（一行一个，方便直接粘到群里） */
export function formatDrawText(picked: readonly string[]): string {
  return picked.join('\n');
}

/** 分组结果的分享文案（每组一段） */
export function formatGroupText(groups: readonly (readonly string[])[]): string {
  return groups.map((g, i) => `第 ${i + 1} 组：${g.join('、')}`).join('\n');
}
