import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AdminJobListQuerySchema,
  AdminPermission,
  AdminToolStatusSchema,
  type AdminJobListQueryDto,
  type AdminToolStatusDto,
} from '@qz/core';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { CurrentAdmin, RequirePermission, type AdminContext } from './admin.decorators';
import { AdminJobService } from './admin-job.service';
import type { AdminJobDetail, AdminJobItem, AdminToolItem } from './admin-job.service';
import { AdminPermissionGuard } from './admin-permission.guard';

/**
 * 工具与作业监控（任务清单 M0-23）
 *
 * 只读能力（`ToolView` / `JobView`）与写能力（`JobManage`）分开：
 * 客服需要看"这个用户的作业为什么失败"，但不需要重跑或下线工具。
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/tools')
@UseGuards(JwtAuthGuard, AdminPermissionGuard)
export class AdminJobController {
  constructor(private readonly jobs: AdminJobService) {}

  @Get()
  @RequirePermission(AdminPermission.ToolView)
  @ApiOperation({ summary: '工具列表（含近 7 天作业量，用于识别"没人用"与"全挂了"）' })
  tools(): Promise<AdminToolItem[]> {
    return this.jobs.listTools();
  }

  @Put(':name/status')
  @RequirePermission(AdminPermission.JobManage)
  @ApiOperation({ summary: '工具上下线（active / planned）' })
  updateToolStatus(
    @CurrentAdmin() admin: AdminContext,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(AdminToolStatusSchema)) dto: AdminToolStatusDto,
  ): Promise<AdminToolItem> {
    return this.jobs.updateToolStatus(name, dto.status, admin.userId);
  }

  @Get('jobs')
  @RequirePermission(AdminPermission.JobView)
  @ApiOperation({ summary: '作业列表（跨用户）' })
  listJobs(
    @Query(new ZodValidationPipe(AdminJobListQuerySchema)) query: AdminJobListQueryDto,
  ): Promise<{ list: AdminJobItem[]; total: number }> {
    return this.jobs.listJobs(query);
  }

  @Get('jobs/:id')
  @RequirePermission(AdminPermission.JobView)
  @ApiOperation({ summary: '作业详情（含参数、产物、质量扣分项）' })
  jobDetail(@Param('id') id: string): Promise<AdminJobDetail> {
    return this.jobs.jobDetail(id);
  }

  @Post('jobs/:id/retry')
  @RequirePermission(AdminPermission.JobManage)
  @ApiOperation({ summary: '重跑作业（以原用户身份，积分记在原用户账上）' })
  retryJob(
    @CurrentAdmin() admin: AdminContext,
    @Param('id') id: string,
  ): Promise<AdminJobItem> {
    return this.jobs.retryJob(id, admin.userId);
  }

  @Post('jobs/:id/cancel')
  @RequirePermission(AdminPermission.JobManage)
  @ApiOperation({ summary: '取消作业' })
  cancelJob(
    @CurrentAdmin() admin: AdminContext,
    @Param('id') id: string,
  ): Promise<AdminJobItem> {
    return this.jobs.cancelJob(id, admin.userId);
  }
}
