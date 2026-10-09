import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AdminPermission,
  AdminVerificationListQuerySchema,
  ReviewVerificationSchema,
  type AdminVerificationListQueryDto,
  type ReviewVerificationDto,
} from '@qz/core';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { CurrentAdmin, RequirePermission, type AdminContext } from './admin.decorators';
import { AdminPermissionGuard } from './admin-permission.guard';
import { AdminContentService } from './admin-content.service';
import type { AdminVerificationItem } from './admin-content.service';

/**
 * 内容审核队列（任务清单 M0-23）
 *
 * 复用 `ReviewVerificationSchema`（与 C 端审核接口同一个 schema）：
 * 它带 `refine` 强制"驳回必须写原因"，这个约束在两边都必须成立 ——
 * 后台驳回如果不写原因，用户看到"未通过"却不知道改什么，只会反复重交。
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/content')
@UseGuards(JwtAuthGuard, AdminPermissionGuard)
export class AdminContentController {
  constructor(private readonly content: AdminContentService) {}

  @Get('verifications')
  @RequirePermission(AdminPermission.ContentView)
  @ApiOperation({ summary: '认证申请队列（默认全部状态，便于回溯历史结论）' })
  list(
    @Query(new ZodValidationPipe(AdminVerificationListQuerySchema))
    query: AdminVerificationListQueryDto,
  ): Promise<{ list: AdminVerificationItem[]; total: number }> {
    return this.content.listVerifications(query);
  }

  @Post('verifications/:id/review')
  @RequirePermission(AdminPermission.ContentReview)
  @ApiOperation({ summary: '审核认证申请：通过 / 驳回（驳回必须写原因）' })
  review(
    @CurrentAdmin() admin: AdminContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReviewVerificationSchema)) dto: ReviewVerificationDto,
  ): Promise<AdminVerificationItem> {
    return this.content.review(admin.userId, id, dto);
  }
}
