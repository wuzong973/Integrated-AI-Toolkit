import { Controller, Headers, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUser, Public, type AuthUser } from '../../common/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { OrderPayService } from './order-pay.service';

/** 带 `rawBody` 的请求 —— 由 `main.ts` 的 `json({ verify })` 挂上去（验签必须用原始报文） */
type RawBodyRequest = Request & { rawBody?: string };

/** 发起支付返回体（客户端拿 `prepay` 去调 `wx.requestPayment`） */
export interface PrepayResponse {
  orderNo: string;
  amountCents: number;
  prepay: unknown;
  /** 支付网关回调地址 —— 接真实支付时把它填进统一下单请求 */
  notifyUrl: string;
}

/**
 * 订单 · 支付（M3-12）
 *
 * 两个路由共用 `orders` 前缀，但语义相反：
 *   · `POST /orders/:id/pay`   —— **需登录**，买家发起支付；
 *   · `POST /orders/pay/notify` —— **公开**，支付网关回调，安全性靠验签（微信不带我们的 JWT）。
 *
 * ⚠️ 声明顺序敏感：`pay/notify` 必须在 `:id/pay` **之前**。
 * 两者都是三段路径，若 `:id` 先声明，`pay` 会被当成订单 id 捕获 ——
 * 这类"被通配吃掉"的坑本项目在 `/tools/categories` 上踩过一次（M1-01）。
 */
@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrderPayController {
  constructor(private readonly pay: OrderPayService) {}

  @Public()
  @Post('pay/notify')
  @ApiOperation({ summary: '支付结果回调（支付网关调用；验签代替登录态）' })
  notify(
    @Req() req: RawBodyRequest,
    @Headers() headers: Record<string, string>,
  ): Promise<{ code: string; message: string }> {
    // 必须用 rawBody：真实微信的签名是对**原始报文**算的，
    // 用解析后再 JSON.stringify 的字符串会因键序/空格差异导致验签失败
    return this.pay.handleNotify(headers, req.rawBody ?? '');
  }

  @Post(':id/pay')
  @ApiOperation({ summary: '发起支付：返回 wx.requestPayment 所需参数' })
  prepay(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<PrepayResponse> {
    return this.pay.prepay(user.id, id);
  }
}
