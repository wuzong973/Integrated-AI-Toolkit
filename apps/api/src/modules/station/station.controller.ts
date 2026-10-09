import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApplyTaskSchema,
  MatchQuerySchema,
  ParseRequirementSchema,
  PublishTaskSchema,
  SelectProviderSchema,
  TaskListQuerySchema,
  type ApplyTaskDto,
  type MatchQueryDto,
  type ParseRequirementDto,
  type PublishTaskDto,
  type SelectProviderDto,
  type TaskListQueryDto,
} from '@qz/core';

import { CurrentUser, Public, type AuthUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { StationMatchService, type MatchedProviderDto } from './station-match.service';
import { StationParseService } from './station-parse.service';
import type { ParsedDraft } from './station-parse';
import { StationService, type ApplicationItemDto, type TaskItemDto } from './station.service';
import { StationWriteService } from './station-write.service';

/**
 * 驿站（任务清单 M3-01 / M3-06 / M3-07 / M3-08 / M3-09 / M3-10）
 *
 * ## 为什么类上挂了 `JwtAuthGuard` 却还有 `@Public()`
 *
 * 大厅与需求详情**不登录也要能浏览**（先让用户看见价值，报名/发布才要求登录），
 * 所以这两条标 `@Public()`。但守卫仍然要挂 ——
 * 它对公开接口的语义是"**有 token 也解析**"，于是登录用户在浏览大厅时
 * 能拿到**属于自己的匹配度**，而匿名用户拿到的是不带该字段的同一份数据。
 *
 * 不挂守卫的话 `req.user` 永远是 undefined，匹配度就永远算不出来 ——
 * 而那种情况下前端只能自己编一个（这正是此前工作台干的事）。
 *
 * ## 路由顺序
 *
 * `GET match` 声明在 `GET tasks/:id` 之前。两者段数不同（1 vs 2），
 * 理论上不会误捕，但把更具体的静态路径排在前面是不依赖这种巧合的稳妥做法
 *（`/tools/categories` 曾被 `/tools/:id` 捕过，M1-01）。
 */
@ApiTags('station')
@Controller('station')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class StationController {
  constructor(
    private readonly station: StationService,
    private readonly writes: StationWriteService,
    private readonly parse: StationParseService,
    private readonly match: StationMatchService,
  ) {}

  @Public()
  @Get('categories')
  @ApiOperation({ summary: '服务分类（M3-01）' })
  categories(): Promise<{ id: string; name: string; icon?: string }[]> {
    return this.station.categories();
  }

  @Public()
  @Get('tasks')
  @ApiOperation({ summary: '任务大厅（默认只看已发布；登录后附带匹配度）' })
  tasks(
    @Query(new ZodValidationPipe(TaskListQuerySchema)) query: TaskListQueryDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<{ list: TaskItemDto[]; total: number }> {
    return this.station.listTasks(query, user?.id);
  }

  @Get('match')
  @ApiOperation({ summary: '智能匹配：为任务推荐服务者（M3-09）' })
  matched(
    @Query(new ZodValidationPipe(MatchQuerySchema)) query: MatchQueryDto,
  ): Promise<MatchedProviderDto[]> {
    return this.match.matchProviders(query.taskId, query.limit);
  }

  @Public()
  @Get('tasks/:id')
  @ApiOperation({ summary: '任务详情（登录后附带匹配度）' })
  task(@Param('id') id: string, @CurrentUser() user?: AuthUser): Promise<TaskItemDto> {
    return this.station.getTask(id, user?.id);
  }

  @Get('tasks/:id/applications')
  @ApiOperation({ summary: '报名者列表（仅发布者可见）' })
  applications(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<ApplicationItemDto[]> {
    return this.station.listApplications(user.id, id);
  }

  @Post('tasks')
  @ApiOperation({ summary: '发布需求（M3-06）' })
  publish(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(PublishTaskSchema)) dto: PublishTaskDto,
  ): Promise<TaskItemDto> {
    return this.writes.publish(user.id, dto);
  }

  @Post('parse')
  @ApiOperation({ summary: 'AI 极速发布：一句话 → 结构化草稿（M3-07）' })
  parseRequirement(
    @Body(new ZodValidationPipe(ParseRequirementSchema)) dto: ParseRequirementDto,
  ): Promise<ParsedDraft & { priceHint?: string }> {
    return this.parse.parseRequirement(dto.text);
  }

  @Post('tasks/:id/apply')
  @ApiOperation({ summary: '报名 / 抢单（M3-10）' })
  apply(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ApplyTaskSchema)) dto: ApplyTaskDto,
  ): Promise<{ applicationId: string }> {
    return this.writes.apply(user.id, id, dto);
  }

  @Post('tasks/:id/select')
  @ApiOperation({ summary: '选定服务者 → 生成担保订单（M3-10 + M3-11）' })
  select(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SelectProviderSchema)) dto: SelectProviderDto,
  ): Promise<{ taskId: string; orderId: string; orderNo: string; amount: number }> {
    return this.writes.select(user.id, id, dto);
  }

  @Post('tasks/:id/close')
  @ApiOperation({ summary: '关闭需求（M3-08）' })
  close(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<{ status: string }> {
    return this.writes.close(user.id, id);
  }
}
