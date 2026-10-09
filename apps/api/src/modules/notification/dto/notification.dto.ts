import { asJsonObject } from '@qz/core';
import { z } from 'zod';

/**
 * 通知（站内信）的形状与入参校验（任务清单 M3-19）
 *
 * ## 为什么校验规则写在模块内、而不是 `packages/core/src/validators`
 *
 * 工程纪律确实要求"前后端共用 core 的 zod schema"。但 M3-19 这一片的改动范围被限定在
 * `modules/notification/**` 与 `apps/mp/utils/*`（消息中心页面的接线由并行的第三条任务推进），
 * 所以先把规则放在模块内并**把所有常量 export 出去**：接线时应把本 schema 整体上移到
 * `@qz/core/validators` 再从这里 re-export，避免出现"后端标题限 120 字、前端按 200 字校验"
 * 这类两份真相（与 `modules/billing/dto/withdrawal.dto.ts` 同一个处理方式）。
 *
 * ## `type` 的三个取值就是消息中心的三个分组
 *
 * `order` 交易通知（交付 / 验收 / 退款）、`task` 任务通知（报名 / 选定 / 关闭）、
 * `system` 系统通知（平台公告）。与文档 6.8.1 的三类一致 ——
 * 客户端**不需要**再猜"这条该显示在哪一组"，也不会各自约定出一套新枚举。
 *
 * ## `refType` / `refId` 存在 `ref` 这个 Json 列里
 *
 * schema 没有为跳转锚点单开两列（不改 schema 是本期约束），落成
 * `ref: { refType: 'order', refId: '<订单 id>' }`。读写都收在这里：
 * 写入由 `NotificationService.notify()` 组装，读取由 `toNotificationItem()` 收窄，
 * 中间不出现 `as` 强转（Json 列脏了要降级成"没有跳转"，而不是运行时报错）。
 */

/** 通知类型值域（`notification.type`，VARCHAR(40)） */
export const NOTIFICATION_TYPES = ['order', 'task', 'system'] as const;
export type NotificationTypeValue = (typeof NOTIFICATION_TYPES)[number];

/** 服务端扇出时用的字面量常量（`satisfies` 保证写错值直接编译失败） */
export const NotificationType = {
  Order: 'order',
  Task: 'task',
  System: 'system',
} as const satisfies Record<'Order' | 'Task' | 'System', NotificationTypeValue>;

/** 列宽上限：`title` VARCHAR(120)、`content` VARCHAR(600) */
export const NOTIFICATION_TITLE_MAX = 120;
export const NOTIFICATION_BODY_MAX = 600;

/**
 * 截断到列宽以内。
 *
 * 为什么截断而不是抛错：通知是**业务动作的附属品**（在同一个事务里写）。
 * 一条 601 字的正文让"交付成功"整单回滚，是最糟糕的取舍 ——
 * 用户会以为交付失败了再点一次，于是状态机那边直接报"状态已变更"。
 */
export function clip(value: string, max: number): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `GET /notifications` 入参（`page` / `pageSize` 走 query，与 `/services` 同形状） */
export const NotificationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  type: z.enum(NOTIFICATION_TYPES).optional(),
  /** `unread=1` 只看未读。query 参数只有字符串，所以显式列两个合法值而不是 coerce */
  unread: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
});
export type NotificationListQueryDto = z.infer<typeof NotificationListQuerySchema>;

/** 一条通知（字段与 `apps/mp/utils/api-types.ts` 的 `NotificationItem` 一一对应） */
export interface NotificationItemDto {
  id: string;
  type: string;
  title: string;
  content: string;
  /** 由 `readAt` 派生：库里只有时间戳，没有"已读"布尔列（少一份真相少一处漂移） */
  read: boolean;
  createdAt: string;
  readAt?: string;
  /** 跳转锚点：客户端据此决定"点了去哪"（order / task / conversation） */
  refType?: string;
  refId?: string;
}

/** 分页 + 未读数。未读数与列表**一次往返**拿全，否则红点要么不准要么多打一次接口 */
export interface NotificationPageDto {
  list: NotificationItemDto[];
  total: number;
  page: number;
  pageSize: number;
  unreadCount: number;
}

/** `notification` 表里映射用得到的列（结构类型，避免耦合 Prisma 生成的类型名） */
export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  content: string;
  ref: unknown;
  readAt: Date | null;
  createdAt: Date;
}

/** 行 → 对端条目。可空字段用条件展开，不往响应里写 `null`（WXML 会把 null 渲染成 "null"） */
export function toNotificationItem(row: NotificationRow): NotificationItemDto {
  const ref = asJsonObject(row.ref);
  const refType = typeof ref?.refType === 'string' ? ref.refType : undefined;
  const refId = typeof ref?.refId === 'string' ? ref.refId : undefined;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content,
    read: row.readAt !== null,
    createdAt: row.createdAt.toISOString(),
    ...(row.readAt ? { readAt: row.readAt.toISOString() } : {}),
    ...(refType ? { refType } : {}),
    ...(refId ? { refId } : {}),
  };
}

/**
 * `notify()` 的入参。
 *
 * `body` 而不是 `content`：调用点写起来是"给谁发什么"，
 * 与表列名 `content` 的差异只在映射那一行出现。
 */
export interface NotifyInput {
  userId: string;
  type: NotificationTypeValue;
  title: string;
  body: string;
  refType?: string;
  refId?: string;
}
