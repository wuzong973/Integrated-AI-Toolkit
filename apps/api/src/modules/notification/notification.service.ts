import { Injectable } from '@nestjs/common';
import { BizException, ErrorCode } from '@qz/core';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';

import {
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_TITLE_MAX,
  clip,
  toNotificationItem,
  type NotificationListQueryDto,
  type NotificationPageDto,
  type NotifyInput,
} from './dto/notification.dto';

/** 投递渠道。本期只有站内信；订阅消息（M3-19 的另一半）接入时往数组里加值，
 *  不写"看起来支持"的渠道名 —— `channels` 是给用户看的，也是排查"为什么没收到"的唯一线索。 */
const CHANNEL_INAPP = 'inapp';

/**
 * 站内信（任务清单 M3-19）
 *
 * ## 唯一重要的设计：通知与业务动作**同一个事务**
 *
 * `notify()` 的第一个参数是 `Prisma.TransactionClient` 而不是"内部自己拿 prisma"。
 * 这不是形式：如果通知在事务**外**写，就会出现两种都不肯定的坏状态 ——
 *   · 业务成功、通知失败（用户不知道该去验收，订单悄悄超期）；
 *   · 通知成功、业务回滚（用户收到"已交付"，点进去订单还在服务中）。
 * 让调用方把 `tx` 传进来，是把"不许各写一半"这件事变成**编译期**的约束：
 * 拿不到 tx 就调不了 notify（红线 1 / 红线 10 的具体化）。
 * 代价是通知写入点必须落在业务事务里，这正是扇出点（订单交付/验收/退款、
 * 驿站报名/选定/关闭）那 7 处 `await this.notifications.notify(tx, …)` 的由来。
 *
 * ## 越权在读接口上的正确形态是「查不到」
 *
 * 三个读/写方法都把 `userId` 放进 where，没有任何一处 `if (row.userId !== me) throw`
 * 那种"忘了写就把家交出去"的分支（与订单评价的结构性权限同一写法）。
 * 单条操作（`markRead`）拿不到行时报 **404 而不是 403**：通知是纯私有数据，
 * 告诉调用方"这条存在但不是你的"没有任何好处，只会送出一个探测别人消息的 oracle。
 */
@Injectable()
export class NotificationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 在**调用方的事务**里写一条通知。
   *
   * 标题/正文按列宽截断（见 `clip()` 的取舍）。返回新通知的 id，
   * 便于调用方（未来的 WebSocket 推送）拿它做去重键。
   */
  async notify(tx: Prisma.TransactionClient, input: NotifyInput): Promise<string> {
    const row = await tx.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: clip(input.title, NOTIFICATION_TITLE_MAX),
        content: clip(input.body, NOTIFICATION_BODY_MAX),
        ref: refOf(input),
        channels: [CHANNEL_INAPP],
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * 我的通知（分页 + 未读数）。
   *
   * 未读数与列表**一次往返**拿全：红点与列表分两个接口时，
   * 用户读完一条后总有一个是旧的（消息中心最常见的"对不上"）。
   * 计数不受 `type` / `unread` 筛选影响 —— 它是"我一共还有多少没读"，
   * 是 Tab 上的角标，不是当前筛选结果的条数。
   */
  async list(userId: string, query: NotificationListQueryDto): Promise<NotificationPageDto> {
    const where = {
      userId,
      ...(query.type ? { type: query.type } : {}),
      ...(query.unread ? { readAt: null } : {}),
    };
    const [rows, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return {
      list: rows.map(toNotificationItem),
      total,
      page: query.page,
      pageSize: query.pageSize,
      unreadCount,
    };
  }

  /**
   * 标记单条已读。
   *
   * `readAt` 用 `updateMany` 带 `userId` 条件而不是 `update({ where: { id } })`：
   * 归属校验留在语句里（结构性权限），并且"已经是已读"不会被误报成失败 ——
   * 用户连点两次、客户端重试一次，都该是成功（重复标记已读没有副作用）。
   */
  async markRead(userId: string, id: string): Promise<{ id: string; read: boolean }> {
    const mine = await this.prisma.notification.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!mine) throw new BizException(ErrorCode.NotFound, undefined, '消息不存在或已被删除');

    await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { id, read: true };
  }

  /** 全部标记已读（消息中心"一键已读"）。返回真正变化的条数，供前端清零角标 */
  async markAllRead(userId: string): Promise<{ updated: number }> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: count };
  }
}

/** `refType` / `refId` → `ref` Json 列。两者都没传时返回 `undefined`（列留 null，不写空对象） */
function refOf(input: NotifyInput): Record<string, string> | undefined {
  const ref: Record<string, string> = {};
  if (input.refType) ref.refType = input.refType;
  if (input.refId) ref.refId = input.refId;
  return Object.keys(ref).length > 0 ? ref : undefined;
}
