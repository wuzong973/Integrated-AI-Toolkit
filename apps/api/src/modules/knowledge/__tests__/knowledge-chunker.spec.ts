import { describe, expect, it } from 'vitest';

import { MAX_CHUNKS_PER_DOC, chunkText } from '../knowledge-chunker';

/**
 * 文档切片（M4-06 RAG 的第一步）
 *
 * 这一层"切坏了"在接口层几乎发现不了：接口正常返回、向量正常写入、
 * 检索也能给出结果 —— 只是答得不准。所以必须在纯函数层面把性质锁死：
 * **不丢字、不重复切、不死循环、序号连续**。
 */
describe('chunkText —— 基本切分', () => {
  it('空串 / 纯空白返回空数组（不产生空切片，空切片会让 embedding 白跑一次）', () => {
    expect(chunkText('', 100, 20)).toEqual([]);
    expect(chunkText('   \n\n  \t ', 100, 20)).toEqual([]);
  });

  it('短于切片长度时只有一片，且原文被 trim', () => {
    expect(chunkText('  校园卡补办流程。  ', 100, 20)).toEqual([
      { index: 0, text: '校园卡补办流程。' },
    ]);
  });

  it('正好等于切片长度时也只有一片（边界不能差一）', () => {
    const text = '甲'.repeat(100);
    expect(chunkText(text, 100, 20)).toHaveLength(1);
  });

  it('超长文本切成多片，序号从 0 连续递增', () => {
    const chunks = chunkText('甲'.repeat(1000), 200, 50);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });
});

describe('chunkText —— 不丢内容（RAG 的底线）', () => {
  it('⭐ 每个切片都是原文的子串，且首尾覆盖到原文的头与尾', () => {
    const text = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 条：这是一条校园管理规定。`).join(
      '\n',
    );
    const chunks = chunkText(text, 200, 40);

    for (const c of chunks) {
      expect(text.includes(c.text)).toBe(true);
    }
    expect(chunks[0]?.text.startsWith('第 1 条')).toBe(true);
    expect(chunks[chunks.length - 1]?.text.endsWith('。')).toBe(true);
  });

  it('⭐ 相邻切片有重叠（一句话被切断时，两片都能看到完整上下文）', () => {
    const text = '甲'.repeat(500);
    const chunks = chunkText(text, 200, 50);

    // 第 0 片覆盖 [0,200)，第 1 片应从 150 左右开始 → 与第 0 片有重叠
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // 用"总长度 > 原文长度"来证明重叠确实存在
    const totalLen = chunks.reduce((a, c) => a + c.text.length, 0);
    expect(totalLen).toBeGreaterThan(text.length);
  });

  it('切片数量与重叠成正比（重叠越大，片越多）', () => {
    const text = '甲'.repeat(2000);
    const few = chunkText(text, 300, 0);
    const many = chunkText(text, 300, 150);
    expect(many.length).toBeGreaterThan(few.length);
  });
});

describe('chunkText —— 按语义边界切（检索质量的关键）', () => {
  it('⭐ 优先在句号 / 换行处断开，而不是切在句子中间', () => {
    // 每句 20 字，切片 50 字：硬切会切在第 3 句中间，按边界切应落在句末
    const text = Array.from({ length: 20 }, (_, i) => `这是第${i + 1}条规定的完整内容。`).join('');
    const chunks = chunkText(text, 50, 0);

    // 除最后一片外，其余都应以句号结尾
    for (const c of chunks.slice(0, -1)) {
      expect(c.text.endsWith('。')).toBe(true);
    }
  });

  it('没有可断句的标点时退回硬切（不能因为找不到边界就少切内容）', () => {
    const text = '甲'.repeat(300);
    const chunks = chunkText(text, 100, 0);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });
});

describe('chunkText —— 边界与异常输入', () => {
  it('⭐ overlap >= size 时不死循环（会把重叠夹到 size-1）', () => {
    const chunks = chunkText('甲'.repeat(500), 100, 100);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThanOrEqual(MAX_CHUNKS_PER_DOC);
  });

  it('overlap 为负数时按 0 处理', () => {
    const chunks = chunkText('甲'.repeat(500), 100, -50);
    expect(chunks.length).toBe(5);
  });

  it('⭐ CRLF 被归一化（本仓库文件是 CRLF，\\r 混进向量库会让相同文本算出不同向量）', () => {
    const chunks = chunkText('第一行\r\n第二行\r\n第三行', 100, 0);
    expect(chunks[0]?.text).toBe('第一行\n第二行\n第三行');
    expect(chunks[0]?.text.includes('\r')).toBe(false);
  });

  it('连续空行被压缩（Word / 网页复制来的正文常有大量空行，会白白占切片预算）', () => {
    const chunks = chunkText('第一段\n\n\n\n\n第二段', 100, 0);
    expect(chunks[0]?.text).toBe('第一段\n\n第二段');
  });

  it('⭐ 超长文档被切片数上限截断（防止一次打出几百次 embedding 请求）', () => {
    const chunks = chunkText('甲'.repeat(MAX_CHUNKS_PER_DOC * 200 + 10_000), 200, 0);
    expect(chunks).toHaveLength(MAX_CHUNKS_PER_DOC);
  });

  it('切片里不出现纯空白项', () => {
    const chunks = chunkText('甲\n\n\n\n乙\n\n\n\n丙', 3, 0);
    expect(chunks.every((c) => c.text.trim().length > 0)).toBe(true);
  });
});
