/**
 * 状态 → 文案 / 色调的唯一映射（列表页、详情页、标签组件共用）。
 *
 * ## 为什么不放 `@qz/core`
 *
 * 状态**枚举**在 `@qz/core`（权威，状态机用它迁移）；这里只做**展示映射**，
 * 与 `apps/mp/utils/order-status.ts` 是同一层的东西。展示文案属于客户端表现层，
 * 放共享包里会让"改一句中文"变成一次跨端发版。
 *
 * ⚠️ 代价是两边可能漂移，因此：
 *   · 订单状态文案**刻意与 `apps/mp/utils/order-status.ts` 保持一致**（同一批字），
 *     改一边必须同步另一边；
 *   · 未知状态一律回落为**原始值**而不是"未知" —— 后端加了新状态时，
 *     界面上会直接暴露 `pending_arbitration` 这样的裸值，一眼就能发现前端没跟进。
 *     回落成"未知"会让它看起来像个正常状态，反而查不出来。
 */

import { ADMIN_USER_STATUSES, Role, type AdminUserStatus } from '@qz/core';

/** 标签色调（对应 `components.css` 的 `.qz-tag--*`） */
export type Tone = 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/**
 * 用户状态展示。
 *
 * `Record<AdminUserStatus, …>` 而不是 `Record<string, …>`：键集合由
 * `@qz/core` 的常量**在编译期**约束住，将来后端加了状态而这里漏写，
 * 会直接编译失败而不是在界面上显示一个裸字符串。
 */
const USER_STATUS: Record<AdminUserStatus, { text: string; tone: Tone }> = {
  active: { text: '正常', tone: 'success' },
  banned: { text: '已封禁', tone: 'danger' },
  disabled: { text: '已注销', tone: 'neutral' },
};

const JOB_STATUS: Record<string, { text: string; tone: Tone }> = {
  queued: { text: '排队中', tone: 'neutral' },
  running: { text: '执行中', tone: 'info' },
  succeeded: { text: '已完成', tone: 'success' },
  failed: { text: '处理失败', tone: 'danger' },
  canceled: { text: '已取消', tone: 'neutral' },
  rejected: { text: '已拒绝', tone: 'warning' },
};

/** 与 `apps/mp/utils/order-status.ts` 的 `ORDER_STATUS_TEXT` 同源 */
const ORDER_STATUS: Record<string, { text: string; tone: Tone }> = {
  pending_payment: { text: '待支付', tone: 'warning' },
  paid: { text: '担保中', tone: 'info' },
  in_service: { text: '服务中', tone: 'info' },
  pending_acceptance: { text: '待验收', tone: 'brand' },
  completed: { text: '已完成', tone: 'success' },
  refund_requested: { text: '退款中', tone: 'danger' },
  refunded: { text: '已退款', tone: 'neutral' },
  closed: { text: '已关闭', tone: 'neutral' },
  canceled: { text: '已取消', tone: 'neutral' },
};

const VERIFICATION_STATUS: Record<string, { text: string; tone: Tone }> = {
  pending: { text: '待审核', tone: 'warning' },
  approved: { text: '已通过', tone: 'success' },
  rejected: { text: '已拒绝', tone: 'danger' },
};

const TOOL_STATUS: Record<string, { text: string; tone: Tone }> = {
  active: { text: '已上线', tone: 'success' },
  planned: { text: '建设中', tone: 'neutral' },
};

const ADMIN_STATUS: Record<string, { text: string; tone: Tone }> = {
  active: { text: '启用', tone: 'success' },
  disabled: { text: '已禁用', tone: 'danger' },
};

function lookup(map: Record<string, { text: string; tone: Tone }>, raw: string) {
  return map[raw] ?? { text: raw, tone: 'neutral' as Tone };
}

export const userStatus = (v: string) => lookup(USER_STATUS, v);
export const jobStatus = (v: string) => lookup(JOB_STATUS, v);
export const orderStatus = (v: string) => lookup(ORDER_STATUS, v);
export const verificationStatus = (v: string) => lookup(VERIFICATION_STATUS, v);
export const toolStatus = (v: string) => lookup(TOOL_STATUS, v);
export const adminStatus = (v: string) => lookup(ADMIN_STATUS, v);

/** 筛选项用：把映射表摊成 `[{value,label}]`，避免界面里再手写一遍选项 */
export function toOptions(map: Record<string, { text: string }>) {
  return Object.entries(map).map(([value, v]) => ({ value, label: v.text }));
}

/**
 * 用户状态选项。
 *
 * 顺序与集合都取自 `@qz/core` 的 `ADMIN_USER_STATUSES`（**不是**
 * `Object.entries(USER_STATUS)`）：这里顺序即界面顺序，且集合必须与
 * 后端 schema 一字不差 —— 少一个就会"筛不出那种状态"，多一个就筛出空列表。
 */
export const userStatusOptions = () =>
  ADMIN_USER_STATUSES.map((value) => ({ value, label: USER_STATUS[value].text }));

export const userStatusValues: readonly string[] = ADMIN_USER_STATUSES;

export const jobStatusOptions = () => toOptions(JOB_STATUS);
export const orderStatusOptions = () => toOptions(ORDER_STATUS);
export const verificationStatusOptions = () => toOptions(VERIFICATION_STATUS);

/**
 * 质量分语义（AI 产出专用）。
 *
 * 阈值与 `@qz/core` 的评分器口径一致（≥80 好 / ≥60 一般 / <60 差）。
 * `null` 表示"这个工具不产质量分"（非 AI 工具），**不是 0 分** ——
 * 界面上必须区分：显示 `—` 而不是"0 分"，否则运营会去追查一个不存在的问题。
 */
export function qualityTone(score: number | null): 'good' | 'fair' | 'poor' | null {
  if (score === null || score === undefined) return null;
  if (score >= 80) return 'good';
  if (score >= 60) return 'fair';
  return 'poor';
}

/** 工具分类中文名（与 seed 的 category 取值对齐） */
export const TOOL_CATEGORY_TEXT: Record<string, string> = {
  image: '图片',
  office: '办公',
  text: '文本',
  video: '视频',
  audio: '音频',
  pdf: 'PDF',
  other: '其它',
};

export function toolCategoryText(category: string): string {
  return TOOL_CATEGORY_TEXT[category] ?? category;
}

/**
 * 业务角色中文名。
 *
 * ⚠️ 这里的 key 必须与 `@qz/core` 的 `Role` 枚举**逐字对应**。
 * 为什么不用 `Object.values(Role)` 生成：枚举里含 `guest`（游客，不会出现在
 * 用户表里），把它渲染成筛选项会让运营筛出一个永远为空的列表。
 * 因此这里显式列出"用户可能真实拥有的角色"，`guest` 刻意排除。
 */
export const ROLE_TEXT: Record<string, string> = {
  student: '学生',
  provider: '服务者',
  organization: '组织方',
  merchant: '商户',
  admin: '平台管理员',
};

export function roleText(role: string): string {
  return ROLE_TEXT[role] ?? role;
}

export const roleOptions = () =>
  Object.entries(ROLE_TEXT).map(([value, label]) => ({ value, label }));

/**
 * 可由"用户管理"页直接授予 / 收回的角色。
 *
 * 两个刻意排除：
 *   · `guest`（游客）不会出现在用户表里，做成勾选项只会让人误勾；
 *   · `admin`（平台管理员）必须经 `admin_account` 表建立 ——
 *     在用户页勾一个 `admin` 只会得到"有角色标记但没有后台账号"的四不像，
 *     既登不进后台，又会在角色列表里显示成管理员。
 */
export const EDITABLE_ROLES: readonly string[] = [
  Role.Student,
  Role.Provider,
  Role.Organization,
  Role.Merchant,
];

/**
 * 订单时间线事件 → 中文（取值来自 `apps/api/src/modules/order/` 的写入点）。
 *
 * 未知事件回落为**原始值**：后端新增事件类型时，详情页会直接显示
 * `arbitration_started` 这样的裸值，一眼能看出前端没跟进；
 * 回落成"其它"则会让它淹没在一堆正常事件里。
 */
export const ORDER_EVENT_TEXT: Record<string, string> = {
  created: '下单',
  paid: '支付成功（资金进入担保）',
  revision_requested: '买家要求修改',
  accepted: '买家验收（放款给服务者）',
  refund_requested: '买家申请退款',
  refunded: '交易关闭（已退款）',
};

export function orderEventText(event: string): string {
  return ORDER_EVENT_TEXT[event] ?? event;
}
