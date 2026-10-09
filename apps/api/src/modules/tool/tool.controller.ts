import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  InvokeToolSchema,
  ToolListQuerySchema,
  type InvokeToolDto,
  type ToolListQueryDto,
} from '@qz/core';

import { CurrentUser, Public, type AuthUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { ToolInvokeService, type InvokeResult } from './tool-invoke.service';
import { ToolService, type ToolCategoryItem, type ToolDetail, type ToolItem } from './tool.service';

/**
 * 工具目录与调用（任务清单 M1-01 / M1-02）
 *
 * 目录三个接口为**公开只读**：工具箱与首页在未登录时也要能浏览
 * （文档 4.4：工具箱是免登录入口，执行工具才需要登录）。
 * 调用入口需要登录，因为要扣配额、建作业、记归属。
 *
 * ⚠️ 路由顺序敏感：`categories` 必须声明在 `:name` 之前，
 * 否则 `/tools/categories` 会被 `:name` 捕获（name='categories'）而返回 404。
 */
@ApiTags('tool')
@Controller('tools')
export class ToolController {
  constructor(
    private readonly tools: ToolService,
    private readonly invokeService: ToolInvokeService,
  ) {}

  @Public()
  @Get('categories')
  @ApiOperation({ summary: '工具分类列表（仅用户可见分类）' })
  categories(): Promise<ToolCategoryItem[]> {
    return this.tools.listCategories();
  }

  @Public()
  @Get()
  @ApiOperation({ summary: '工具列表（支持分类筛选与关键词搜索）' })
  list(
    @Query(new ZodValidationPipe(ToolListQuerySchema)) query: ToolListQueryDto,
  ): Promise<ToolItem[]> {
    return this.tools.listTools(query);
  }

  @Public()
  @Get(':name')
  @ApiOperation({ summary: '工具详情（含 inputSchema，用于执行页动态渲染表单）' })
  detail(@Param('name') name: string): Promise<ToolDetail> {
    return this.tools.getTool(name);
  }

  @Post(':name/invoke')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '调用工具（同步直接返回结果，异步返回 jobId）' })
  invoke(
    @CurrentUser() user: AuthUser,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(InvokeToolSchema)) dto: InvokeToolDto,
    /** 写接口幂等键（文档 9.4）；小程序请求层已自动为所有非 GET 请求带上 */
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<InvokeResult> {
    return this.invokeService.invoke(user.id, name, dto, idempotencyKey);
  }
}
