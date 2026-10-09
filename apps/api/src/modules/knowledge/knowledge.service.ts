import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BizException,
  ErrorCode,
  type KnowledgeAnswer,
  type KnowledgeHit,
  type KnowledgeIngestDto,
  type KnowledgeIngestResult,
  type Providers,
  type VectorMatch,
  sampling,
} from '@qz/core';

import type { AppConfig } from '../../common/config/configuration';
import { AppLogger } from '../../common/logger/logger.service';
import { PROVIDERS } from '../../infra/providers/providers.module';
import { PrismaService } from '../../infra/prisma/prisma.service';

import { chunkText } from './knowledge-chunker';

/** 无检索依据时的固定回答（不交给模型，避免它自由发挥） */
const NO_GROUNDING_ANSWER =
  '校园知识库里没有找到与这个问题相关的内容。可以换个说法再问，或直接联系相关部门确认。';

/**
 * 校园知识库 RAG（M4-06）
 *
 * ## 这条链路才是"向量化"的真实调用点
 *
 * 在它之前，`SiliconflowEmbeddingProvider` 只服务于 `/health` ——
 * 配了、能跑、但没有任何业务调用方（`VECTOR_DRIVER=mock` 时同理）。
 * 一个没有消费方的 Provider 是死代码：它不会报错，只是**功能在产品上不存在**。
 *
 * 本服务把四个环节串起来：
 *
 * ```
 *   ingest: 切片(chunkText) → 向量化(embedding.embed) → 写入(vector.upsert)
 *   search: 向量化(embedding.embed) → 检索(vector.search) → 命中切片
 *   ask:    search → 拼上下文 → LLM 带引用回答
 * ```
 *
 * ## 两个刻意的设计
 *
 * 1. **切片原文存在向量库的 payload 里**，而不是只存一个 MySQL 外键。
 *    检索命中后要立刻把原文交给模型，回表查询会让"检索到了、正文查不到"
 *    变成一类静默错误（向量库与关系库不一致）。
 * 2. **检索为空时不调用 LLM**（见 `ask`）。没有这个分支，模型会拿着
 *    5 条最不相关的切片编出一个听起来很合理的答案，用户无从分辨。
 */
@Injectable()
export class KnowledgeService {
  private readonly rag: AppConfig['rag'];
  private readonly collection: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROVIDERS) private readonly providers: Providers,
    config: ConfigService,
    private readonly logger: AppLogger,
  ) {
    const app = config.get<AppConfig>('app');
    if (!app) throw new Error('应用配置未初始化（ConfigService 拿不到 app）');
    this.rag = app.rag;
    this.collection = app.vector.collection;
  }

  /**
   * 灌库：切片 → 向量化 → 写入向量库。
   *
   * 顺序是**先落 MySQL 再写向量库**：向量库的 payload 需要文档 id 做归属，
   * 而 id 由 MySQL 生成。若向量写入失败，MySQL 里会留下一篇"检索不到"的文档 ——
   * 这是可接受的：重新灌一次同一篇即可（`deleteByDocument` 保证不残留旧切片）。
   * 反过来先写向量库则会产生"检索得到、但文档不存在"的悬空引用，更难清理。
   */
  async ingest(dto: KnowledgeIngestDto): Promise<KnowledgeIngestResult> {
    const chunks = chunkText(dto.content, this.rag.chunkSize, this.rag.chunkOverlap);
    if (chunks.length === 0) {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '正文为空，没有可入库的内容');
    }

    const doc = await this.prisma.knowledgeDoc.create({
      data: {
        title: dto.title,
        source: dto.source ?? null,
        category: dto.category,
        content: dto.content,
      },
      select: { id: true },
    });

    await this.providers.vector.ensureCollection(this.providers.embedding.dimension);
    const vectors = await this.providers.embedding.embed(chunks.map((c) => c.text));

    // 先删后插：同一篇文档重灌时旧切片必须清掉，否则检索出来的还是老版本内容
    await this.providers.vector.deleteByDocument(doc.id);
    await this.providers.vector.upsert(
      chunks.map((c, i) => ({
        id: randomUUID(),
        vector: requireVector(vectors[i], i),
        payload: {
          documentId: doc.id,
          title: dto.title,
          source: dto.source ?? '',
          category: dto.category,
          chunkIndex: c.index,
          text: c.text,
        },
      })),
    );

    this.logger.log(
      `知识库入库：${dto.title} → ${chunks.length} 片（集合 ${this.collection}）`,
      'KnowledgeService',
    );

    return { documentId: doc.id, chunkCount: chunks.length, collection: this.collection };
  }

  /** 文档列表（只给元信息，不回正文，避免列表接口被大文档拖垮） */
  async list(): Promise<
    { id: string; title: string; category: string; source?: string; createdAt: string }[]
  > {
    const rows = await this.prisma.knowledgeDoc.findMany({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, title: true, category: true, source: true, createdAt: true },
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      category: r.category,
      source: r.source ?? undefined,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** 删除文档：**两边都删**。只删一边会留下悬空切片或查不到的向量 */
  async remove(id: string): Promise<{ deleted: true }> {
    const found = await this.prisma.knowledgeDoc.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new BizException(ErrorCode.NotFound, undefined, '文档不存在');

    await this.prisma.knowledgeDoc.delete({ where: { id } });
    await this.providers.vector.deleteByDocument(id);
    return { deleted: true };
  }

  /**
   * 语义检索。
   *
   * 阈值（`RAG_SCORE_THRESHOLD`）在这里生效：低于它的切片一律不返回。
   * 这一步的作用是**让"检索不到"成为一件可以说出口的事** ——
   * 没有阈值时，即使知识库完全没有相关内容，也总能凑出 topK 条最相似的噪音。
   */
  async search(query: string, topK?: number): Promise<KnowledgeHit[]> {
    const [vector] = await this.providers.embedding.embed([query]);
    if (!vector) {
      throw new BizException(ErrorCode.AiOutputInvalid, undefined, '向量化没有返回结果');
    }

    await this.providers.vector.ensureCollection(this.providers.embedding.dimension);
    const matches = await this.providers.vector.search(
      vector,
      topK ?? this.rag.topK,
      this.rag.scoreThreshold,
    );

    return matches.map(toHit).filter((h): h is KnowledgeHit => h !== null);
  }

  /**
   * 带引用的问答。
   *
   * ⭐ **检索为空时直接返回，不调用 LLM** —— 这是本方法最重要的一行分支。
   * 让模型在"没有资料"的前提下作答，它一定会编；而编出来的校园制度类内容
   * 用户是会当真的。宁可说"没找到"。
   */
  async ask(question: string): Promise<KnowledgeAnswer> {
    const hits = await this.search(question);
    if (hits.length === 0) {
      return { answer: NO_GROUNDING_ANSWER, citations: [], grounded: false };
    }

    const context = hits
      .map((h, i) => `[${i + 1}] ${h.title}${h.source ? `（${h.source}）` : ''}\n${h.text}`)
      .join('\n\n');

    const res = await this.providers.llm.chat(
      [
        { role: 'system', content: RAG_SYSTEM_PROMPT },
        { role: 'user', content: `资料：\n${context}\n\n问题：${question}` },
      ],
      // 依据资料作答是"照抄 + 归纳"，不是创作，温度调低
      { tier: 'generate', ...sampling('grounded', { maxTokens: 1200 }) },
    );

    return {
      answer: res.content.trim() || NO_GROUNDING_ANSWER,
      citations: hits.map((h, i) => ({
        index: i + 1,
        title: h.title,
        source: h.source,
        score: Number(h.score.toFixed(4)),
      })),
      grounded: true,
    };
  }
}

/**
 * RAG 系统提示词。
 *
 * 三条硬约束缺一不可：
 *   ① 只用资料回答 —— 否则模型会混入自己的训练知识，而校园制度类内容
 *      各校差异极大，混淆的后果是用户按错的规定办事；
 *   ② 必须标引用 —— 让用户能自己核对；
 *   ③ 资料不足就说不知道 —— 明确给出"拒绝作答"的许可，
 *      否则模型在"必须回答"的压力下会编。
 */
const RAG_SYSTEM_PROMPT = `你是「青智校园」的知识库助手，负责依据给定资料回答学生的问题。

硬性要求：
1. **只依据「资料」部分作答**。不要使用资料以外的知识，不要补充你自己的经验或推测。
2. 每条结论后面用 [1] [2] 这样的编号标注它来自哪条资料，编号必须与资料前的编号对应。
3. 如果资料不足以回答问题，就直说"资料里没有相关内容"，**不要编造**。
   宁可少答，也不要答错 —— 校园制度类信息答错会让用户按错误的流程办事。
4. 用中文回答，简洁清晰；可以分点，但不要用 Markdown 标题。
5. 不要输出任何网址或链接。`;

/** 向量库命中 → 业务对象；payload 缺关键字段时返回 null（脏数据不该进到界面） */
function toHit(m: VectorMatch): KnowledgeHit | null {
  const p = m.payload;
  const text = typeof p.text === 'string' ? p.text : '';
  const documentId = typeof p.documentId === 'string' ? p.documentId : '';
  if (!text || !documentId) return null;

  return {
    documentId,
    title: typeof p.title === 'string' ? p.title : '未命名文档',
    source: typeof p.source === 'string' && p.source ? p.source : undefined,
    category: typeof p.category === 'string' ? p.category : 'general',
    chunkIndex: typeof p.chunkIndex === 'number' ? p.chunkIndex : 0,
    text,
    score: m.score,
  };
}

/** 向量条数与切片数必须一一对应；对不上就是 bug，不能静默错位 */
function requireVector(v: number[] | undefined, i: number): number[] {
  if (!Array.isArray(v)) {
    throw new BizException(
      ErrorCode.AiOutputInvalid,
      { index: i },
      '向量化返回的条数与切片数不一致，已中止（避免向量与文本错位）',
    );
  }
  return v;
}
