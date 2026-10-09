// ==================== 向量库（RAG 检索，M4-06） ====================
//
// 从 `types.ts` 拆出来：那个文件已接近 300 行上限，而"向量化 / 向量检索"
// 本身是相对独立的一组概念（ADR-14）。`types.ts` 会原样再导出本文件的全部类型，
// 所以 `@qz/core` 的使用方无需改动 import 路径。

/**
 * 一条待写入的向量记录。
 *
 * `payload` 存**可被引用给用户的原文**：检索命中后要把这段文字连同
 * 标题/来源一起交给 LLM 做"带引用的回答"，所以它必须自带完整上下文，
 * 而不是只存一个指向 MySQL 的外键 —— 那样每次检索都要回表，且
 * "向量库与关系库不一致"会变成一类静默错误（检索到了、正文却查不到）。
 */
export interface VectorPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

/** 一次检索命中 */
export interface VectorMatch {
  id: string;
  /** 相似度得分（Qdrant 用 Cosine 距离时，越大越相关，取值约 0~1） */
  score: number;
  payload: Record<string, unknown>;
}

/**
 * 向量库抽象（文档 2.7 外接向量库）。
 *
 * 纪律：业务代码只依赖本接口，**不直接依赖任何向量库客户端 SDK**
 *（红线：外部依赖只能走 Provider 接口）。当前实现为 Qdrant（自建），
 * 将来换 Milvus / pgvector 时业务代码零改动。
 */
export interface VectorProvider {
  readonly name: string;
  /**
   * 确保集合存在（**幂等**）。
   *
   * `dimension` 必须与 Embedding 模型真实维度一致（bge-m3 = 1024）。
   * ⚠️ 维度写错**不会报错**，只会让所有相似度都算成垃圾 —— 所以实现里
   * 必须校验"已存在的集合维度"与传入值是否一致，不一致就抛错而不是继续。
   */
  ensureCollection(dimension: number): Promise<void>;
  upsert(points: VectorPoint[]): Promise<void>;
  /** 检索最相似的 `topK` 条；`scoreThreshold` 之下的一律不返回 */
  search(vector: number[], topK: number, scoreThreshold?: number): Promise<VectorMatch[]>;
  /** 删除某篇文档的全部切片（重新灌库时先删后插，保证不残留旧切片） */
  deleteByDocument(documentId: string): Promise<void>;
}
