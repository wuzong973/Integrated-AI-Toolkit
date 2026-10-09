import {
  BizException,
  ErrorCode,
  type VectorMatch,
  type VectorPoint,
  type VectorProvider,
} from '@qz/core';

import type { AppConfig } from '../../../common/config/configuration';
import type { AppLogger } from '../../../common/logger/logger.service';

/**
 * 向量库 —— Qdrant 实现（自建，M4-06 校园知识库 RAG）
 *
 * ## 为什么单独接一个向量库，而不是把向量存 MySQL
 *
 * `KnowledgeDoc.embedding` 这个 Json 列在初版 schema 里就留了，但它的注释已经写明
 * "规模上来后迁移到 pgvector 列" —— 而本项目**已拍板统一用 MySQL 8**，
 * MySQL 没有向量类型、也没有 ANN 索引。把 1024 维向量塞进 Json 列，
 * 检索只能全表捞出来在应用层算余弦：几百条还行，上万条就是一次接口几十秒。
 * 所以按设计文档（任务清单 M4-06）走**外接向量库**。
 *
 * ## 为什么用裸 fetch 而不是官方 SDK
 *
 * 与 LLM / OCR / ASR / Embedding 四个 Provider 保持一致 —— 它们全部用裸 fetch。
 * 好处是零新依赖（红线：引入任何新依赖都要先登记 `OPEN_SOURCE_LICENSES.md`），
 * 且不会出现"某个 SDK 的默认超时/重试策略与本项目的总预算机制打架"。
 * Qdrant 的 REST 协议很薄，三个端点就够用。
 *
 * ## 维度不一致必须报错，不能静默
 *
 * 集合一旦按 1024 维建好，再写入 512 维的向量 Qdrant 会直接拒绝；
 * 但如果**集合本身是按错的维度建的**（比如换 Embedding 模型后忘了改
 * `EMBEDDING_DIMENSION`），写入会成功、检索也会返回结果，只是相似度全是垃圾 ——
 * 这类"不报错的错"最难排查。故 `ensureCollection` 会显式比对已存在集合的维度。
 */
export class QdrantVectorProvider implements VectorProvider {
  readonly name = 'qdrant';

  /** 进程内缓存"集合已就绪"，避免每次 upsert / search 都先打一次 GET */
  private ready = false;
  private declaredDimension = 0;

  constructor(
    private readonly cfg: AppConfig['vector'],
    /** 可选：仅用于记录"集合维度不一致"这类运维事件；不传则静默 */
    private readonly logger?: Pick<AppLogger, 'warn'>,
  ) {}

  async ensureCollection(dimension: number): Promise<void> {
    if (this.ready && this.declaredDimension === dimension) return;

    const existing = await this.call('GET', '', undefined, true);

    if (existing === null) {
      await this.call('PUT', '', { vectors: { size: dimension, distance: 'Cosine' } });
      this.logger?.warn(
        `向量集合 ${this.cfg.collection} 不存在，已按 ${dimension} 维创建`,
        'QdrantVectorProvider',
      );
    } else {
      const actual = readDimension(existing);
      if (actual !== undefined && actual !== dimension) {
        throw new BizException(
          ErrorCode.LlmUnavailable,
          { collection: this.cfg.collection, expected: dimension, actual },
          `向量集合 ${this.cfg.collection} 是 ${actual} 维，而当前配置是 ${dimension} 维 —— ` +
            '换 Embedding 模型后必须同步改 EMBEDDING_DIMENSION 并重建集合，否则检索结果全是噪音',
        );
      }
    }

    this.ready = true;
    this.declaredDimension = dimension;
  }

  async upsert(points: VectorPoint[]): Promise<void> {
    if (points.length === 0) return;

    await this.call('PUT', '/points?wait=true', {
      points: points.map((p) => ({ id: p.id, vector: p.vector, payload: p.payload })),
    });
  }

  async search(vector: number[], topK: number, scoreThreshold?: number): Promise<VectorMatch[]> {
    const json = await this.call('POST', '/points/search', {
      vector,
      limit: topK,
      with_payload: true,
      ...(scoreThreshold === undefined ? {} : { score_threshold: scoreThreshold }),
    });

    return toMatches(json);
  }

  async deleteByDocument(documentId: string): Promise<void> {
    // 先删后插：重灌同一篇文档时若不删，旧切片会残留在集合里，
    // 表现为"改过的内容检索出来还是老版本"，且不会报任何错
    await this.call('POST', '/points/delete?wait=true', {
      filter: { must: [{ key: 'documentId', match: { value: documentId } }] },
    });
  }

  /**
   * 发一次请求。
   *
   * `allow404` 用于"集合是否存在"的探测（Qdrant 用 404 表示集合不存在，
   * 这是**正常分支**而不是错误）。
   */
  private async call(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    body?: unknown,
    allow404 = false,
  ): Promise<unknown | null> {
    const url = `${this.cfg.url.replace(/\/+$/, '')}/collections/${this.cfg.collection}${path}`;
    const res = await this.send(method, url, body);

    if (allow404 && res.status === 404) return null;

    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new BizException(
        ErrorCode.LlmUnavailable,
        { status: res.status, body: text, url },
        `向量库返回错误（HTTP ${res.status}）`,
      );
    }

    return await res.json();
  }

  /** 真正发请求；网络层失败（Qdrant 没启动）单独给出可执行的提示 */
  private async send(method: string, url: string, body?: unknown): Promise<Response> {
    try {
      return await fetch(url, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (e) {
      throw new BizException(
        ErrorCode.LlmUnavailable,
        { url: this.cfg.url, reason: (e as Error)?.message ?? 'unknown' },
        `连不上向量库 ${this.cfg.url} —— 请确认 Qdrant 已启动，或把 VECTOR_DRIVER 改回 mock`,
      );
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    // Qdrant 自建时通常不开鉴权；托管版必须带 api-key
    if (this.cfg.apiKey) h['api-key'] = this.cfg.apiKey;
    return h;
  }
}

/**
 * 从 `GET /collections/{name}` 的响应里读出向量维度。
 *
 * Qdrant 的响应结构有两代写法（`config.params.vectors` 可能是对象或
 * 具名向量映射），这里都兼容；读不出来就返回 `undefined`（不报错）——
 * 因为我们**没有**读到时不该阻止使用，只有"读到了且不一致"才必须拦。
 */
function readDimension(json: unknown): number | undefined {
  const params = (json as { result?: { config?: { params?: { vectors?: unknown } } } })?.result
    ?.config?.params?.vectors;

  if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
    const size = (params as { size?: unknown }).size;
    if (typeof size === 'number') return size;
  }
  return undefined;
}

/** 把 Qdrant 的检索响应转成本项目的 `VectorMatch` */
function toMatches(json: unknown): VectorMatch[] {
  const rows = (json as { result?: unknown[] })?.result;
  if (!Array.isArray(rows)) return [];

  return rows
    .filter((r): r is { id: unknown; score?: unknown; payload?: unknown } => {
      return typeof r === 'object' && r !== null;
    })
    .map((r) => ({
      id: String(r.id),
      score: typeof r.score === 'number' ? r.score : 0,
      payload:
        typeof r.payload === 'object' && r.payload !== null
          ? (r.payload as Record<string, unknown>)
          : {},
    }));
}
