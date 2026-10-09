/**
 * 四选一的选项生成（**纯函数**，无 IO —— 因为它必须是可测的）
 *
 * ## 为什么必须"确定性"
 *
 * 出题（`GET /vocab/today`）与判卷（`POST /vocab/answer`）是**两次独立调用**，
 * 而答案只在服务端算 —— 出题时不把正确项发给客户端（否则抓包一看就知道选哪个）。
 * 于是判卷时必须能算出与出题时**完全相同**的一组选项与正确项。
 *
 * 若这里用 `Math.random()`：判卷会算出另一个正确答案，表现为
 * 「明明选对了却判错」，而且刷新一下页面答案又变了 —— 这类 bug 极难复现。
 * 所以洗牌用「以词 id 为种子」的确定性哈希：同一个词，永远得到同一组选项。
 *
 * ## 为什么干扰项来自同一本词书
 *
 * 拿别的词书的词做干扰项，会出现"四个选项难度差一大截"——一眼就能选出答案，
 * 答对了也学不到东西。同词书的词难度接近，才是真的在辨析。
 */

/** 选项 key：四个选项渲染时各拿一个（也是客户端提交的值） */
export const OPTION_KEYS = ['a', 'b', 'c', 'd'] as const;
export type OptionKey = (typeof OPTION_KEYS)[number];

/** 一个候选（干扰项池 / 正确项都长这样） */
export interface OptionSource {
  id: string;
  /** 展示文本（取第一个义项） */
  text: string;
}

export interface BuiltOptions {
  options: { key: OptionKey; text: string }[];
  /** 正确项对应的 key —— 只有服务端知道，不下发给客户端 */
  answerKey: OptionKey;
}

/**
 * FNV-1a 32 位哈希。
 *
 * 选它是因为：跨进程/跨重启结果一致（不像 `Math.random`）、
 * 实现只有几行（不必引依赖 —— 引 md5/sha 只为洗牌是杀鸡用牛刀）、
 * 且分布足够均匀（模 4 的偏差在实际词量下看不出来）。
 */
export function seedHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 按 `种子串` 升序排 —— 固定输入必得固定顺序（`sort` 需全序，故再按 id 兜底比一次） */
function bySeed(seed: string, a: OptionSource, b: OptionSource): number {
  const d = seedHash(`${seed}|${a.id}`) - seedHash(`${seed}|${b.id}`);
  return d !== 0 ? d : a.id.localeCompare(b.id);
}

/**
 * 挑 3 个干扰项。
 *
 * 两处刻意的处理：
 *   ① **按文本去重**：同一个释义出现两次，用户看到两个一模一样的选项，
 *      那题等于白送（而且是"看起来像界面 bug"的那种白送）。
 *      释义重复在真实词表里很常见（近义词的释义写法雷同）。
 *   ② 池子不够 3 个就**给几个算几个**：不编造选项。
 *      词书刚建、只有两三个词时，选项少一个是如实的降级，
 *      硬凑一个假释义写进题面才是真错。
 */
export function pickDistractors(correct: OptionSource, pool: OptionSource[], count = 3): OptionSource[] {
  const seen = new Set([correct.text]);
  const out: OptionSource[] = [];
  for (const item of [...pool].sort((a, b) => bySeed(correct.id, a, b))) {
    if (item.id === correct.id || seen.has(item.text)) continue;
    seen.add(item.text);
    out.push(item);
    if (out.length >= count) break;
  }
  return out;
}

/**
 * 组装一道四选一。
 *
 * 正确项也参与洗牌（位置同样由种子决定）—— 否则正确答案永远是 a，
 * 用户按三次 a 就能"全对"，复习记录就全是噪声。
 */
export function buildOptions(correct: OptionSource, pool: OptionSource[], count = 3): BuiltOptions {
  const all = [correct, ...pickDistractors(correct, pool, count)].sort((a, b) =>
    bySeed(`order:${correct.id}`, a, b),
  );
  const options = all.map((item, i) => ({ key: OPTION_KEYS[i] ?? 'd', text: item.text }));
  const answerIndex = all.findIndex((item) => item.id === correct.id);
  return { options, answerKey: OPTION_KEYS[answerIndex < 0 ? 0 : answerIndex] ?? 'a' };
}

/** 从库里的 `senses` JSON 取出"题面用的那个释义"（第一个义项） */
export function primaryMeaning(senses: unknown): string {
  if (!Array.isArray(senses)) return '';
  for (const raw of senses) {
    const meaning = (raw as { meaning?: unknown })?.meaning;
    if (typeof meaning === 'string' && meaning.trim()) return meaning.trim();
  }
  return '';
}