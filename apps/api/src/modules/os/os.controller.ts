import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ConfirmOsNodeSchema,
  CreateOsSessionSchema,
  OsIntentSchema,
  OsPlanSchema,
  PublishOsNodeSchema,
  SendOsMessageSchema,
  type ConfirmOsNodeDto,
  type CreateOsSessionDto,
  type OsIntentDto,
  type OsIntentResult,
  type OsPlanDto,
  type OsPlanResult,
  type PublishOsNodeDto,
  type SendOsMessageDto,
} from '@qz/core';

import { CurrentUser, type AuthUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { TaskItemDto } from '../station/station.service';

import { OsRunService } from './os-run.service';
import type { OsRunView } from './os-run.view';
import {
  OsService,
  type OsMessageItem,
  type OsSessionItem,
} from './os.service';

/**
 * 青智 OS（AI 助手）接口
 *
 * 全部需要登录：这些接口会真实调用大模型（消耗 token 与额度），
 * 且会话与消息都归属到具体用户，匿名调用没有意义。
 *
 * 路由与小程序 `apps/mp/utils/api.ts` 的 `osApi` 一一对应 —— 改路径必须两边一起改。
 */
@ApiTags('os')
@Controller('os')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class OsController {
  constructor(
    private readonly os: OsService,
    private readonly runs: OsRunService,
  ) {}

  @Post('sessions')
  @ApiOperation({ summary: '新建会话' })
  createSession(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateOsSessionSchema)) dto: CreateOsSessionDto,
  ): Promise<{ id: string }> {
    return this.os.createSession(user.id, dto);
  }

  @Get('sessions')
  @ApiOperation({ summary: '我的会话列表' })
  listSessions(@CurrentUser() user: AuthUser): Promise<OsSessionItem[]> {
    return this.os.listSessions(user.id);
  }

  /**
   * 助手可调用的 AI 能力清单。
   *
   * ⚠️ 路由声明在 `sessions/:id/messages` **之前**不是必须的，但放在
   * `sessions` 系列之前更直观（静态路径优先于带参路径是 Express 的既有行为，
   * 这里两条路径的第一段就不同，不冲突）。
   *
   * 返回的 `dropped` 是**被对账丢弃**的能力与原因 —— 必须如实返回，
   * 否则"某个能力为什么没进助手"就只能靠翻日志。
   */
  @Get('capabilities')
  @ApiOperation({ summary: '助手可调用的 AI 能力清单（含被丢弃项与原因）' })
  capabilities(): Promise<{ available: unknown[]; dropped: unknown[] }> {
    return this.os.listCapabilities();
  }

  @Get('sessions/:id/messages')
  @ApiOperation({ summary: '会话消息（按时间正序）' })
  listMessages(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<OsMessageItem[]> {
    return this.os.listMessages(user.id, id);
  }

  @Post('sessions/:id/messages')
  @ApiOperation({ summary: '发送消息（返回模型回复）' })
  sendMessage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SendOsMessageSchema)) dto: SendOsMessageDto,
  ): Promise<{ messageId: string; reply: OsMessageItem }> {
    return this.os.sendMessage(user.id, id, dto);
  }

  /**
   * 意图识别。
   *
   * ⚠️ 模型不可用时会返回错误，客户端**必须**保留离线兜底
   *（`pages/os/index.ts` 的 `localIntent`）—— 否则断网时 AI 页会完全无响应。
   */
  @Post('intent')
  @ApiOperation({ summary: '意图识别（用大模型）' })
  intent(
    @Body(new ZodValidationPipe(OsIntentSchema)) dto: OsIntentDto,
  ): Promise<OsIntentResult> {
    return this.os.recognizeIntent(dto.text);
  }

  /**
   * 任务规划（M2-05，`plan` 档）。
   *
   * 与 `/os/intent` 分开而不是合并：意图识别是**分类**（要快、可超时降级），
   * 规划是**推理**（要准、可以慢一点）。合并后两者只能共用同一个超时与同一个模型档位，
   * 调哪个都会伤到另一个。
   *
   * ⚠️ 返回的 `degraded` 必须如实展示：`true` 表示这次**没有规划成功**，
   * 客户端要用意图识别给的子任务清单顶上，而不是假装拿到了一张计划。
   *
   * **M2-06 追加**：请求带上 `sessionId` 时，服务端会把这张计划落成 Run，
   * 响应里多出 `runId` —— 看板页（`pkg-os/plan`）与 confirm / publish 三条路由
   * 都靠它工作。不带 `sessionId` 时行为与 M2-05 一致（只回计划、不建 Run）。
   */
  @Post('plan')
  @ApiOperation({ summary: '任务规划（把目标拆成带依赖的 DAG；带 sessionId 时持久化为 Run）' })
  plan(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(OsPlanSchema)) dto: OsPlanDto,
  ): Promise<OsPlanResult> {
    const owner = dto.sessionId ? { userId: user.id, sessionId: dto.sessionId } : undefined;
    return this.os.plan(dto.goal, owner);
  }

  // ---------- 计划 Run 与节点操作（M2-06）----------

  /**
   * 看板数据源（文档 9.2.4 `GET /os/runs/{runId}`）。
   *
   * 响应形状**刻意对齐** `apps/mp/pkg-os/plan/index.ts` 的 `applyRun()`
   * （`{ goal, stages: [{ name, nodes: [...] }] }`），
   * 前端接上后只需要关掉 `demo` 角标，不需要改渲染逻辑。
   * 完整字段清单见 `os-run.view.ts` 的 `OsRunView`。
   */
  @Get('runs/:id')
  @ApiOperation({ summary: '计划 Run 与节点状态（看板数据源）' })
  run(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<OsRunView> {
    return this.runs.getRun(user.id, id);
  }

  /** 确认整份计划、开始执行（Run: `awaiting_confirm → running`） */
  @Post('runs/:id/confirm')
  @ApiOperation({ summary: '确认计划开始执行（Run 级）' })
  confirmPlan(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<OsRunView> {
    return this.runs.confirmPlan(user.id, id);
  }

  /**
   * HITL 节点确认（节点: `awaiting_hitl → running`）。
   *
   * 非法迁移由状态机拦下并翻成 **40904**，而不是"再点一次也成功"。
   * 与上面那条 Run 级 confirm 的区别见 `OsRunService.confirmPlan` 的注释。
   */
  @Post('runs/:id/nodes/:nodeId/confirm')
  @ApiOperation({ summary: '确认 HITL 节点（人工拍板）' })
  confirmNode(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('nodeId') nodeId: string,
    @Body(new ZodValidationPipe(ConfirmOsNodeSchema)) dto: ConfirmOsNodeDto,
  ): Promise<OsRunView> {
    return this.runs.confirmNode(user.id, id, nodeId, dto);
  }

  /**
   * 人力节点一键发布到驿站（文档 9.2.4 + M3-21）。
   *
   * 复用 `StationWriteService.publish()`（M3-06 那条**已定死**的发布入口：
   * 分类校验、送审、`taskNo`、直接 `published`），并给任务写上 `refRunId`，
   * 于是"计划 → 需求 → 订单"整条链可回溯。
   *
   * `categoryId` 必填：分类决定谁能看到这条需求，猜不得（见 core 的
   * `PublishOsNodeSchema` 说明）。
   */
  @Post('runs/:id/nodes/:nodeId/publish')
  @ApiOperation({ summary: '把人力节点发布为驿站需求' })
  publishNode(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('nodeId') nodeId: string,
    @Body(new ZodValidationPipe(PublishOsNodeSchema)) dto: PublishOsNodeDto,
  ): Promise<{ run: OsRunView; task: TaskItemDto }> {
    return this.runs.publishNode(user.id, id, nodeId, dto);
  }
}
