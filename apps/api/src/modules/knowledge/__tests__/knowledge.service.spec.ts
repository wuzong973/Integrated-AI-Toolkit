import { describe, expect, it, vi } from 'vitest';

import { KnowledgeService } from '../knowledge.service';

/**
 * 校园知识库 RAG（M4-06）
 *
 * 重点锁死三件"错了也不会报错"的事：
 *   ① **检索为空时不调用 LLM** —— 否则模型会拿噪音编答案，而校园制度答错会让人按错流程办事；
 *   ② **重灌前先删旧切片** —— 否则改过的内容检索出来还是老版本；
 *   ③ **向量条数与切片数必须对齐** —— 对不上就是向量与文本错位，检索结果会莫名其妙。
 */

/** ConfigService 桩：只提供本服务用到的两段配置 */
function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    get: () => ({
      rag: { topK: 5, scoreThreshold: 0.35, chunkSize: 100, chunkOverlap: 20, ...overrides },
      vector: { collection: 'qz_knowledge' },
    }),
  };
}

function makePrisma() {
  return {
    knowledgeDoc: {
      create: vi.fn(async () => ({ id: 'doc-1' })),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({ id: 'doc-1' })),
      delete: vi.fn(async () => ({})),
    },
  };
}

/** 确定性假向量：维度 4，内容相同则向量相同 */
function makeEmbedding() {
  return {
    name: 'fake-embedding',
    dimension: 4,
    embed: vi.fn(async (texts: string[]) => texts.map(() => [0.5, 0.5, 0.5, 0.5])),
  };
}

function makeVector(matches: unknown[] = []) {
  return {
    name: 'fake-vector',
    ensureCollection: vi.fn(async () => undefined),
    upsert: vi.fn(async () => undefined),
    search: vi.fn(async () => matches),
    deleteByDocument: vi.fn(async () => undefined),
  };
}

function makeService(
  prisma: unknown,
  providers: { embedding: unknown; vector: unknown; llm?: unknown },
  ragOverrides: Record<string, unknown> = {},
) {
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const svc = new KnowledgeService(
    prisma as never,
    { llm: {}, ...providers } as never,
    makeConfig(ragOverrides) as never,
    logger as never,
  );
  return { svc, logger };
}

describe('KnowledgeService.ingest —— 灌库', () => {
  it('切片 → 向量化 → 写入向量库，并返回切片数', async () => {
    const prisma = makePrisma();
    const embedding = makeEmbedding();
    const vector = makeVector();
    const { svc } = makeService(prisma, { embedding, vector });

    const r = await svc.ingest({
      title: '校园卡补办流程',
      category: 'guide',
      content: '甲'.repeat(350),
    });

    expect(r.documentId).toBe('doc-1');
    expect(r.chunkCount).toBeGreaterThan(1);
    expect(r.collection).toBe('qz_knowledge');
    expect(embedding.embed).toHaveBeenCalledTimes(1);
    expect(vector.upsert).toHaveBeenCalledTimes(1);

    const points = (vector.upsert.mock.calls[0] as unknown as [unknown[]])[0];
    expect(points).toHaveLength(r.chunkCount);
  });

  it('⭐ 写入前先 deleteByDocument（否则重灌时旧切片残留，检索出来的还是老版本）', async () => {
    const vector = makeVector();
    const { svc } = makeService(makePrisma(), { embedding: makeEmbedding(), vector });

    await svc.ingest({ title: 'T', category: 'guide', content: '甲'.repeat(350) });

    expect(vector.deleteByDocument).toHaveBeenCalledWith('doc-1');
    // 顺序：先删后插
    const deleteOrder = vector.deleteByDocument.mock.invocationCallOrder[0];
    const upsertOrder = vector.upsert.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(upsertOrder as number);
  });

  it('⭐ payload 里带切片原文（检索命中后不回表，避免"检索到了、正文查不到"）', async () => {
    const vector = makeVector();
    const { svc } = makeService(makePrisma(), { embedding: makeEmbedding(), vector });

    await svc.ingest({
      title: '校园卡补办流程',
      source: '学生手册 2026',
      category: 'guide',
      content: '甲'.repeat(350),
    });

    const points = (vector.upsert.mock.calls[0] as unknown as [
      { payload: Record<string, unknown> }[],
    ])[0];
    const first = points[0];
    expect(first?.payload).toMatchObject({
      documentId: 'doc-1',
      title: '校园卡补办流程',
      source: '学生手册 2026',
      category: 'guide',
      chunkIndex: 0,
    });
    expect(typeof first?.payload.text).toBe('string');
  });

  it('空正文直接拒绝，不写库也不调模型', async () => {
    const prisma = makePrisma();
    const embedding = makeEmbedding();
    const { svc } = makeService(prisma, { embedding, vector: makeVector() });

    await expect(
      svc.ingest({ title: 'T', category: 'guide', content: '   \n  ' }),
    ).rejects.toThrow(/正文为空/);
    expect(prisma.knowledgeDoc.create).not.toHaveBeenCalled();
    expect(embedding.embed).not.toHaveBeenCalled();
  });

  it('⭐ 向量条数与切片数不一致时中止（静默错位比报错难查得多）', async () => {
    const embedding = {
      name: 'fake',
      dimension: 4,
      embed: vi.fn(async () => [[1, 2, 3, 4]]), // 只返回 1 条，但切片不止 1 片
    };
    const { svc } = makeService(makePrisma(), { embedding, vector: makeVector() });

    await expect(
      svc.ingest({ title: 'T', category: 'guide', content: '甲'.repeat(350) }),
    ).rejects.toThrow(/条数与切片数不一致/);
  });
});

describe('KnowledgeService.search —— 语义检索', () => {
  it('把阈值传给向量库（没有阈值就会永远凑出 topK 条噪音）', async () => {
    const vector = makeVector([]);
    const { svc } = makeService(makePrisma(), { embedding: makeEmbedding(), vector });

    await svc.search('校园卡怎么补办');

    const args = vector.search.mock.calls[0] as unknown as [number[], number, number];
    expect(args[1]).toBe(5);
    expect(args[2]).toBe(0.35);
  });

  it('topK 可由调用方覆盖（受 schema 限制在 1~20）', async () => {
    const vector = makeVector([]);
    const { svc } = makeService(makePrisma(), { embedding: makeEmbedding(), vector });

    await svc.search('问题', 2);
    expect((vector.search.mock.calls[0] as unknown as [number[], number])[1]).toBe(2);
  });

  it('payload 缺关键字段的命中被丢弃（脏数据不该进到界面）', async () => {
    const vector = makeVector([
      { id: 'p1', score: 0.9, payload: { documentId: 'd1', title: 'A', text: '有效内容' } },
      { id: 'p2', score: 0.8, payload: { documentId: 'd2' } }, // 缺 text
      { id: 'p3', score: 0.7, payload: { text: '没有归属文档' } },
    ]);
    const { svc } = makeService(makePrisma(), { embedding: makeEmbedding(), vector });

    const hits = await svc.search('问题');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toBe('有效内容');
  });
});

describe('KnowledgeService.ask —— 带引用的回答', () => {
  it('⭐ 检索为空时**不调用 LLM**，如实说"没找到"（否则模型一定会编）', async () => {
    const chat = vi.fn(async () => ({ content: '编出来的答案' }));
    const { svc } = makeService(makePrisma(), {
      embedding: makeEmbedding(),
      vector: makeVector([]),
      llm: { chat },
    });

    const r = await svc.ask('校园卡怎么补办');

    expect(chat).not.toHaveBeenCalled();
    expect(r.grounded).toBe(false);
    expect(r.citations).toEqual([]);
    expect(r.answer).toContain('没有找到');
  });

  it('有命中时调 LLM，并把命中整理成带编号的引用', async () => {
    const chat = vi.fn(async () => ({ content: '需要到一卡通中心办理 [1]。' }));
    const vector = makeVector([
      { id: 'p1', score: 0.91, payload: { documentId: 'd1', title: '校园卡补办', text: '到一卡通中心。' } },
    ]);
    const { svc } = makeService(makePrisma(), { embedding: makeEmbedding(), vector, llm: { chat } });

    const r = await svc.ask('校园卡怎么补办');

    expect(chat).toHaveBeenCalledTimes(1);
    expect(r.grounded).toBe(true);
    expect(r.citations).toEqual([
      { index: 1, title: '校园卡补办', source: undefined, score: 0.91 },
    ]);
    expect(r.answer).toContain('一卡通中心');
  });

  it('⭐ 检索到的原文确实被送进了提示词（不能只把问题发过去）', async () => {
    const chat = vi.fn(async () => ({ content: 'ok' }));
    const vector = makeVector([
      { id: 'p1', score: 0.9, payload: { documentId: 'd1', title: 'T', text: '独一无二的原文片段' } },
    ]);
    const { svc } = makeService(makePrisma(), { embedding: makeEmbedding(), vector, llm: { chat } });

    await svc.ask('问题');

    const messages = (chat.mock.calls[0] as unknown as [unknown[], unknown])[0];
    expect(JSON.stringify(messages)).toContain('独一无二的原文片段');
    expect(JSON.stringify(messages)).toContain('[1]');
  });

  it('模型返回空内容时退回"没找到"，不把空串交给界面', async () => {
    const chat = vi.fn(async () => ({ content: '   ' }));
    const vector = makeVector([
      { id: 'p1', score: 0.9, payload: { documentId: 'd1', title: 'T', text: 'x' } },
    ]);
    const { svc } = makeService(makePrisma(), { embedding: makeEmbedding(), vector, llm: { chat } });

    expect((await svc.ask('问题')).answer).toContain('没有找到');
  });
});

describe('KnowledgeService.remove —— 两边都删', () => {
  it('⭐ 删 MySQL 的同时清掉向量库切片（只删一边会留下悬空切片）', async () => {
    const prisma = makePrisma();
    const vector = makeVector();
    const { svc } = makeService(prisma, { embedding: makeEmbedding(), vector });

    await svc.remove('doc-1');

    expect(prisma.knowledgeDoc.delete).toHaveBeenCalledWith({ where: { id: 'doc-1' } });
    expect(vector.deleteByDocument).toHaveBeenCalledWith('doc-1');
  });

  it('文档不存在时抛 NotFound，且不去动向量库', async () => {
    const prisma = makePrisma();
    prisma.knowledgeDoc.findUnique = vi.fn(async () => null);
    const vector = makeVector();
    const { svc } = makeService(prisma, { embedding: makeEmbedding(), vector });

    await expect(svc.remove('nope')).rejects.toThrow(/文档不存在/);
    expect(vector.deleteByDocument).not.toHaveBeenCalled();
  });
});
