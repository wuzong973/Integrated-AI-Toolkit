import { BizException, ErrorCode, type EmbeddingProvider } from '@qz/core';

import type { AppConfig } from '../../../common/config/configuration';

/**
 * 向量化 —— 硅基流动实现（`BAAI/bge-m3`）
 *
 * ## 端点
 *
 * `POST {baseUrl}/embeddings`，与 OCR / 语音**共用同一个 Key**，只换 model 名。
 * 实测：1024 维、单条 146ms。
 *
 * ## ⚠️ 目前还没有消费方
 *
 * 接它的目的是"摘掉 mock-embedding"，让 `/health` 如实反映依赖状态。
 * 但真正的语义检索（校园知识库 RAG，M4-06）还需要：
 * 切片入库 → **外接向量库**（MySQL 无向量能力）→ 检索 → 带引用回答。
 * 在那之前，本 Provider 不会有业务调用 —— 这是**已知的、刻意的**中间状态，
 * 不是"忘了接线"。
 *
 * ## 为什么不猜维度
 *
 * `dimension` 由配置给出（默认 1024）而不是硬编码在代码里：
 * 换模型（如 `Qwen/Qwen3-Embedding-8B` 是 4096 维）时必须同步改，
 * 而下游建向量表、算余弦相似度都依赖这个值 —— 猜错会静默算出错误结果。
 */
export class SiliconflowEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'siliconflow-embedding';
  readonly dimension: number;

  constructor(private readonly cfg: AppConfig['embedding']) {
    this.dimension = cfg.dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const json = await this.postWithRetry(texts);
    const rows = (json as EmbedResponse).data ?? [];

    /**
     * 按 `index` 排序后再返回。
     *
     * OpenAI 协议**不保证**响应顺序与入参一致（只保证每项带 index），
     * 依赖返回顺序会让向量与文本错位 —— 而这种错误不会报错，
     * 只会让检索结果莫名其妙。
     */
    const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    if (ordered.length !== texts.length) {
      throw new BizException(
        ErrorCode.AiOutputInvalid,
        { expected: texts.length, got: ordered.length },
        '向量化返回条数与请求不一致，已中止（避免向量与文本错位）',
      );
    }

    const vectors = ordered.map((r) => r.embedding);
    for (const v of vectors) {
      if (!Array.isArray(v) || v.length !== this.dimension) {
        throw new BizException(
          ErrorCode.AiOutputInvalid,
          { expected: this.dimension, got: v?.length ?? 0, model: this.cfg.model },
          `向量维度与配置不符（配置 ${this.dimension}）—— 换模型时请同步改 EMBEDDING_DIMENSION`,
        );
      }
    }
    return vectors;
  }

  /** 指数退避重试（1s / 4s）。4xx 属确定性失败，不重试。 */
  private async postWithRetry(texts: string[]): Promise<unknown> {
    const max = Math.max(1, this.cfg.maxRetry);
    let lastErr: unknown;

    for (let attempt = 0; attempt < max; attempt++) {
      try {
        const res = await fetch(`${this.cfg.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.cfg.apiKey}`,
          },
          body: JSON.stringify({ model: this.cfg.model, input: texts }),
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });

        if (res.ok) return await res.json();

        // 4xx（除 429 限流）是确定性失败，重试无意义
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new BizException(ErrorCode.LlmUnavailable, {
            status: res.status,
            body: (await res.text()).slice(0, 300),
          });
        }
        lastErr = new Error(`Embedding HTTP ${res.status}`);
      } catch (e) {
        if (e instanceof BizException) throw e;
        lastErr = e;
      }

      if (attempt < max - 1) {
        await new Promise((r) => setTimeout(r, Math.pow(4, attempt) * 1000));
      }
    }

    throw new BizException(ErrorCode.LlmUnavailable, {
      model: this.cfg.model,
      reason: (lastErr as Error)?.message ?? 'unknown',
    });
  }
}

interface EmbedResponse {
  data?: { index?: number; embedding: number[] }[];
}
