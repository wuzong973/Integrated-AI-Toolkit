/**
 * 站内消息接口切片（任务清单 M3-19）
 *
 * ## 为什么单独一个文件
 *
 * `utils/api.ts` 是"按域划分的调用表"，`audit:api` 靠解析它来核对
 * "客户端调的每个接口后端是否注册"。该文件已贴着 300 有效行红线，
 * 再塞进两个域（站内信 + 会话）和它们的类型就会撞线 —— 而**类型与调用分开**
 * 会让这个域读起来横跨三个文件。所以这一片按域整体独立成文件，
 * 由 `api.ts` 用 `export *` 转出：页面仍然 `import { messageApi } from '../../utils/api'`，
 * 调用方无需改动。⚠️ 新文件的调用同样要纳入体检，见 `scripts/dev/audit-api-routes.mjs` 的 CLIENT_FILES。
 *
 * ## 与后端契约的三处细节（前端接线时容易踩）
 *
 * ① `unread` 只接受 `0 | 1`：query 参数过不了后端的 `z.enum(['0','1'])`，
 *    传 `true` 会被判成 40001"请检查填写的内容"，看起来像"接口坏了"。
 * ② 列表返回的是 `{ list, total, unreadCount }`，**不是裸数组**（旧 `messageApi.notifications()`
 *    声明的 `unknown[]` 从来没对上后端，因为后端当时还不存在这些路由）。
 * ③ `POST /conversations` 是**幂等**的"建/取"：拿到的一直是同一会话（唯一键是用户对，
 *    不是订单）。为第二笔订单再调一次不会另开一条，`orderId` 仍指回第一次那笔。
 * ④ 会话消息是**升序**分页（第 1 页最早）；`GET messages` 会把对方发来的未读置为已读，
 *    所以轮询它同时也清了红点。
 */
import { http } from './request';

// ---------- 类型（与 apps/api 的 dto 一一对应） ----------

/** 通知分组：`order` 交易 / `task` 任务 / `system` 系统（后端枚举同名） */
export type NotificationType = 'order' | 'task' | 'system';

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  content: string;
  /** 由后端 `readAt` 派生，客户端不要再自己存一份已读状态 */
  read: boolean;
  createdAt: string;
  readAt?: string;
  /** 跳转锚点：order / task / conversation + 对应 id */
  refType?: string;
  refId?: string;
}

export interface NotificationPage {
  list: NotificationItem[];
  total: number;
  page: number;
  pageSize: number;
  /** 我全部未读数（不受 type / unread 筛选影响），Tab 角标用它 */
  unreadCount: number;
}

export interface NotificationQuery {
  page?: number;
  pageSize?: number;
  type?: NotificationType;
  /** 只看未读：只能是 0 / 1（见文件头 ①） */
  unread?: 0 | 1;
}

/** 一条会话（交易沟通） */
export interface ConversationItem {
  id: string;
  /** 对方会话是两个人的，"peer" 相对当前用户求 */
  peer: { id: string; nickname: string };
  lastMessage?: string;
  lastMessageAt?: string;
  refType?: string;
  /** 这条会话因哪笔订单而起 */
  orderId?: string;
  /** 对方发来、我还没读的消息条数 */
  unread: number;
  createdAt: string;
}

export interface ConversationPage {
  list: ConversationItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface MessageItem {
  id: string;
  conversationId: string;
  senderId: string;
  type: string;
  content: string;
  /** 服务端算好的"是不是我发的"：气泡左右朝向靠它，不要拿本地 id 去比 */
  mine: boolean;
  read: boolean;
  createdAt: string;
}

export interface MessagePage {
  list: MessageItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PageQuery {
  page?: number;
  pageSize?: number;
}

// ---------- 站内信（通知视图） ----------
export const messageApi = {
  /** 我的通知：一次拿到列表 + 未读数（红点与列表同一次往返，不会互相对不上） */
  list: (query: NotificationQuery = {}) =>
    http.get<NotificationPage>('/notifications', { loading: false, params: { ...query } }),
  /** 标记单条已读。重复调用仍成功；不是自己的一条 → 404 */
  read: (id: string) =>
    http.post<{ id: string; read: boolean }>(`/notifications/${id}/read`, undefined, {
      loading: false,
    }),
  /** 一键已读，返回真正变化的条数（据此把角标清零） */
  readAll: () => http.post<{ updated: number }>('/notifications/read-all'),
};

// ---------- 会话（交易沟通） ----------
export const conversationApi = {
  /** 按订单建/取会话（幂等）。非买卖双方 → 404 */
  open: (orderId: string) => http.post<ConversationItem>('/conversations', { orderId }),
  /** 我的会话列表（带最后一条摘要与未读数），按最后消息时间倒序 */
  list: (query: PageQuery = {}) =>
    http.get<ConversationPage>('/conversations', { loading: false, params: { ...query } }),
  /** 消息（升序分页）。读取本身会把对方的未读置为已读 */
  messages: (conversationId: string, query: PageQuery = {}) =>
    http.get<MessagePage>(`/conversations/${conversationId}/messages`, {
      loading: false,
      params: { ...query },
    }),
  /**
   * 发送文本消息。正文在后端过内容安全（M4-05）：
   * 违规返回 40051，页面按 `toastError` 如实提示"未通过安全审核，请修改后重试"，
   * 不要在前端把这条错误吞掉或显示成"发送成功"。
   */
  send: (conversationId: string, content: string) =>
    http.post<MessageItem>(`/conversations/${conversationId}/messages`, { content }),
};
