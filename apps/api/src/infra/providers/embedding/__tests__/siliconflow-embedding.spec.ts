import { afterEach, describe, expect, it, vi } from 'vitest';

import { SiliconflowEmbeddingProvider } from '../siliconflow-embedding.provider';

/**
 * 向量化 Provider（硅基流动 `BAAI/bge-m3`）
 *
 * 重点验证**不会静默算错**：
 *   · 响应顺序与入参不一致时必须按 index 重排（否则向量与文本错位）；
 *   · 维度与配置不符时必须报错（否则下游余弦相似度算出来是错的但看不出来）。
 */
const CFG = {
  baseUrl: 'https://api.siliconflow.cn/v1',
  apiKey: 'sk-test',
  model: 'BAAI/bge-m3',
  dimension: 1024,
  timeoutMs: 5000,
  maxRetry: 1,
  enabled: true,
};

const vec = (seed: number, dim = 1024) => new Array(dim).fill(seed);

/** 造一个 embeddings 响应；`data` 的顺序即返回顺序 */
const okBody = (items: { index: number; embedding: number[] }[]) => ({
  data: items,
  usage: { total_tokens: 13 },
});

const respondJson = (status: number, body: unknown) =>
  vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SiliconflowEmbeddingProvider', () => {
  it('正常返回向量，dimension 来自配置', async () => {
    vi.stubGlobal('fetch', respondJson(200, okBody([{ index: 0, embedding: vec(0.1) }])));

    const p = new SiliconflowEmbeddingProvider(CFG);
    const out = await p.embed(['青智校园']);

    expect(p.dimension).toBe(1024);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(1024);
  });

  it('⭐ 响应顺序与入参不一致时按 index 重排（否则向量与文本错位）', async () => {
    vi.stubGlobal(
      'fetch',
      respondJson(
        200,
        okBody([
          { index: 1, embedding: vec(0.2) },
          { index: 0, embedding: vec(0.1) },
        ]),
      ),
    );

    const out = await new SiliconflowEmbeddingProvider(CFG).embed(['第一条', '第二条']);

    expect(out[0][0]).toBeCloseTo(0.1);
    expect(out[1][0]).toBeCloseTo(0.2);
  });

  it('⭐ 维度与配置不符时报错（换模型忘了改 EMBEDDING_DIMENSION 时能被发现）', async () => {
    vi.stubGlobal('fetch', respondJson(200, okBody([{ index: 0, embedding: vec(0.1, 4096) }])));

    await expect(new SiliconflowEmbeddingProvider(CFG).embed(['x'])).rejects.toThrow(/维度/);
  });

  it('返回条数与请求不一致时报错（不静默少给）', async () => {
    vi.stubGlobal('fetch', respondJson(200, okBody([{ index: 0, embedding: vec(0.1) }])));

    await expect(new SiliconflowEmbeddingProvider(CFG).embed(['a', 'b'])).rejects.toThrow(
      /条数/,
    );
  });

  it('空输入直接返回空数组，不发请求', async () => {
    const fetchMock = respondJson(200, okBody([]));
    vi.stubGlobal('fetch', fetchMock);

    expect(await new SiliconflowEmbeddingProvider(CFG).embed([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('4xx 是确定性失败，不重试', async () => {
    const fetchMock = respondJson(400, { error: { code: 'x', message: '模型不存在' } });
    vi.stubGlobal('fetch', fetchMock);

    await expect(new SiliconflowEmbeddingProvider(CFG).embed(['x'])).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('请求体带 model 与 input 数组', async () => {
    const fetchMock = respondJson(200, okBody([{ index: 0, embedding: vec(0.1) }]));
    vi.stubGlobal('fetch', fetchMock);

    await new SiliconflowEmbeddingProvider(CFG).embed(['你好']);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.model).toBe('BAAI/bge-m3');
    expect(body.input).toEqual(['你好']);
  });
});
