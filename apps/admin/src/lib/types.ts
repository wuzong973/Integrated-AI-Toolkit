import type { AdminPermission, AdminRole } from '@qz/core';

/**
 * 后台接口的返回形状（与 `apps/api/src/modules/admin/*.service.ts` 的导出接口一一对应）。
 *
 * ## 为什么手写而不用 `@prisma/client` 的类型
 *
 * 后端服务层已经把实体映射成了显式的对外形状（`AdminJobItem` 等），
 * 前端拿到的是**那些**形状，不是数据库行。直接复用 Prisma 类型会引入
 * `Date` / `Json` 这类前端不存在的类型，且会让人误以为"前端能看到整行"。
 *
 * ⚠️ 这些类型是**契约的快照**，后端改字段不会让前端编译失败。
 * 因此每个页面都必须对可选字段做兜底（列表里 `??` / 空态），
 * 不能假定字段一定存在。
 */

/** 列表接口的统一信封（后端返回的是 `{ list, total }`，不含 page/size） */
export interface ListResult<T> {
  list: T[];
  total: number;
}

/** 统一的分页查询参数 */
export interface PageQuery {
  page?: number;
  size?: number;
}

/* ==================== 登录 / 身份 ==================== */

export interface AdminProfile {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  adminRole: AdminRole;
  adminRoleLabel: string;
  permissions: AdminPermission[];
  status: string;
  lastLoginAt: string | null;
}

export interface AdminLoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  admin: AdminProfile;
}

/* ==================== 看板 ==================== */

/**
 * 单个环比数据点（后端 `admin-dashboard.window.ts` 的 `GrowthPoint` 快照）。
 *
 * `rate` 是**百分数**（`20` 读作 +20%，保留 1 位小数）；
 * ⚠️ 上一周期为 0 时 `rate` 是 `null` —— 那是「环比没有定义」，不是 0%、
 * 也不是「涨 100%」。界面必须走另一条文案，用 `current / previous` 这两个
 * 原始计数说话（如「上期 0 → 本期 7」），不要替它编一个百分比。
 */
export interface AdminGrowthPoint {
  current: number;
  previous: number;
  /** 环比百分数；上一周期为 0 时为 null */
  rate: number | null;
}

export interface AdminDashboardStats {
  users: {
    total: number;
    /** 账号状态正常数（`status='active'`），不是「登录活跃」 */
    active: number;
    banned: number;
    newToday: number;
    /** 近 7 个日历日（含今天）新增 */
    newWeek: number;
    /** 近 30 个日历日（含今天）新增 */
    newMonth: number;
    /** 新增用户的日 / 周 / 月环比（老后端可能没有这个字段，用时请判空） */
    growth?: {
      day: AdminGrowthPoint;
      week: AdminGrowthPoint;
      month: AdminGrowthPoint;
    };
  };
  verifications: { pending: number };
  orders: {
    total: number;
    inProgress: number;
    disputed: number;
    completed: number;
    /** 成交额（**分**，只统计已完成订单） */
    gmv: number;
    refundedCount: number;
  };
  jobs: { total: number; today: number; failedToday: number; queued: number; running: number };
  tools: { total: number; active: number; planned: number };
  topTools: { toolName: string; displayName: string; jobs7d: number }[];
  todos: { pendingVerifications: number; disputedOrders: number; failedJobsToday: number };
}

/* ==================== 用户 ==================== */

export interface AdminUserItem {
  id: string;
  nickname: string | null;
  avatar: string | null;
  phone: string | null;
  status: string;
  roles: string[];
  creditScore: number;
  points: number;
  balance: number;
  lastLogin: string | null;
  createdAt: string;
}

export interface AdminUserDetail extends AdminUserItem {
  college: string | null;
  grade: string | null;
  realName: string | null;
  verified: string[];
  pendingVerifications: number;
  orderCount: number;
  jobCount: number;
  adminAccountId: string | null;
}

export interface AdminUserListQuery extends PageQuery {
  keyword?: string;
  status?: string;
  role?: string;
}

export interface AdminUserUpdateBody {
  status?: string;
  roles?: string[];
  reason?: string;
}

/* ==================== 管理员 ==================== */

export interface AdminAccountItem {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  adminRole: AdminRole;
  adminRoleLabel: string;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  nickname: string | null;
  phone: string | null;
}

export interface AdminAccountDetail extends AdminAccountItem {
  permissions: AdminPermission[];
}

export interface AdminAccountListQuery extends PageQuery {
  keyword?: string;
  adminRole?: string;
  status?: string;
}

export interface AdminAccountCreateBody {
  username: string;
  password: string;
  displayName: string;
  adminRole: string;
}

export interface AdminAccountUpdateBody {
  displayName?: string;
  adminRole?: string;
  status?: string;
}

/* ==================== 内容审核 ==================== */

export interface AdminVerificationItem {
  id: string;
  type: string;
  typeLabel: string;
  status: string;
  userId: string;
  nickname: string | null;
  phone: string | null;
  realName: string | null;
  studentNo: string | null;
  schoolName: string | null;
  college: string | null;
  skillTags: string[];
  materials: string[];
  rejectReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface AdminVerificationQuery extends PageQuery {
  type?: string;
  status?: string;
}

/* ==================== 工具 / 作业 ==================== */

export interface AdminToolItem {
  name: string;
  displayName: string;
  category: string;
  status: string;
  visible: boolean;
  price: number;
  dailyQuota: number;
  jobs7d: number;
}

export interface AdminJobItem {
  id: string;
  toolName: string;
  status: string;
  progress: number;
  stage: string | null;
  cost: number;
  error: string | null;
  qualityScore: number | null;
  outputCount: number;
  userId: string;
  nickname: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AdminJobDetail extends AdminJobItem {
  params: unknown;
  outputFiles: string[];
  qualityIssues: string[];
}

export interface AdminJobListQuery extends PageQuery {
  keyword?: string;
  toolName?: string;
  status?: string;
  userId?: string;
}

/* ==================== 订单 ==================== */

export interface AdminOrderItem {
  id: string;
  orderNo: string;
  status: string;
  /** 金额单位一律是**分** */
  amount: number;
  platformFee: number;
  providerIncome: number;
  buyerId: string;
  buyerName: string | null;
  providerId: string;
  providerName: string | null;
  refundReason: string | null;
  hasTask: boolean;
  createdAt: string;
  paidAt: string | null;
  deliveredAt: string | null;
  deliveryCount: number;
  revisionCount: number;
}

export interface AdminOrderTimelineEntry {
  event: string;
  operatorId: string | null;
  createdAt: string;
  payload: unknown;
}

export interface AdminOrderDetail extends AdminOrderItem {
  requirement: string | null;
  deliveryRemark: string | null;
  deliveryFiles: string[];
  timeline: AdminOrderTimelineEntry[];
  payDeadline: string | null;
  completedAt: string | null;
  refundedAt: string | null;
}

export interface AdminOrderListQuery extends PageQuery {
  keyword?: string;
  status?: string;
  disputed?: boolean;
}

export interface AdminOrderResolveBody {
  action: 'release' | 'refund';
  reason: string;
}

/* ==================== 操作日志 ==================== */

export interface AdminAuditItem {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: string;
}

export interface AdminAuditQuery extends PageQuery {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
}
