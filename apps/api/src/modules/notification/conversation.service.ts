import { Injectable } from '@nestjs/common';
import { BizException, ErrorCode } from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ModerationService } from '../moderation/moderation.service';

import {
  LAST_MESSAGE_MAX,
  pairOf,
  toConversationItem,
  toMessageItem,
  type ConversationItemDto,
  type ConversationPageDto,
  type ConversationRow,
  type MessageItemDto,
  type MessageListQueryDto,
  type MessagePageDto,
  type SendMessageDto,
} from './dto/conversation.dto';
import { NotificationType, clip } from './dto/notification.dto';
import { NotificationService } from './notification.service';

/** 会话锚点：`conversation.ref_type` 的取值（表里是自由字符串，本期只有"订单"这一种） */
const REF_ORDER = 'order';
/** 对方那条未读通知的正文长度上限（标题列 VARCHAR(120) 已给昵称留了位置） */
const PREVIEW_MAX = 60;

/**
 * 会话与消息（任务清单 M3-19）
 *
 * ## 只做"够用"的 IM：订单维度、轮询、不接 WebSocket
 *
 * 文档 6.8 的完整形态是 WebSocket 推送 + IM 元数据。本期刻意不做：
 * 站内信已经承担了"不在线也要能看到"这件事，而交易双方沟通的真实频次是一天几条，
 * 轮询 `GET /conversations/:id/messages` 足够。
 * 长连接的代价是**部署**（网关要配 ws 升级、要处理重连与心跳）加上
 * 一个"看着实时、实际会掉线"的维护面 —— 那不是首版该有的复杂度。
 *
 * ## 通知与会话是**同一事实的两个视图**
 *
 * 发一条消息会同时：① 写 `message`、② 更新 `conversation.last_message`、
 * ③ 给对方写一条未读 `notification` —— 三者同一个事务。
 * 少了 ③，对方不打开消息中心就永远不知道有人找他；只做 ③ 不做 ①，
 * 点进去是一条空会话。所以这两件事不能分开发。
 *
 * ## 越权一律 404
 *
 * `assertMember()` 用 `findFirst({ where: { id, OR: [{participantA: 我}, {participantB: 我}] } })`：
 * 不是成员就是查不到，与"会话不存在"同一句话（结构性权限，见 `notification.service.ts` 的同名说明）。
 * 这里给 403 等于向外人确认"这两人之间有交易"，那本身就是要保护的信息。
 */
@Injectable()
export class ConversationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * 建 / 取会话（幂等）。
   *
   * 幂等键是**用户对**而不是订单 —— 表上的唯一约束就是 `(participant_a, participant_b)`，
   * 详见 `dto/conversation.dto.ts` 文件头。同一对用户为第二笔订单再调一次，
   * 会拿到原来那条会话（`orderId` 仍是第一次那笔），不报错也不会建出第二条。
   *
   * 并发下两个请求同时判定"不存在"再各建一条，后者撞唯一约束（P2002）——
   * 这里**读回已存在的那条**而不是报错：幂等接口不该因为同时被调两次就失败。
   */
  async open(userId: string, orderId: string): Promise<ConversationItemDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, buyerId: true, providerId: true },
    });
    // 非买卖双方与"订单不存在"同一句话：不给外人确认某笔订单存在的机会
    if (!order || (order.buyerId !== userId && order.providerId !== userId)) {
      throw new BizException(ErrorCode.NotFound, undefined, '订单不存在');
    }

    const [a, b] = pairOf(order.buyerId, order.providerId);
    const row = (await this.findByPair(a, b)) ?? (await this.createPair(a, b, orderId));
    return this.toItem(row, userId);
  }

  /** 我的会话列表（按最后一条消息时间倒序；从未发言过的排在最后） */
  async listMine(userId: string, query: MessageListQueryDto): Promise<ConversationPageDto> {
    const where = { OR: [{ participantA: userId }, { participantB: userId }] };
    const [rows, total] = await Promise.all([
      this.prisma.conversation.findMany({
        where,
        orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.conversation.count({ where }),
    ]);
    if (rows.length === 0) {
      return { list: [], total, page: query.page, pageSize: query.pageSize };
    }

    const peers = rows.map((r) => (r.participantA === userId ? r.participantB : r.participantA));
    const [users, unreadRows] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: peers } }, select: { id: true, nickname: true } }),
      // "对方发来、我还没读"的条数：一次查完再在内存里归堆，比每行 count 一次少 N 次往返
      this.prisma.message.findMany({
        where: {
          conversationId: { in: rows.map((r) => r.id) },
          senderId: { not: userId },
          readStatus: false,
        },
        select: { conversationId: true },
      }),
    ]);
    const nicknameOf = mapNicknames(users);
    const unread = tally(unreadRows.map((m) => m.conversationId));
    return {
      list: rows.map((r) => toConversationItem(r, userId, nicknameOf, unread.get(r.id) ?? 0)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * 会话消息（分页，`createdAt` **升序**：第 1 页是最早的一屏）。
   *
   * 顺带把"对方发给我的未读"置为已读 —— 这是 `message.read_status` 唯一的写入点。
   * 不写它就是一个永远为 false 的死列：列表上的未读数只会越攒越多、点开也不掉。
   * 标记放在读取**之前**，返回的这一页才与"读完之后"的状态一致。
   */
  async messages(userId: string, conversationId: string, query: MessageListQueryDto) {
    await this.assertMember(userId, conversationId);
    await this.prisma.message.updateMany({
      where: { conversationId, senderId: { not: userId }, readStatus: false },
      data: { readStatus: true },
    });

    const [rows, total] = await Promise.all([
      this.prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.message.count({ where: { conversationId } }),
    ]);
    return {
      list: rows.map((r) => toMessageItem(r, userId)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    } satisfies MessagePageDto;
  }

  /** 发送消息：文本先送审（M4-05），再在同一事务里落库 + 更新摘要 + 给对方建未读通知 */
  async send(userId: string, conversationId: string, dto: SendMessageDto): Promise<MessageItemDto> {
    const conversation = await this.assertMember(userId, conversationId);
    const content = dto.content.trim();

    // 送审在事务**之前**：它是外部调用，不该长时间占着事务；违规消息也不该回滚一次落库
    await this.moderation.assertText(content, {
      userId,
      scene: 'comment',
      field: '消息内容',
    });

    const peerId = otherSide(conversation, userId);
    const sender = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { nickname: true },
    });
    const now = new Date();

    const created = await this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: { conversationId, senderId: userId, type: 'text', content, createdAt: now },
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: { lastMessage: clip(content, LAST_MESSAGE_MAX), lastMessageAt: now },
      });
      // ⭐ 同一事实的第二个视图：对方不打开消息中心也要知道"有人找你"
      await this.notifications.notify(tx, {
        userId: peerId,
        type: NotificationType.Order,
        title: `${sender?.nickname ?? '同学'}：给你发来一条消息`,
        body: clip(content, PREVIEW_MAX),
        refType: 'conversation',
        refId: conversationId,
      });
      return message;
    });

    return toMessageItem(created, userId);
  }

  // ---------- 内部 ----------

  private async findByPair(participantA: string, participantB: string): Promise<ConversationRow | null> {
    return this.prisma.conversation.findUnique({
      where: { participantA_participantB: { participantA, participantB } },
    });
  }

  /** 建会话。并发撞上唯一约束时读回已存在的那条（幂等） */
  private async createPair(participantA: string, participantB: string, orderId: string) {
    try {
      return await this.prisma.conversation.create({
        data: { participantA, participantB, refType: REF_ORDER, refId: orderId },
      });
    } catch (e) {
      const raced = isUniqueViolation(e) ? await this.findByPair(participantA, participantB) : null;
      if (raced) return raced;
      throw e;
    }
  }

  /** 单条会话 → 对端形状（昵称与未读数各查一次，`open` 只用在一两条会话上，不必合并成批量） */
  private async toItem(row: ConversationRow, viewerId: string): Promise<ConversationItemDto> {
    const peerId = otherSide(row, viewerId);
    const [peer, unread] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: peerId }, select: { nickname: true } }),
      this.prisma.message.count({
        where: { conversationId: row.id, senderId: { not: viewerId }, readStatus: false },
      }),
    ]);
    return toConversationItem(row, viewerId, () => peer?.nickname ?? undefined, unread);
  }

  /** 归属校验（结构性）：不是参与者就查不到 → 404 */
  private async assertMember(userId: string, conversationId: string): Promise<ConversationRow> {
    const row = await this.prisma.conversation.findFirst({
      where: { id: conversationId, OR: [{ participantA: userId }, { participantB: userId }] },
    });
    if (!row) throw new BizException(ErrorCode.NotFound, undefined, '会话不存在');
    return row;
  }
}

/** Prisma 唯一约束冲突（P2002）。用结构判断而不是 `instanceof`，避免耦合生成客户端的类 */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

/** 会话里"不是我"的那个人 */
function otherSide(row: { participantA: string; participantB: string }, viewerId: string): string {
  return row.participantA === viewerId ? row.participantB : row.participantA;
}

/** 用户行 → 取昵称的函数（列表只要昵称，不要求把整个 User 传下去） */
function mapNicknames(
  users: { id: string; nickname: string | null }[],
): (userId: string) => string | undefined {
  const byId = new Map(users.map((u) => [u.id, u.nickname ?? undefined]));
  return (userId) => byId.get(userId);
}

function tally(values: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of values) out.set(v, (out.get(v) ?? 0) + 1);
  return out;
}
