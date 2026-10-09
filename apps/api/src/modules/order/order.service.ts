import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  BizException,
  ErrorCode,
  OrderStatus,
  asStringArray,
  calcPlatformFee,
  calcProviderIncome,
  orderNo,
  transitionOrder,
  type CreateOrderDto,
  type DeliverDto,
} from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ModerationService } from '../moderation/moderation.service';
import { NotificationType } from '../notification/dto/notification.dto';
import { NotificationService } from '../notification/notification.service';

/** 支付超时（分钟）：文档 6.6.3 —— 下单后 30 分钟未支付自动关闭 */
export const PAY_TIMEOUT_MINUTES = 30;
/** 交付时限（小时）：接单后 48 小时内需提交交付物 */
export const DELIVER_TIMEOUT_HOURS = 48;
/** 要求修改次数上限（与小程序详情页文案一致；次数从 timeline 里数，不另加字段） */
export const MAX_REVISION_ROUNDS = 3;

/**
 * 订单条目（字段与 `apps/mp/utils/api.ts` 的 `OrderItem` 对齐）。
 *
 * 前半段是**客户端已冻结的契约**（列表页与详情页都读这些）；
 * 后半段是详情页附加信息，列表页忽略即可 —— 多下发字段对小程序无副作用。
 */
export interface OrderItemDto {
  id: string;
  orderNo: string;
  amount: number;
  status: string;
  providerIncome: number;
  createdAt: string;
  task?: { title: string };
  buyer?: { id: string; nickname: string };
  provider?: { id: string; nickname: string };
  // ---- 详情页附加 ----
  requirement?: string;
  deliveryFiles?: string[];
  deliveryRemark?: string;
  refundReason?: string;
  payDeadline?: string;
  paidAt?: string;
  deliveredAt?: string;
  acceptedAt?: string;
}

/**
 * 订单模块（任务清单 M3-11 / M3-14）
 *
 * ## 为什么这个模块之前是空的、现在必须补齐
 *
 * 小程序端 `orderApi` 的 7 个方法契约早已冻结，页面也早已写好
 * （`pkg-station/order-list`、`order-detail`），但后端一条路由都没注册 ——
 * `GET /orders` 实测 404，导致订单列表恒空、详情页是孤岛。
 * 更糟的是详情页曾经**假装成功**（不调接口就弹"已提交"），
 * 那是红线 10 明令禁止的形态。
 *
 * ## 职责边界：本服务只管"订单自身"，资金动作在 OrderPayService
 *
 * 拆分不是审美：订单状态迁移与钱包记账的**事务边界不同** ——
 * 状态迁移要写 timeline，资金动作要锁钱包行。混在一个类里会让
 * 单文件逼近 300 行红线，也会让"哪段代码动了钱"变得难以一眼看出。
 *
 * ## 状态迁移一律走 `transitionOrder()`
 *
 * 红线：禁止直接给 `status` 赋值。所有迁移先由 core 的状态机校验，
 * 非法迁移抛 `IllegalTransitionError`（40904），而不是静默写坏数据。
 */
@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
    /**
     * 站内信扇出（M3-19）。TS 上是可选的，**线上是必需的**：
     * `NotificationModule` 是 `@Global`，Nest 装配时拿不到这个 provider 会直接启动失败，
     * 所以"没接通知"这条路在生产上不存在。可选只服务于**手工构造**的老单测
     * （`__tests__/order.service.spec.ts` 早于 M3-19，两参构造），扇出处用 `?.` 跳过即可；
     * 新增的扇出用例在 `modules/notification/__tests__/fanout.spec.ts` 里传真服务，断言通知确实落库。
     */
    private readonly notifications?: NotificationService,
  ) {}

  /**
   * 我的订单。
   * @param role buyer=我买到的（默认）｜ provider=我卖出的
   */
  async list(
    userId: string,
    query: { role?: 'buyer' | 'provider'; status?: string },
  ): Promise<{ list: OrderItemDto[]; total: number }> {
    const where = {
      ...(query.role === 'provider' ? { providerId: userId } : { buyerId: userId }),
      ...(query.status ? { status: query.status } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: ORDER_INCLUDE,
      }),
      this.prisma.order.count({ where }),
    ]);

    return { list: rows.map(toOrderItem), total };
  }

  /**
   * 订单详情。
   *
   * 只有**买卖双方**能看 —— 订单里有金额与交付物，不属于公开数据。
   * 越权时返回 403 而不是 404：对方确实存在，只是不该看（便于前端区分"订单不存在"）。
   */
  async detail(userId: string, id: string): Promise<OrderItemDto> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { ...ORDER_INCLUDE, timeline: { orderBy: { createdAt: 'asc' } } },
    });
    if (!order) throw new BizException(ErrorCode.NotFound, undefined, '订单不存在');
    if (order.buyerId !== userId && order.providerId !== userId) {
      throw new BizException(ErrorCode.NoPermission, undefined, '无权查看该订单');
    }
    return toOrderItem(order);
  }

  /**
   * 下单（担保交易，ADR-07）。
   *
   * 金额由**客户端传入**（任务/服务可能是一口价或议价结果），
   * 但平台费与服务者收入**一律服务端算**，绝不采信客户端 ——
   * 否则改一个数字就能把平台费改成 0。
   */
  async create(buyerId: string, dto: CreateOrderDto): Promise<OrderItemDto> {
    await this.assertCreatable(buyerId, dto.providerId);
    return this.prisma.$transaction((tx) => this.createInTx(tx, buyerId, dto));
  }

  /** 下单前置校验。驿站"选定服务者"走同一套，避免两处规则漂移 */
  async assertCreatable(buyerId: string, providerId: string): Promise<void> {
    if (providerId === buyerId) {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '不能给自己下单');
    }
    const provider = await this.prisma.user.findUnique({
      where: { id: providerId },
      select: { id: true },
    });
    if (!provider) throw new BizException(ErrorCode.NotFound, undefined, '服务者不存在');
  }

  /**
   * 在**调用方的事务**里创建订单。
   *
   * ## 为什么需要它（而不是让调用方再调一次 `create`）
   *
   * 驿站"选定服务者"必须在**同一个事务**里改任务状态 + 建订单。
   * 分两次提交的话，第二次失败会留下"任务已选定、但没有订单"的死状态 ——
   * 用户看到"已选定，请完成支付"，而订单列表里什么都没有，且没有任何报错。
   *
   * ## `extra.requirement` 只允许服务端填
   *
   * 它来自**任务描述**（发布时已送审），不是客户端这次传来的新文本。
   * 所以不走 `CreateOrderDto` —— 那个 DTO 是客户端可控的，
   * 往里加自由文本字段就等于开了一条绕过内容安全的旁路（M4-05）。
   */
  async createInTx(
    tx: Prisma.TransactionClient,
    buyerId: string,
    dto: CreateOrderDto,
    extra: { requirement?: string } = {},
  ): Promise<OrderItemDto> {
    const platformFee = calcPlatformFee(dto.amount);
    const providerIncome = calcProviderIncome(dto.amount);
    const now = new Date();

    const order = await tx.order.create({
      data: {
        orderNo: orderNo(now),
        taskId: dto.taskId ?? null,
        serviceId: dto.serviceId ?? null,
        buyerId,
        providerId: dto.providerId,
        amount: dto.amount,
        platformFee,
        providerIncome,
        status: OrderStatus.PendingPayment,
        requirement: extra.requirement ?? null,
        // 30 分钟不支付自动关闭（超时扫描见 M3-13 的定时任务，此处先落截止时间）
        payDeadline: new Date(now.getTime() + PAY_TIMEOUT_MINUTES * 60_000),
        deliverDeadline: new Date(now.getTime() + DELIVER_TIMEOUT_HOURS * 3_600_000),
      },
      include: ORDER_INCLUDE,
    });
    await tx.orderTimeline.create({
      data: {
        orderId: order.id,
        event: 'created',
        operatorId: buyerId,
        payload: { amount: dto.amount, platformFee, providerIncome },
      },
    });
    return toOrderItem(order);
  }

  /**
   * 提交交付物（服务者）。
   *
   * ## 为什么要"两步迁移"
   *
   * 状态机是 `paid(担保中) → in_service(服务中) → pending_acceptance(待验收)`，
   * **不存在 `paid → pending_acceptance` 这条边**。而客户端只有一个"提交交付物"
   * 按钮，没有独立的"接单"动作 —— 所以这里在**同一个事务里**连续迁移两次，
   * 并把"接单"也写进 timeline。这样既守住了状态机，时间线也仍然完整可回溯。
   */
  async deliver(userId: string, id: string, dto: DeliverDto): Promise<OrderItemDto> {
    const order = await this.loadForWrite(id);
    if (order.providerId !== userId) {
      throw new BizException(ErrorCode.NoPermission, undefined, '只有服务者可以提交交付物');
    }

    // 交付说明会展示给买家，属 UGC，必须送审（M4-05）。放在权限校验之后：
    // 非服务者不该从错误文案里反推出"这条订单存在、且内容被审核过"。
    await this.moderation.assertText(dto.remark, {
      userId,
      scene: 'comment',
      field: '交付说明',
    });

    const now = new Date();
    const events: string[] = [];
    let status = order.status as OrderStatus;

    if (status === OrderStatus.Paid) {
      transitionOrder(status, OrderStatus.InService);
      status = OrderStatus.InService;
      events.push('accepted'); // 服务者实际接单
    }
    transitionOrder(status, OrderStatus.PendingAcceptance);

    const updated = await this.prisma.$transaction(async (tx) => {
      /**
       * 条件更新（并发守卫）。
       *
       * 这里以前是裸 `update({ where: { id } })` —— 与 `accept` / `refund`
       *（都是 `updateMany + where.status`）口径不一致。两个并发请求
       *（例如服务者点了两次"提交交付物"，或提交的同时买家点了退款）
       * 会各自读到旧状态、再各自写一次，后写者把前者的结果覆盖掉，
       * 而两次都返回成功、都往时间线里各插一条记录。
       *
       * 用 `order.status`（**进入本方法时读到的原始状态**）做条件：
       * 中间被别的事务改过就 count=0，明确报冲突让前端刷新，
       * 而不是把一个基于过期状态的决定写进数据库。
       */
      const moved = await tx.order.updateMany({
        where: { id, status: order.status },
        data: {
          status: OrderStatus.PendingAcceptance,
          deliveryFiles: dto.fileIds,
          deliveryRemark: dto.remark ?? null,
          deliveredAt: now,
          startedAt: order.startedAt ?? now,
        },
      });
      if (moved.count === 0) {
        throw new BizException(
          ErrorCode.OrderStatusConflict,
          undefined,
          '订单状态已变更，请刷新后重试',
        );
      }

      for (const event of [...events, 'delivered']) {
        await tx.orderTimeline.create({ data: { orderId: id, event, operatorId: userId } });
      }
      // 扇出（M3-19）：交付后要有人去验收。与状态变更同事务 —— 通知单独提交会丢，
      // 而"订单已在待验收、买家却不知道"表现为悄悄超期，界面上看不出任何错误。
      await this.notifications?.notify(tx, {
        userId: order.buyerId,
        type: NotificationType.Order,
        title: '交付物已提交，请验收',
        body: `订单 ${order.orderNo} 已提交交付物，请查看交付物后验收或要求修改。`,
        refType: 'order',
        refId: id,
      });

      // 条件更新拿不回 include 的关系，补一次读（同事务内，读到的就是刚写入的行）
      return tx.order.findUniqueOrThrow({ where: { id }, include: ORDER_INCLUDE });
    });

    return toOrderItem(updated);
  }

  /** 按 id 取订单（不存在直接抛 404），供写路径复用 */
  async loadForWrite(id: string) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new BizException(ErrorCode.NotFound, undefined, '订单不存在');
    return order;
  }

  /**
   * 要求修改（验收方，待验收 → 服务中回退，M3-14）。
   *
   * 状态机里这条边是 `pending_acceptance → in_service`（见 core/state-machine/order.ts）。
   * 修改意见会展示给服务者，属 UGC，必须送审（M4-05）。
   *
   * ## 为什么限制 3 次（与详情页文案一致）
   *
   * 无上限的"要求修改"会让服务者被无限返工，也是纠纷的主要来源。
   * 次数从 timeline 里数（`revision_requested` 事件），不另加字段 ——
   * 时间线本来就是"发生过什么"的唯一权威。
   */
  async requestRevision(userId: string, id: string, reason: string): Promise<OrderItemDto> {
    const order = await this.loadForWrite(id);
    if (order.buyerId !== userId) {
      throw new BizException(ErrorCode.NoPermission, undefined, '只有验收方可以要求修改');
    }
    // 状态机校验：非"待验收"会抛 IllegalTransitionError（40904），而不是静默改坏数据
    transitionOrder(order.status as OrderStatus, OrderStatus.InService);

    await this.moderation.assertText(reason, {
      userId,
      scene: 'comment',
      field: '修改意见',
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      // 顺序有讲究：先 updateMany 抢到订单行锁并顺带校验状态，再数次数。
      // 反过来（先 count 再 update）并发两次都会读到 revisions=0 而双放行，
      // 4 条 revision 记录同时落库 —— 次数上限被绕过。
      const moved = await tx.order.updateMany({
        where: { id, status: order.status },
        data: { status: OrderStatus.InService },
      });
      if (moved.count === 0) {
        throw new BizException(
          ErrorCode.OrderStatusConflict,
          undefined,
          '订单状态已变化，请刷新后重试',
        );
      }

      const revisions = await tx.orderTimeline.count({
        where: { orderId: id, event: 'revision_requested' },
      });
      if (revisions >= MAX_REVISION_ROUNDS) {
        // 抛错即回滚，上面的状态变更一并撤销 —— 不会留下"改了状态又没记时间线"的半成品
        throw new BizException(
          ErrorCode.ParamInvalid,
          undefined,
          `要求修改次数已达上限（${MAX_REVISION_ROUNDS} 次），请验收或申请退款`,
        );
      }

      const row = await tx.order.findUniqueOrThrow({ where: { id }, include: ORDER_INCLUDE });
      await tx.orderTimeline.create({
        data: {
          orderId: id,
          event: 'revision_requested',
          operatorId: userId,
          payload: { reason, round: revisions + 1 },
        },
      });
      // 扇出（M3-19）：回退成"服务中"后服务者必须知道要返工，否则订单静静停在那儿等超时
      await this.notifications?.notify(tx, {
        userId: order.providerId,
        type: NotificationType.Order,
        title: '买家要求修改交付物',
        body: `订单 ${order.orderNo} 的修改意见：${reason}`,
        refType: 'order',
        refId: id,
      });
      return row;
    });

    return toOrderItem(updated);
  }
}

/** 列表 / 详情共用的关联字段 */
const ORDER_INCLUDE = {
  task: { select: { title: true } },
  buyer: { select: { id: true, nickname: true } },
  provider: { select: { id: true, nickname: true } },
} as const;

/** 行 → 对端条目 */
function toOrderItem(row: {
  id: string;
  orderNo: string;
  amount: number;
  status: string;
  providerIncome: number;
  requirement: string | null;
  deliveryFiles: unknown;
  deliveryRemark: string | null;
  refundReason: string | null;
  payDeadline: Date | null;
  paidAt: Date | null;
  deliveredAt: Date | null;
  acceptedAt: Date | null;
  createdAt: Date;
  task?: { title: string } | null;
  buyer?: { id: string; nickname: string | null } | null;
  provider?: { id: string; nickname: string | null } | null;
}): OrderItemDto {
  return {
    id: row.id,
    orderNo: row.orderNo,
    amount: row.amount,
    status: row.status,
    providerIncome: row.providerIncome,
    createdAt: row.createdAt.toISOString(),
    // JSON 列在不同 MySQL 客户端下可能返回字符串，统一走 core 的容错解析
    deliveryFiles: asStringArray(row.deliveryFiles),
    ...compact({
      task: row.task ? { title: row.task.title } : undefined,
      buyer: asParty(row.buyer),
      provider: asParty(row.provider),
      requirement: row.requirement ?? undefined,
      deliveryRemark: row.deliveryRemark ?? undefined,
      refundReason: row.refundReason ?? undefined,
      payDeadline: row.payDeadline?.toISOString(),
      paidAt: row.paidAt?.toISOString(),
      deliveredAt: row.deliveredAt?.toISOString(),
      acceptedAt: row.acceptedAt?.toISOString(),
    }),
  };
}

/** 用户摘要 → 展示用的买卖方对象（昵称为空时兜底"同学"） */
function asParty(
  u: { id: string; nickname: string | null } | null | undefined,
): { id: string; nickname: string } | undefined {
  return u ? { id: u.id, nickname: u.nickname ?? '同学' } : undefined;
}

/**
 * 剔除值为 `undefined` 的键。
 *
 * 为什么不写成一串 `...(x ? { x } : {})`：那种写法**每多一个可选字段就多一个分支**，
 * 而本函数的可选字段有 10 个 —— 会直接撞上 ESLint 的复杂度上限（≤10）。
 * 把"展开可选字段"这件事收敛成一次遍历，复杂度就从"字段数"变成常数。
 */
function compact<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
