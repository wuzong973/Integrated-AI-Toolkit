/**
 * 文档切片（M4-06 校园知识库 RAG 的第一步）
 *
 * ## 为什么切片质量决定检索质量
 *
 * 向量检索的单位是**切片**，不是文档。切得太碎 → 一条完整规则被拆成几段，
 * 检索到的那段没有上下文，模型答不完整；切得太粗 → 一个切片里混着好几条不相干的
 * 规定，向量被"平均"掉，检索命中率下降。
 *
 * 所以这里做两件事：**按语义边界切**、**相邻切片留重叠**。
 *
 * ## 为什么单独成文件
 *
 * 它是纯函数（输入字符串 → 输出切片数组），不依赖 Prisma / Provider，
 * 因此可以被单测直接打靶 —— 而"切坏了"这件事在接口层很难发现：
 * 接口会正常返回、向量会正常写入，只是检索结果变差。
 */

/** 一个切片 */
export interface KnowledgeChunk {
  /** 在文档中的序号（从 0 开始），用于引用定位 */
  index: number;
  text: string;
}

/**
 * 单篇文档的切片数上限。
 *
 * 400 片 × 约 500 字 ≈ 20 万字，与 `KnowledgeIngestSchema` 的正文字数上限对应。
 * 设上限是为了防止一篇超长文档一次打出几百次 embedding 请求 ——
 * 那会超时、也会把当月额度吃掉一大块，而用户只看到"一直在转圈"。
 */
export const MAX_CHUNKS_PER_DOC = 400;

/** 优先断句的边界字符（中文标点 + 换行 + 英文句点） */
const BOUNDARY = /[\n。！？；!?;]|\.\s/;

/**
 * 把长文切成带重叠的切片。
 *
 * @param raw   原文
 * @param size  单切片目标字符数
 * @param overlap 相邻切片重叠字符数（防止一句话正好被切断）
 */
export function chunkText(raw: string, size: number, overlap: number): KnowledgeChunk[] {
  const text = normalize(raw);
  if (!text) return [];

  const safeSize = Math.max(1, size);
  if (text.length <= safeSize) return [{ index: 0, text }];

  // 重叠不能大于等于切片长度，否则窗口不前进 → 死循环
  const safeOverlap = Math.max(0, Math.min(overlap, safeSize - 1));
  const chunks: KnowledgeChunk[] = [];
  let start = 0;

  while (start < text.length && chunks.length < MAX_CHUNKS_PER_DOC) {
    const hardEnd = Math.min(start + safeSize, text.length);
    // 最后一刀直接切到底，不必再找边界
    const end = hardEnd >= text.length ? hardEnd : preferBoundary(text, start, hardEnd);

    const piece = text.slice(start, end).trim();
    if (piece) chunks.push({ index: chunks.length, text: piece });
    if (end >= text.length) break;

    // 至少前进 1 个字符：这是"不产生死循环"的硬保证
    start = Math.max(end - safeOverlap, start + 1);
  }

  return chunks;
}

/**
 * 在 `[start, hardEnd)` 区间内尽量找一个语义边界，返回切点。
 *
 * 只在窗口**尾部** 1/3 处回看 —— 如果允许从任意位置断句，
 * 一个很短的自然段会让切片变得极短（甚至只有一个字），
 * 反而破坏了"每个切片都有足够上下文"的目标。
 */
function preferBoundary(text: string, start: number, hardEnd: number): number {
  const lookback = Math.max(1, Math.floor((hardEnd - start) / 3));
  const from = hardEnd - lookback;
  const window = text.slice(from, hardEnd);

  for (let i = window.length - 1; i >= 0; i--) {
    if (BOUNDARY.test(window[i] as string)) {
      const cut = from + i + 1;
      // 切点必须严格前进，否则窗口不移动
      if (cut > start) return cut;
    }
  }
  return hardEnd;
}

/**
 * 归一化原文。
 *
 * · `\r\n` → `\n`：本仓库文件是 CRLF，从文件读来的正文会带 `\r`，
 *   而 `\r` 混进向量库里会让"看起来一样的文本"算出不同的向量；
 * · 连续空行压成两行：Word/网页复制来的正文常有大量空行，它们会白白占掉切片预算。
 */
function normalize(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
