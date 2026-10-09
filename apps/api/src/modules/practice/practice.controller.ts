import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  MODES_BY_MODULE,
  MODE_TITLES,
  PRACTICE_MODULE_HINTS,
  PRACTICE_MODULE_ORDER,
  PRACTICE_MODULE_TITLES,
  PracticeAudioQuerySchema,
  PracticeQueueQuerySchema,
  PracticeSubmitSchema,
  type PracticeAudioQueryDto,
  type PracticeMode,
  type PracticeQueueQueryDto,
  type PracticeSubmitDto,
} from '@qz/core';

import { CurrentUser, type AuthUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import type {
  PracticeCardsResult,
  PracticeSubmitResult,
  PracticeTodayResult,
} from './dto/practice.dto';
import { PracticeAudioService } from './practice-audio.service';
import { PracticeQueueService } from './practice-queue.service';
import { PracticeStatsService } from './practice-stats.service';
import { PracticeSubmitService } from './practice-submit.service';

/**
 * 练习中心（任务清单 M4-16）
 *
 * 路径前缀 `/practice`（对外全路径 `/api/v1/practice`）。
 *
 * ## 三个模块共用一组路由，用 `module` 区分
 *
 * 不按模块拆成 `/practice/sentence/*`、`/practice/speak/*`、`/practice/write/*`：
 * 三者的**提交语义完全一致**（都是"交一份东西、拿回判定与复习调度"），
 * 拆开会把同一份判卷逻辑抄三遍，而它们的差别只在"提交的是什么"。
 *
 * ## ⚠️ 整个模块**全部要求登录**，且**漏挂守卫不会有任何报错**
 *
 * 与本项目唯一的全局守卫（限流）不同，登录校验靠各 controller 自己挂
 * `@UseGuards(JwtAuthGuard)`。漏挂的表现是接口照常返回 200、
 * 只是 `CurrentUser` 拿到空 id（或直接 500），**没有任何提示**。
 * 2026-09-20 加 `/map` 端点时踩过一次，由 `verify:map` 抓出。
 *
 * 依赖 `AuthModule` 也必须在 `practice.module.ts` 里 import ——
 * 漏了会在**启动时**报 "Nest can't resolve dependencies of JwtAuthGuard"。
 *
 * ## 路由顺序
 *
 * `GET today` / `GET stats` 是固定段，与 `GET sentences/:id/audio` 段数不同，
 * 不会被误捕。仍保持"固定段在前"的写法，理由同 `vocab.controller.ts`。
 */
@ApiTags('practice')
@Controller('practice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class PracticeController {
  constructor(
    private readonly statsSvc: PracticeStatsService,
    private readonly queue: PracticeQueueService,
    private readonly submitSvc: PracticeSubmitService,
    private readonly audio: PracticeAudioService,
  ) {}

  @Get('today')
  @ApiOperation({ summary: '今日练习总览（三模块的计划、进度、打卡日历、连续天数）' })
  today(@CurrentUser() user: AuthUser): Promise<PracticeTodayResult> {
    return this.statsSvc.today(user.id);
  }

  /**
   * 取某模块的今日题面（一次一批，不是一题一次）。
   *
   * ## 为什么与 `today` 分开
   *
   * `today` 是"我今天该练什么"（打开练习中心就要显示），只该给计划与计数；
   * 真正带答案的题面按模块取 —— 三个模块的题面形状完全不同
   * （句子有语块、口语有音频、作文有提纲），合成一个响应会逼客户端
   * 对着一堆可空字段做判断。**三种形状各自成一个端点**，界面按入口分别调。
   *
   * ## ⚠️ 一次下发一整批，而不是"取一题 / 交一题 / 再取一题"
   *
   * 逐题拉取的单次往返更多，且用户翻回上一题时要重新请求。
   * 一批 10 题只有几十 KB，一次给全，界面本地翻页 —— 换来的体感差别很明显
   * （逐题拉取时网络抖一下，用户会卡在一道题上而不是退到入口）。
   *
   * 答案的下发仍然按模式来（中译英不下发英文），见 `dto` 文件头。
   */
  @Get('cards')
  @ApiOperation({ summary: '取某模块的今日题面（一批）；答案是否下发按模式决定' })
  async cards(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(PracticeQueueQuerySchema)) query: PracticeQueueQueryDto,
  ): Promise<PracticeCardsResult> {
    const module = query.module ?? 'sentence';
    if (module === 'sentence') {
      const plan = await this.queue.plan(user.id, 'sentence');
      const { cards, mode } = await this.queue.sentenceCards(user.id, 'sentence', plan.quota);
      return {
        module: 'sentence',
        modes: [...MODES_BY_MODULE.sentence],
        // ⚠️ 必须把 `mode` 透出去：客户端靠它决定"要不要显示砖块、要不要隐藏英文"。
        // 漏传的表现是 `en` 明明为 null、界面却按连词成句渲染 —— 一片空白，且不报错。
        mode,
        quota: plan.quota,
        cards,
        topics: [],
        emptyReason: plan.emptyReason,
      };
    }
    if (module === 'speak') {
      const plan = await this.queue.plan(user.id, 'speak');
      const { cards, mode } = await this.queue.sentenceCards(user.id, 'speak', plan.quota);
      return {
        module: 'speak',
        modes: ['speak'],
        // 口语跟读**必须**下发英文（看不到句子就没法读），这里的 mode 恒为 'speak'
        mode,
        quota: plan.quota,
        // 口语与句子共用同一张 `practice_sentence` 表，只在 `speakable` 上筛
        cards,
        topics: [],
        emptyReason: plan.emptyReason,
      };
    }
    const plan = await this.queue.plan(user.id, 'write');
    return {
      module: 'write',
      modes: ['write'],
      mode: 'write',
      quota: plan.quota,
      cards: [],
      topics: await this.queue.topicCards(user.id, plan.quota + 2),
      emptyReason: plan.emptyReason,
    };
  }

  @Get('stats')
  @ApiOperation({ summary: '练习统计（与今日页同一份数据，供单独进入统计页时用）' })
  stats(@CurrentUser() user: AuthUser): Promise<PracticeTodayResult> {
    return this.statsSvc.today(user.id);
  }

  @Post('submit')
  @ApiOperation({
    summary: '提交一次练习（句子 / 口语 / 作文共用；判分与复习调度都在服务端算）',
  })
  submit(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(PracticeSubmitSchema)) dto: PracticeSubmitDto,
  ): Promise<PracticeSubmitResult> {
    return this.submitSvc.submit(user.id, dto);
  }

  @Get('sentences/:sentenceId/audio')
  @ApiOperation({ summary: '句子朗读音频（base64；按 音色+语速+句子 缓存）' })
  speak(
    @Param('sentenceId') sentenceId: string,
    @Query(new ZodValidationPipe(PracticeAudioQuerySchema)) query: PracticeAudioQueryDto,
  ): Promise<{ audio: string; format: string; cached: boolean }> {
    return this.audio.speak(sentenceId, query);
  }

  @Get('modules')
  @ApiOperation({ summary: '模块与模式清单（界面据此渲染入口，避免前端写死）' })
  modules(): {
    modules: {
      module: string;
      title: string;
      hint: string;
      modes: { mode: PracticeMode; title: string }[];
    }[];
  } {
    // ⚠️ 从 `@qz/core` 的常量生成，**不在控制器里再写一份**：
    // 那些常量是"有哪些模块/模式"的唯一来源，抄一份的结果是
    // "后端加了个新模式、界面不知道"，而这类漂移没有任何一处会报错。
    return {
      modules: PRACTICE_MODULE_ORDER.map((m) => ({
        module: m,
        title: PRACTICE_MODULE_TITLES[m],
        hint: PRACTICE_MODULE_HINTS[m],
        modes: MODES_BY_MODULE[m].map((mode) => ({ mode, title: MODE_TITLES[mode] })),
      })),
    };
  }
}
