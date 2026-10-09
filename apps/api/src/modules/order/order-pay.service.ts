import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  BizException,
  ErrorCode,
  OrderStatus,
  transitionOrder,
  type AcceptReviewDto,
  type Providers,
  type RefundDto,
} from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { PROVIDERS } from '../../infra/providers/providers.module';
import { ModerationService } from '../moderation/moderation.service';
import { NotificationType } from '../notification/dto/notification.dto';
import { NotificationService } from '../notification/notification.service';

import { recordAcceptRating } from './order-review.service';
import { OrderService, type OrderItemDto } from './order.service';

/**
 * 退款是否**自动走完仲裁**。
 *
 * 状态机是 `pending_acceptance → refund_requested → refunded` 两步，
 * 中间那步在真实业务里是"平台仲裁"。当前仲裁流程（M3-15）尚未开工，
 * 若停在 `refund_requested` 就没人能把它推到 `refunded`，
 * 端到端链路会断在这里 —— 所以先自动通过。
 *
 * ⚠️ 接入真实仲裁时把这里改成 `false`，并补管理端审批入口。
 */
const AUTO_SETTLE_REFUND = true;

/** 钱包流水类型（`wallet_ledger.type`） */
export const LEDGER_INCOME = 'income', LEDGER_REFUND = 'refund';

/**
 * 订单支付与资金（任务清单 M3-12 担保支付 / M3-14 验收放款 / M3-15 退款）
 *
 * ## 资金全程走 `PayProvider` 接口，不碰任何第三方 SDK（红线 9）
 *
 * 当前 `PROVIDER_MODE` 下 `pay` 解析为 `MockPayProvider`（无微信支付商户资质），
 * 因此**整条链路可端到端跑通并可自动化验证**。接真实支付时只需换 Provider 实现，
 * 本文件一行都不用改 —— 这正是 `PayProvider` 抽出来的意义。
 *
 * ## 三条不容妥协的纪律
 *
 * ① **回调必须验签**（文档 6.12.1）—— `verifyCallback` 返回 false 直接拒绝。
 * ② **回调金额必须与订单金额核对** —— 否则攻击者可以把 100 元的单子用 1 元回调"付掉"。
 * ③ **回调必须幂等** —— 微信会重复投递回调，重复处理会把订单状态写坏
 *    （这里用"条件更新 + 已终态直接返回 SUCCESS"两道保险）。
 */
@Injectable()
export class OrderPayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly order: OrderService,
    private readonly logger: AppLogger,
    private readonly moderation: ModerationService,
    @Inject(PROVIDERS) private readonly providers: Providers,
    // 站内信扇出（M3-19）。TS 可选、线上必需（@Global 模块装配不上会启动失败）；
    // 可选只为兼容既有的手工构造单测，详见 `order.service.ts` 构造函数上的说明。
    private readonly notifications?: NotificationService,
  ) {}

  /**
   * 发起支付（预支付）。
   *
   * 返回的是**小程序 `wx.requestPayment` 需要的参数**，不是支付结果 ——
   * 真正的结果要等回调。客户端拿到参数后调起收银台即可。
   */
  async prepay(
    userId: string,
    orderId: string,
  ): Promise<{ orderNo: string; amountCents: number; prepay: unknown; notifyUrl: string }> {
    const order = await this.order.loadForWrite(orderId);
    if (order.buyerId !== userId) {
      throw new BizException(ErrorCode.NoPermission, undefined, '只有下单方可以发起支付');
    }
    if (order.status !== OrderStatus.PendingPayment) {
      throw new BizException(
        ErrorCode.OrderStatusConflict,
        { status: order.status },
        `订单当前状态（${order.status}）不可支付`,
      );
    }
    if (order.payDeadline && order.payDeadline.getTime() < Date.now()) {
      throw new BizException(ErrorCode.OrderStatusConflict, undefined, '订单已超过支付时限，请重新下单');
    }

    const buyer = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { openid: true },
    });

    const prepay = await this.providers.pay.prepay({
      orderNo: order.orderNo,
      amountCents: order.amount,
      description: `青智校园订单 ${order.orderNo}`,
      openid: buyer?.openid ?? '',
    });

    // 先落一条 pending 支付记录：回调到达时才有行可更新（否则要 upsert 两次）
    await this.prisma.payment.upsert({
      where: { orderId },
      create: { orderId, channel: 'wechat', amount: order.amount, status: 'pending' },
      update: { amount: order.amount, status: 'pending' },
    });

    return {
      orderNo: order.orderNo,
      amountCents: order.amount,
      prepay,
      notifyUrl: '/api/v1/orders/pay/notify',
    };
  }

  /**
   * 支付结果回调（微信服务器调用；Mock 下由本地脚本触发）。
   *
   * ⚠️ 这个路由必须 `@Public()` —— 微信服务器不带我们的 JWT。
   * 安全性由**验签**保证，而不是由登录态保证。
   */
  async handleNotify(
    headers: Record<string, string>,
    rawBody: string,
  ): Promise<{ code: string; message: string }> {
    const pay = this.providers.pay;

    if (!pay.verifyCallback(headers, rawBody)) {
      this.logger.warn('支付回调验签失败，已拒绝（可能是伪造请求）', 'OrderPay');
      throw new BizException(ErrorCode.ParamInvalid, undefined, '回调验签失败');
    }

    const payload = pay.parseCallback(rawBody);
    const order = await this.prisma.order.findUnique({ where: { orderNo: payload.orderNo } });
    if (!order) {
      throw new BizException(ErrorCode.NotFound, { orderNo: payload.orderNo }, '回调对应的订单不存在');
    }

    // 幂等第一道：已离开待支付态说明这单处理过了，直接回 SUCCESS 让网关停止重投
    if (order.status !== OrderStatus.PendingPayment) {
      this.logger.log(`订单 ${order.orderNo} 已是 ${order.status}，忽略重复回调`, 'OrderPay');
      return { code: 'SUCCESS', message: 'OK' };
    }

    if (!payload.success) {
      // 支付失败：订单留在待支付，用户可重试；只把支付记录标失败
      await this.prisma.payment.updateMany({
        where: { orderId: order.id },
        data: { status: 'failed', rawCallback: asJson(payload.raw) },
      });
      return { code: 'SUCCESS', message: 'OK' };
    }

    // ⭐ 金额核对：防止"用小额回调把大额订单标记为已付"
    if (payload.amountCents !== order.amount) {
      this.logger.error(
        `订单 ${order.orderNo} 回调金额不符：订单 ${order.amount} 分，回调 ${payload.amountCents} 分，已拒绝`,
        undefined,
        'OrderPay',
      );
      throw new BizException(
        ErrorCode.ParamInvalid,
        { expect: order.amount, got: payload.amountCents },
        '回调金额与订单金额不一致，已拒绝',
      );
    }

    transitionOrder(OrderStatus.PendingPayment, OrderStatus.Paid);
    const now = new Date();

    // 幂等第二道：条件更新。并发回调时只有一个能把 pending_payment 改成 paid
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.PendingPayment },
        data: { status: OrderStatus.Paid, paidAt: now },
      });
      if (moved.count === 0) return; // 另一个回调抢先处理了，本次空操作

      await tx.payment.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id,
          payNo: payload.payNo,
          channel: 'wechat',
          amount: order.amount,
          status: 'paid',
          paidAt: now,
          rawCallback: asJson(payload.raw),
        },
        update: { payNo: payload.payNo, status: 'paid', paidAt: now, rawCallback: asJson(payload.raw) },
      });
      await tx.orderTimeline.create({
        data: { orderId: order.id, event: 'paid', payload: { payNo: payload.payNo } },
      });
    });

    return { code: 'SUCCESS', message: 'OK' };
  }

  /**
   * 验收放款（M3-14）+ 评价记分（M3-16）。
   *
   * 状态迁移与**钱包入账在同一事务**里：要么"订单已完成且服务者已收到钱"，
   * 要么两者都没发生。分两个事务会出现"验收了但钱没到账"这种要人工对账的状态。
   *
   * 带了星级就把评价一起结进这个事务（`recordAcceptRating`）：
   * 评价、信用流水、分数与放款**同生同死**。分开提交会出现"钱付了、
   * 评价丢了、信用分却没扣"，那种账只能人工对。
   *
   * `dto.rating` 缺省时保持老行为：只放款，不写 `Review`，也不动信用分。
   */
  async accept(userId: string, orderId: string, dto: AcceptReviewDto): Promise<OrderItemDto> {
    const order = await this.order.loadForWrite(orderId);
    if (order.buyerId !== userId) {
      throw new BizException(ErrorCode.NoPermission, undefined, '只有下单方可以验收');
    }
    transitionOrder(order.status as OrderStatus, OrderStatus.Completed);
    assertReviewInput(dto);

    // 评价正文与标签会展示给服务者，属 UGC，必须送审（M4-05）。
    // 放在事务**之前**：审核是外部调用，不该长时间占着数据库事务；
    // 且违规评价根本不该进事务去回滚一次放款。
    await this.moderation.assertTexts(
      [
        { field: '评价内容', text: dto.content },
        { field: '评价标签', text: (dto.tags ?? []).join(' ') },
      ],
      { userId, scene: 'comment' },
    );

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.order.updateMany({
        where: { id: orderId, status: order.status },
        data: { status: OrderStatus.Completed, acceptedAt: now, completedAt: now },
      });
      if (moved.count === 0) {
        throw new BizException(ErrorCode.OrderStatusConflict, undefined, '订单状态已变更，请刷新后重试');
      }

      await tx.orderTimeline.create({
        data: { orderId, event: 'accepted', operatorId: userId, payload: { rating: dto.rating ?? null } },
      });

      await creditProvider(tx, {
        providerId: order.providerId,
        amountCents: order.providerIncome,
        orderId,
        orderNo: order.orderNo,
      });

      // 扇出（M3-19）：放款与"钱到账了"的通知同生同死 —— 分两次提交会出现
      // "账上多了一笔钱但没人告诉他"，那种只能靠用户自己发现的对账问题最伤信任。
      await this.notifications?.notify(tx, {
        userId: order.providerId,
        type: NotificationType.Order,
        title: '订单已验收，款项已放款',
        body: `订单 ${order.orderNo} 已被买家验收，款项已入账，可在钱包查看。`,
        refType: 'order',
        refId: orderId,
      });

      if (dto.rating !== undefined) {
        await recordAcceptRating({
          tx,
          orderId,
          orderNo: order.orderNo,
          reviewerId: userId,
          targetId: order.providerId,
          rating: dto.rating,
          content: dto.content,
          tags: dto.tags,
          isAnonymous: dto.isAnonymous,
        });
      }
    });

    return this.order.detail(userId, orderId);
  }

  /**
   * 申请退款（M3-15）。
   *
   * 目标状态按当前状态分派：
   *   · `paid`（服务者未接单）→ 直接 `refunded`（状态机允许这条边）
   *   · `pending_acceptance`（已交付）→ `refund_requested`，再按 `AUTO_SETTLE_REFUND` 决定是否走完
   *
   * 真实资金退回走 `PayProvider.refund()`，Mock 下返回假退款单号。
   */
  async refund(userId: string, orderId: string, dto: RefundDto): Promise<OrderItemDto> {
    const order = await this.order.loadForWrite(orderId);
    if (order.buyerId !== userId && order.providerId !== userId) {
      throw new BizException(ErrorCode.NoPermission, undefined, '无权操作该订单');
    }

    // 退款理由会写进订单时间线并展示给对手方，属 UGC，必须送审（M4-05）
    await this.moderation.assertText(dto.reason, {
      userId,
      scene: 'comment',
      field: '退款理由',
    });

    const from = order.status as OrderStatus;
    const now = new Date();
    const events = [{ event: 'refund_requested', payload: { reason: dto.reason } as Prisma.InputJsonValue }];

    // 状态机没有 pending_acceptance → refunded 这条边，必须先落到 refund_requested
    const target =
      from === OrderStatus.PendingAcceptance ? OrderStatus.RefundRequested : OrderStatus.Refunded;
    transitionOrder(from, target);

    let finalStatus: OrderStatus = target;
    if (AUTO_SETTLE_REFUND && target === OrderStatus.RefundRequested) {
      transitionOrder(OrderStatus.RefundRequested, OrderStatus.Refunded);
      finalStatus = OrderStatus.Refunded;
      events.push({ event: 'refunded', payload: { auto: true } as Prisma.InputJsonValue });
    }

    // 真实退款调用放在事务之外：外部调用可能慢/超时，不该长时间占着数据库事务
    const refundNo = await this.providers.pay.refund(order.orderNo, order.amount, dto.reason);

    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.order.updateMany({
        where: { id: orderId, status: from },
        data: {
          status: finalStatus,
          refundReason: dto.reason,
          ...(finalStatus === OrderStatus.Refunded ? { refundedAt: now } : {}),
        },
      });
      if (moved.count === 0) {
        throw new BizException(ErrorCode.OrderStatusConflict, undefined, '订单状态已变更，请刷新后重试');
      }

      for (const e of events) {
        await tx.orderTimeline.create({
          data: { orderId, event: e.event, operatorId: userId, payload: e.payload },
        });
      }

      // 扇出（M3-19）：退款必须让对方知道。当前仲裁是自动结算（`AUTO_SETTLE_REFUND`），
      // 少了这条，对方只会发现订单莫名其妙变成了"已退款"。收信人是**发起人的对手方**。
      await this.notifications?.notify(tx, {
        userId: order.buyerId === userId ? order.providerId : order.buyerId,
        type: NotificationType.Order,
        title: finalStatus === OrderStatus.Refunded ? '退款已处理完成' : '对方申请退款',
        body: `订单 ${order.orderNo} 的退款申请：${dto.reason}`,
        refType: 'order',
        refId: orderId,
      });

      if (finalStatus === OrderStatus.Refunded) {
        await tx.payment.updateMany({
          where: { orderId },
          data: {
            status: 'refunded',
            refundAmount: order.amount,
            refundNo: refundNo.refundId,
            refundedAt: now,
          },
        });
      }
    });

    return this.order.detail(userId, orderId);
  }
}

/**
 * 回调原始报文 → Prisma 的 Json 入参。
 *
 * 为什么需要转换：`@qz/core` 的 `PayCallbackPayload.raw` 声明为 `Record<string, unknown>`
 * （core 不能依赖 Prisma —— 红线 9），而 Prisma 的 Json 字段要求 `InputJsonValue`。
 * 转换放在 api 层，正是这条分层纪律的体现，不是 core 的类型"不够好"。
 */
function asJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

/**
 * 只给了评价内容却没给星级 —— 直接拒绝，**不静默丢弃**。
 *
 * 为什么不算"多余的校验"：`Review` 只在有星级时创建（星级是信用增减的唯一依据），
 * 若放过去，正文与标签会被写不进任何地方、却照样返回验收成功 ——
 * 就是文档里点名的"看着像存了、其实没存"那种形态（红线 10 的变体）。
 * 显式报错让前端能立刻改成"先选星再写字"。
 */
function assertReviewInput(dto: AcceptReviewDto): void {
  if (dto.rating !== undefined) return;
  const hasReviewText = Boolean(dto.content?.trim()) || Boolean(dto.tags?.length) || dto.isAnonymous;
  if (hasReviewText) {
    throw new BizException(
      ErrorCode.ParamInvalid,
      undefined,
      '填写评价内容需要先给出星级（1~5）',
    );
  }
}

/**
 * 服务者入账（钱包余额 + 资金流水）。
 *
 * ## 为什么必须幂等
 *
 * `accept` 可能被重复触发（用户连点、客户端重试）。没有这道检查会**重复放款** ——
 * 这是整个模块最不能出错的地方，所以用"该订单是否已有入账流水"作为判据，
 * 而不是信任调用方只调一次。
 *
 * ## 为什么先 upsert 再 `FOR UPDATE`
 *
 * 锁不住不存在的行：新服务者若还没有 wallet 记录，直接
 * `SELECT ... FOR UPDATE` 会"成功但没锁"，并发保护静默失效（与 BillingService 同理）。
 */
async function creditProvider(
  tx: Prisma.TransactionClient,
  args: { providerId: string; amountCents: number; orderId: string; orderNo: string },
): Promise<void> {
  const { providerId, amountCents, orderId, orderNo } = args;
  if (amountCents <= 0) return;

  const existed = await tx.walletLedger.findFirst({
    where: { refType: 'order', refId: orderId, type: LEDGER_INCOME },
    select: { id: true },
  });
  if (existed) return;

  await tx.wallet.upsert({ where: { userId: providerId }, create: { userId: providerId }, update: {} });
  await tx.$queryRaw`SELECT user_id FROM wallet WHERE user_id = ${providerId} FOR UPDATE`;

  const wallet = await tx.wallet.update({
    where: { userId: providerId },
    data: {
      balance: { increment: amountCents },
      totalIncome: { increment: amountCents },
    },
  });

  await tx.walletLedger.create({
    data: {
      userId: providerId,
      type: LEDGER_INCOME,
      amount: amountCents,
      balanceAfter: wallet.balance,
      refType: 'order',
      refId: orderId,
      remark: `订单 ${orderNo} 验收放款`,
    },
  });
}
