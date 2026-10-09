import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  SelectWordBookSchema,
  VocabAnswerSchema,
  VocabAudioQuerySchema,
  type SelectWordBookDto,
  type VocabAnswerDto,
  type VocabAudioQueryDto,
} from '@qz/core';

import { CurrentUser, type AuthUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import type {
  VocabAnswerResult,
  VocabAudioResult,
  VocabBookItem,
  VocabStatsResult,
  VocabTodayResult,
} from './dto/vocab.dto';
import { VocabAnswerService } from './vocab-answer.service';
import { VocabAudioService } from './vocab-audio.service';
import { VocabBookService } from './vocab-book.service';
import { VocabPlanService } from './vocab-plan.service';
import { VocabStatsService } from './vocab-stats.service';

/**
 * 记单词 / 四六级词汇训练（任务清单 M4-15）
 *
 * 路径前缀 `/vocab`（对外全路径 `/api/v1/vocab`）。
 *
 * ## 整个模块**全部要求登录**，所以守卫挂在类上且没有 `@Public()`
 *
 * 与本模块的对照是服务市场（那里 `GET` 与 `GET :id` 标了 `@Public()`）——
 * 学习进度、打卡日历、复习队列每一项都是"我的"，没有可公开的部分。
 *
 * ## 路由顺序（⚠️ 改动时别调）
 *
 * `GET books` / `GET today` / `GET stats` 都是**固定段**，与 `words/:wordId/audio`
 * 段数不同，不会被误捕。但仍保持"固定段在前、参数段在后"的写法：
 * 一旦将来加了 `GET :bookCode` 这类路由，顺序错了就会出现
 * `/vocab/books` 被当成 bookCode="books" 的静默 404（`/tools/categories` 踩过，M1-01）。
 */
@ApiTags('vocab')
@Controller('vocab')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class VocabController {
  // 注入名带 `Svc` 后缀：方法名要与路由同名（`books` / `stats`），
  // 属性名若不区分，实例属性会**遮蔽**原型上的同名方法，路由照旧注册、
  // 调用时才炸（`this.books` 是服务而不是处理函数）
  constructor(
    private readonly bookSvc: VocabBookService,
    private readonly plan: VocabPlanService,
    private readonly answers: VocabAnswerService,
    private readonly statsSvc: VocabStatsService,
    private readonly audio: VocabAudioService,
  ) {}

  @Get('books')
  @ApiOperation({ summary: '词书列表（含我的进度；planned 的词书不能选）' })
  books(@CurrentUser() user: AuthUser): Promise<VocabBookItem[]> {
    return this.bookSvc.listBooks(user.id);
  }

  @Post('books/select')
  @ApiOperation({ summary: '选为当前词书（可顺带改每日目标），返回更新后的列表' })
  select(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(SelectWordBookSchema)) dto: SelectWordBookDto,
  ): Promise<VocabBookItem[]> {
    return this.bookSvc.selectBook(user.id, dto);
  }

  @Get('today')
  @ApiOperation({ summary: '今日队列（新词 + 到期复习）；没有词书时一并返回列表' })
  today(@CurrentUser() user: AuthUser): Promise<VocabTodayResult> {
    return this.plan.today(user.id);
  }

  @Post('answer')
  @ApiOperation({ summary: '提交作答（只传选项 key，对错由服务端算）' })
  answer(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(VocabAnswerSchema)) dto: VocabAnswerDto,
  ): Promise<VocabAnswerResult> {
    return this.answers.answer(user.id, dto);
  }

  @Get('stats')
  @ApiOperation({ summary: '学习统计（连续天数 / 正确率 / 最近 30 天打卡日历）' })
  stats(@CurrentUser() user: AuthUser): Promise<VocabStatsResult> {
    return this.statsSvc.stats(user.id);
  }

  @Get('words/:wordId/audio')
  @ApiOperation({ summary: '单词发音（base64；按 音色+单词 缓存）' })
  speak(
    @Param('wordId') wordId: string,
    @Query(new ZodValidationPipe(VocabAudioQuerySchema)) query: VocabAudioQueryDto,
  ): Promise<VocabAudioResult> {
    return this.audio.speak(wordId, query);
  }
}