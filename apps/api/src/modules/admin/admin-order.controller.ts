import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AdminOrderListQuerySchema,
  AdminOrderResolveSchema,
  AdminPermission,
  type AdminOrderListQueryDto,
  type AdminOrderResolveDto,
} from '@qz/core';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { CurrentAdmin, RequirePermission, type AdminContext } from './admin.decorators';
import { AdminOrderService } from './admin-order.service';
import type { AdminOrderDetail, AdminOrderItem } from './admin-order.service';
import { AdminPermissionGuard } from './admin-permission.guard';

/**
 * 订单与纠纷裁决（任务清单 M0-23）
 *
 * 默认视图给"争议"（`?disputed=true`）—— 后台进来第一件想做的事是
 * "有没有要我判的"，而不是从头翻全站订单。
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/orders')
@UseGuards(JwtAuthGuard, AdminPermissionGuard)
export class AdminOrderController {
  constructor(private readonly orders: AdminOrderService) {}

  @Get()
  @RequirePermission(AdminPermission.OrderView)
  @ApiOperation({ summary: '订单列表（disputed=true 只看有争议的）' })
  list(
    @Query(new ZodValidationPipe(AdminOrderListQuerySchema)) query: AdminOrderListQueryDto,
  ): Promise<{ list: AdminOrderItem[]; total: number }> {
    return this.orders.list(query);
  }

  @Get(':id')
  @RequirePermission(AdminPermission.OrderView)
  @ApiOperation({ summary: '订单详情（含完整时间线）' })
  detail(@Param('id') id: string): Promise<AdminOrderDetail> {
    return this.orders.detail(id);
  }

  @Post(':id/resolve')
  @RequirePermission(AdminPermission.OrderSettle)
  @ApiOperation({ summary: '裁决：放款给服务者 / 退款给买家（必须写理由）' })
  resolve(
    @CurrentAdmin() admin: AdminContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AdminOrderResolveSchema)) dto: AdminOrderResolveDto,
  ): Promise<AdminOrderDetail> {
    return this.orders.resolve(id, dto, { userId: admin.userId });
  }
}
