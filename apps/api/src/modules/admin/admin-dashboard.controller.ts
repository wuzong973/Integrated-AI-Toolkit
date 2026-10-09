import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AdminAuditListQuerySchema,
  AdminPermission,
  type AdminAuditListQueryDto,
} from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { RequirePermission } from './admin.decorators';
import { AdminDashboardService, type AdminDashboardStats } from './admin-dashboard.service';
import { AdminPermissionGuard } from './admin-permission.guard';

/** 操作日志（后台自己产生的记录，不随任何业务表级联删除） */
export interface AdminAuditItem {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: string;
}

/**
 * 数据看板（任务清单 M0-23）
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/dashboard')
@UseGuards(JwtAuthGuard, AdminPermissionGuard)
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  @Get('stats')
  @RequirePermission(AdminPermission.DashboardView)
  @ApiOperation({ summary: '看板统计（含待办提醒）' })
  stats(): Promise<AdminDashboardStats> {
    return this.dashboard.stats();
  }
}

/**
 * 操作日志（任务清单 M0-23）
 *
 * 单列 `audit:view` 而不并进看板权限：审计日志会记录**谁封了谁、谁放了款**，
 * 属于敏感信息。默认给审核员与财务（他们要做申诉复核），但不给运营。
 * 这一页是"事后追责"的入口，访问本身也应当被限制。
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/audit')
@UseGuards(JwtAuthGuard, AdminPermissionGuard)
export class AdminAuditController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: AppLogger,
  ) {}

  @Get()
  @RequirePermission(AdminPermission.AuditView)
  @ApiOperation({ summary: '操作日志（按操作人 / 动作 / 目标筛）' })
  async list(
    @Query(new ZodValidationPipe(AdminAuditListQuerySchema)) query: AdminAuditListQueryDto,
  ): Promise<{ list: AdminAuditItem[]; total: number }> {
    const where = {
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.action ? { action: { contains: query.action } } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.size,
        take: query.size,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    this.logger.debug(`查询操作日志 ${rows.length} 条`, 'AdminAudit');

    return {
      list: rows.map((r) => ({
        id: r.id,
        actorId: r.actorId,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        before: r.before,
        after: r.after,
        ip: r.ip,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
    };
  }
}
