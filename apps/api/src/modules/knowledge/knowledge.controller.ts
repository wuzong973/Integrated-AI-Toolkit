import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  KnowledgeAskSchema,
  KnowledgeIngestSchema,
  KnowledgeSearchSchema,
  Role,
  type KnowledgeAnswer,
  type KnowledgeAskDto,
  type KnowledgeHit,
  type KnowledgeIngestDto,
  type KnowledgeIngestResult,
  type KnowledgeSearchDto,
} from '@qz/core';

import { Roles } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { KnowledgeService } from './knowledge.service';

/**
 * 校园知识库（M4-06）
 *
 * ## 权限划分（不是"登录就行"）
 *
 * · **读**（`/search`、`/ask`）—— 任何登录用户可用：知识库本来就是给学生查的；
 * · **写**（`POST/DELETE /documents`）—— 仅 `Role.Admin`：
 *   知识库是**全站共享**的，普通用户灌一篇错内容，所有人的检索结果都会被污染，
 *   而这类问题不会报错、只会让 AI 答错 —— 校园制度答错的代价是学生按错流程办事。
 *
 * ## 为什么不是 @Public()
 *
 * 检索会真实调用 embedding 与 LLM（消耗额度），匿名开放等于把额度挂在公网上。
 */
@ApiTags('knowledge')
@Controller('knowledge')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Post('documents')
  @Roles(Role.Admin)
  @ApiOperation({ summary: '灌库：切片 + 向量化 + 写入向量库（仅管理员）' })
  ingest(
    @Body(new ZodValidationPipe(KnowledgeIngestSchema)) dto: KnowledgeIngestDto,
  ): Promise<KnowledgeIngestResult> {
    return this.knowledge.ingest(dto);
  }

  @Get('documents')
  @ApiOperation({ summary: '知识库文档列表' })
  list(): Promise<
    { id: string; title: string; category: string; source?: string; createdAt: string }[]
  > {
    return this.knowledge.list();
  }

  @Delete('documents/:id')
  @Roles(Role.Admin)
  @ApiOperation({ summary: '删除文档（同时清理向量库切片，仅管理员）' })
  remove(@Param('id') id: string): Promise<{ deleted: true }> {
    return this.knowledge.remove(id);
  }

  @Post('search')
  @ApiOperation({ summary: '语义检索：返回命中的切片与相似度' })
  search(
    @Body(new ZodValidationPipe(KnowledgeSearchSchema)) dto: KnowledgeSearchDto,
  ): Promise<KnowledgeHit[]> {
    return this.knowledge.search(dto.query, dto.topK);
  }

  /**
   * 带引用的问答。
   *
   * ⚠️ 响应里的 `grounded` 必须如实展示：`false` 表示**没有检索到任何依据**，
   * 此时 `answer` 是一句"没找到"，而不是模型编出来的答案。
   */
  @Post('ask')
  @ApiOperation({ summary: 'RAG 问答（检索 + 带来源引用的回答）' })
  ask(
    @Body(new ZodValidationPipe(KnowledgeAskSchema)) dto: KnowledgeAskDto,
  ): Promise<KnowledgeAnswer> {
    return this.knowledge.ask(dto.question);
  }
}
