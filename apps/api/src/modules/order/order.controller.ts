import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AcceptReviewSchema,
  CreateOrderSchema,
  DeliverSchema,
  RefundSchema,
  RequestRevisionSchema,
  type AcceptReviewDto,
  type CreateOrderDto,
  type DeliverDto,
  type RefundDto,
  type RequestRevisionDto,
} from '@qz/core';

import { CurrentUser, type AuthUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { OrderReviewService, type ReviewListDto } from './order-review.service';
import { OrderPayService } from './order-pay.service';
import { OrderService, type OrderItemDto } from './order.service';

/**
 * 订单（任务清单 M3-11 / M3-12 / M3-14 / M3-15 / M3-16）
 *
 * 路由与 `apps/mp/utils/api.ts` 的 `orderApi` **一一对应**（契约早已冻结）。
 * 全部需要登录 —— 订单含金额与交付物，不属于公开数据。
 *
 * ⚠️ 路由顺序：`GET /orders/:id` 是单段通配，必须在**字面量路径之后**声明。
 * 本项目的同类坑是 `/tools/categories`（M1-01）与 `POST /orders/pay/notify`
 * （见 `order-pay.controller.ts`）。`/orders/reviews/*` 是两段路径，
 * 理论上不会被单段的 `:id` 捕获，但**仍然显式放在它前面**：
 * 一旦以后有人加 `GET /orders/reviews`（单段）或把 `:id` 改成 `:id/*`，
 * 靠"段数不同"侥幸不冲突的写法会立刻变成"请求进了详情、返回 404 订单不存在"。
 * 支付回调 `POST /orders/pay/notify` 由 `OrderPayController` 承担（三段且第三段不同，
 * 不会被 `:id/deliver` 捕获）。
 */
@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrderController {
  constructor(
    private readonly order: OrderService,
    private readonly pay: OrderPayService,
    private readonly reviews: OrderReviewService,
  ) {}

  @Get()
  @ApiOperation({ summary: '我的订单（role=buyer 默认｜provider=我卖出的）' })
  list(
    @CurrentUser() user: AuthUser,
    @Query('role') role?: string,
    @Query('status') status?: string,
  ): Promise<{ list: OrderItemDto[]; total: number }> {
    // role 非法值一律按 buyer 处理：这里不做 400，是因为"传错角色"不该让用户看不到自己的订单
    return this.order.list(user.id, {
      role: role === 'provider' ? 'provider' : 'buyer',
      status,
    });
  }

  // ---- 评价（M3-16）：字面量路由必须整体排在 `:id` 之前，见文件头 ⚠️ ----

  @Get('reviews/received')
  @ApiOperation({ summary: '别人给我的评价（匿名评价不返回对方昵称与 peerId）' })
  reviewsReceived(@CurrentUser() user: AuthUser): Promise<ReviewListDto> {
    return this.reviews.received(user.id);
  }

  @Get('reviews/given')
  @ApiOperation({ summary: '我给出的评价（对方昵称照常返回）' })
  reviewsGiven(@CurrentUser() user: AuthUser): Promise<ReviewListDto> {
    return this.reviews.given(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: '订单详情（仅买卖双方可见）' })
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<OrderItemDto> {
    return this.order.detail(user.id, id);
  }

  @Post()
  @ApiOperation({ summary: '下单（担保交易，ADR-07）' })
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateOrderSchema)) dto: CreateOrderDto,
  ): Promise<OrderItemDto> {
    return this.order.create(user.id, dto);
  }

  @Post(':id/deliver')
  @ApiOperation({ summary: '提交交付物（服务者）' })
  deliver(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(DeliverSchema)) dto: DeliverDto,
  ): Promise<OrderItemDto> {
    return this.order.deliver(user.id, id, dto);
  }

  @Post(':id/accept')
  @ApiOperation({ summary: '验收放款（下单方）：置为已完成、给服务者入账，并结算评价与信用分' })
  accept(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AcceptReviewSchema)) dto: AcceptReviewDto,
  ): Promise<OrderItemDto> {
    return this.pay.accept(user.id, id, dto);
  }

  @Post(':id/revision')
  @ApiOperation({ summary: '要求修改（验收方）：待验收回退为服务中，最多 3 次' })
  revision(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RequestRevisionSchema)) dto: RequestRevisionDto,
  ): Promise<OrderItemDto> {
    return this.order.requestRevision(user.id, id, dto.reason);
  }

  @Post(':id/refund')
  @ApiOperation({ summary: '申请退款（买卖双方均可发起）' })
  refund(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RefundSchema)) dto: RefundDto,
  ): Promise<OrderItemDto> {
    return this.pay.refund(user.id, id, dto);
  }
}
