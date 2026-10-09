import { z } from 'zod';

/**
 * 会话与消息的形状与入参校验（任务清单 M3-19）
 *
 * ## 一个必须说清的现实：会话的唯一键是「用户对」，不是「订单」
 *
 * `conversation` 表的约束是 `@@unique([participant_a, participant_b])`，
 * `ref_type` / `ref_id` 只是**记录这条会话因哪笔订单而起**，并不参与唯一性。
 * 所以"按 orderId 幂等建/取"的真实语义是：
 *   · 同一对用户之间**永远只有一条会话**，多次为不同订单调用 `POST /conversations`
 *     会拿到同一条（`refId` 保留第一次那笔订单）；
 *   · 改约束（把 `ref_id` 并进唯一键）要动 schema 并迁移数据，不在本期范围内。
 * 这不是 bug 的遮羞布：产品上要"一个订单一个会话"，就先改表再改这里，两处必须一起动。
 *
 * ## 校验规则为什么在模块内
 *
 * 与 `notification.dto.ts` 同一个理由：改动范围被限定在本模块 + `apps/mp/utils/*`，
 * 接线时应整体上移到 `@qz/core/validators`。常量全部 export，不留两份真相。
 */

/** 单条消息正文上限（`content` 是 TEXT，放宽到 500 字足够说清一件事，也防止刷长文） */
export const MESSAGE_MAX_LEN = 500;
/** `conversation.last_message` VARCHAR(300) —— 摘要是**冗余的展示字段**，超出即截断 */
export const LAST_MESSAGE_MAX = 300;

/** `POST /conversations` 入参 */
export const CreateConversationSchema = z.object({
  orderId: z.string().min(1, '缺少订单号').max(60, '订单号过长'),
});
export type CreateConversationDto = z.infer<typeof CreateConversationSchema>;

/** `POST /conversations/:id/messages` 入参。空串在**参数层**就拒，不占用送审配额 */
export const SendMessageSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, '消息内容不能为空')
    .max(MESSAGE_MAX_LEN, `单条消息不超过 ${MESSAGE_MAX_LEN} 字`),
});
export type SendMessageDto = z.infer<typeof SendMessageSchema>;

/** `GET /conversations/:id/messages` 入参 */
export const MessageListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export type MessageListQueryDto = z.infer<typeof MessageListQuerySchema>;

/** 参与人双方按 id 升序存放（表注释就是这么约定的），否则 (A,B) 与 (B,A) 会建出两条会话 */
export function pairOf(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

/** `conversation` 表映射用得到的列 */
export interface ConversationRow {
  id: string;
  participantA: string;
  participantB: string;
  refType: string | null;
  refId: string | null;
  lastMessage: string | null;
  lastMessageAt: Date | null;
  createdAt: Date;
}

/** 会话列表项（对方是谁 + 最后一条摘要 + 未读数） */
export interface ConversationItemDto {
  id: string;
  /** 对方（会话是两个人的，"peer" 相对当前用户求） */
  peer: { id: string; nickname: string };
  lastMessage?: string;
  lastMessageAt?: string;
  /** 这条会话因哪笔订单而起（`refType`/`refId`） */
  refType?: string;
  orderId?: string;
  /** 对方发来、我还没读的消息条数 */
  unread: number;
  createdAt: string;
}

/** `message` 表里映射用得到的列 */
export interface MessageRow {
  id: string;
  conversationId: string;
  senderId: string;
  type: string;
  content: string;
  readStatus: boolean;
  createdAt: Date;
}

/** 一条消息 */
export interface MessageItemDto {
  id: string;
  conversationId: string;
  senderId: string;
  type: string;
  content: string;
  /** 服务端算好的"是不是我发的"：气泡左右朝向靠它，而不是让客户端比对自己的 id */
  mine: boolean;
  read: boolean;
  createdAt: string;
}

/** 会话分页（与 `/services`、`/orders` 同形状：`{ list, total }` + 分页回显） */
export interface ConversationPageDto {
  list: ConversationItemDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface MessagePageDto {
  list: MessageItemDto[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 行 → 会话条目。
 *
 * `nickname` 由调用方查好传进来（列表页一次查一批用户，而不是每行查一次）；
 * 昵称为空兜底"同学"，与订单模块的 `asParty()` 保持同一口径。
 */
export function toConversationItem(
  row: ConversationRow,
  viewerId: string,
  nicknameOf: (userId: string) => string | undefined,
  unread: number,
): ConversationItemDto {
  const peerId = row.participantA === viewerId ? row.participantB : row.participantA;
  return {
    id: row.id,
    peer: { id: peerId, nickname: nicknameOf(peerId) ?? '同学' },
    ...(row.lastMessage ? { lastMessage: row.lastMessage } : {}),
    ...(row.lastMessageAt ? { lastMessageAt: row.lastMessageAt.toISOString() } : {}),
    ...(row.refType ? { refType: row.refType } : {}),
    ...(row.refId ? { orderId: row.refId } : {}),
    unread,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toMessageItem(row: MessageRow, viewerId: string): MessageItemDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    type: row.type,
    content: row.content,
    mine: row.senderId === viewerId,
    read: row.readStatus,
    createdAt: row.createdAt.toISOString(),
  };
}
