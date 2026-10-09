import { Injectable } from '@nestjs/common';
import { BizException, ErrorCode, OrderStatus, type AdminOrderListQueryDto } from '@qz/core';
import type { Prisma } from '@prisma/client';

import { AppLogger } from '../../common/logger/logger.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { OrderPayService } from '../order/order-pay.service';

import { AdminAuditService } from './admin-audit.service';

/** 纠纷订单（需要人介入的两种状态） */
const DISPUTED_STATUSES: string[] = [OrderStatus.RefundRequested];

export interface AdminOrderItem {
  id: string;
  orderNo: string;
  status: string;
  amount: number;
  platformFee: number;
  providerIncome: number;
  buyerId: string;
  buyerName: string | null;
  providerId: string;
  providerName: string | null;
  /** 争议线索：有值就说明这条订单需要人看 */
  refundReason: string | null;
  hasTask: boolean;
  createdAt: string;
  paidAt: string | null;
  deliveredAt: string | null;
  /** 交付物数量：为 0 且已交付，说明是"交付了个空" */
  deliveryCount: number;
  revisionCount: number;
}

export interface AdminOrderDetail extends AdminOrderItem {
  requirement: string | null;
  deliveryRemark: string | null;
  deliveryFiles: string[];
  timeline: { event: string; operatorId: string | null; createdAt: string; payload: unknown }[];
  payDeadline: string | null;
  completedAt: string | null;
  refundedAt: string | null;
}

const ORDER_SELECT = {
  id: true,
  orderNo: true,
  status: true,
  amount: true,
  platformFee: true,
  providerIncome: true,
  buyerId: true,
  providerId: true,
  refundReason: true,
  requirement: true,
  deliveryFiles: true,
  deliveryRemark: true,
  revisionCount: true,
  taskId: true,
  payDeadline: true,
  paidAt: true,
  deliveredAt: true,
  completedAt: true,
  refundedAt: true,
  createdAt: true,
  buyer: { select: { nickname: true } },
  provider: { select: { nickname: true } },
} as const;

type Row = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;

/**
 * 订单与纠纷裁决（任务清单 M0-23）
 *
 * ## ⚠️ 裁决动作的资金实现复用 `OrderPayService`，真实操作人记在审计日志
 *
 * 放款（`accept`）与退款（`refund`）是**唯一一份**资金实现，里面串着
 * 状态机迁移、钱包入账、平台服务费、通知扇出。后台若另写一份，等于把
 * 最容易出错的一段逻辑复制成两份 —— 迟早有一份会漏掉某个分支。
 *
 * 代价是：这两个方法都以**买家身份**被触发（它们校验 `order.buyerId === userId`），
 * 因此订单时间线上的 `operator_id` 记的是买家，而不是动手的管理员。
 *
 * 为什么不接受"把 admin 当 userId 传进去"：那会直接 `NoPermission`。
 * 为什么不接受"改造 OrderPayService 加管理员分支"：那要动一条有真实资金与
 * 已有测试覆盖的路径，与本轮"搭后台"的目标不成比例。
 *
 * **因此：管理员的真实身份与理由落在 `audit_log`（`order.release` / `order.refund`），
 * 以它为准。** 这是本模块的已知取舍，不是遗漏；真要让时间线也带管理员 id，
 * 应给 `OrderPayService` 增加显式的 `operatorId` 参数，属于独立的改动。
 *
 * ## 权限点为什么单列 `order:settle`
 *
 * 看订单（`order:view`）与动钱（`order:settle`）必须分开。客服天天要看订单，
 * 但不该有权把钱放出去。
 */
@Injectable()
export class AdminOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pay: OrderPayService,
    private readonly audit: AdminAuditService,
    private readonly logger: AppLogger,
  ) {}

  async list(query: AdminOrderListQueryDto): Promise<{ list: AdminOrderItem[]; total: number }> {
    const where: Prisma.OrderWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.disputed
        ? {
            OR: [
              { status: { in: DISPUTED_STATUSES } },
              { refundReason: { not: null } },
            ],
          }
        : {}),
      ...(query.keyword
        ? {
            AND: [
              {
                OR: [
                  { orderNo: { contains: query.keyword } },
                  { requirement: { contains: query.keyword } },
                ],
              },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        select: ORDER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.size,
        take: query.size,
      }),
      this.prisma.order.count({ where }),
    ]);

    return { list: rows.map(toItem), total };
  }

  async detail(id: string): Promise<AdminOrderDetail> {
    const row = await this.prisma.order.findUnique({ where: { id }, select: ORDER_SELECT });
    if (!row) throw new BizException(ErrorCode.NotFound, undefined, '订单不存在');

    const timeline = await this.prisma.orderTimeline.findMany({
      where: { orderId: id },
      orderBy: { createdAt: 'asc' },
      select: { event: true, operatorId: true, createdAt: true, payload: true },
    });

    return {
      ...toItem(row),
      requirement: row.requirement,
      deliveryRemark: row.deliveryRemark,
      deliveryFiles: asStrings(row.deliveryFiles),
      payDeadline: iso(row.payDeadline),
      completedAt: iso(row.completedAt),
      refundedAt: iso(row.refundedAt),
      timeline: timeline.map((t) => ({
        event: t.event,
        operatorId: t.operatorId,
        createdAt: t.createdAt.toISOString(),
        payload: t.payload,
      })),
    };
  }

  /**
   * 裁决：放款给服务者 / 退款给买家。
   *
   * 两者的适用状态不同，且由 `OrderPayService` 内部的状态机兜底 ——
   * 例如对一条 `pending_payment` 的订单放款会被状态机拒绝（40904），
   * 这里不重复实现那套判断，避免"两处判断不一致"。
   */
  async resolve(
    id: string,
    dto: { action: 'release' | 'refund'; reason: string },
    actor: { userId: string },
  ): Promise<AdminOrderDetail> {
    const row = await this.prisma.order.findUnique({
      where: { id },
      select: { id: true, orderNo: true, status: true, buyerId: true, amount: true },
    });
    if (!row) throw new BizException(ErrorCode.NotFound, undefined, '订单不存在');

    if (dto.action === 'release') {
      // 以买家身份触发验收放款（不写评价、不动信用分：dto 只给空对象）
      await this.pay.accept(row.buyerId, id, {});
    } else {
      await this.pay.refund(row.buyerId, id, { reason: dto.reason });
    }

    await this.audit.record({
      actorId: actor.userId,
      action: dto.action === 'release' ? 'order.release' : 'order.refund',
      targetType: 'order',
      targetId: id,
      before: { status: row.status },
      after: { action: dto.action },
      reason: dto.reason,
    });

    this.logger.warn(
      `管理员裁决订单 ${row.orderNo}：${dto.action} by=${actor.userId}`,
      'AdminOrder',
    );

    return this.detail(id);
  }
}

function toItem(row: Row): AdminOrderItem {
  return {
    id: row.id,
    orderNo: row.orderNo,
    status: row.status,
    amount: row.amount,
    platformFee: row.platformFee,
    providerIncome: row.providerIncome,
    buyerId: row.buyerId,
    buyerName: row.buyer.nickname,
    providerId: row.providerId,
    providerName: row.provider.nickname,
    refundReason: row.refundReason,
    hasTask: !!row.taskId,
    createdAt: row.createdAt.toISOString(),
    paidAt: iso(row.paidAt),
    deliveredAt: iso(row.deliveredAt),
    deliveryCount: asStrings(row.deliveryFiles).length,
    revisionCount: row.revisionCount,
  };
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
