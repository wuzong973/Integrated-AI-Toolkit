/**
 * 管理后台接口类型（小程序侧，任务清单 M3-20）。
 *
 * ## 为什么单独成文件
 *
 * `api-types.ts` 已经 400+ 行，而 `max-lines`(300 代码行) 对 `apps/mp` 不豁免；
 * 后台这一域的契约又自成一体（七个块、三张列表），拆出来读得清楚。
 * 由 `api-types.ts` 原样转出，页面仍从 `utils/api` 导入。
 *
 * ⚠️ 这些形状是 `apps/admin/src/lib/types.ts` 的**子集**（只取小程序要渲染的字段）。
 * 两边同源于后端 `AdminDashboardStats` 等类型；后台加字段时这里不补只会少显示，
 * 不会报错 —— 所以每个块都写了"取哪些字段"的注释，方便对账。
 *
 * ⚠️ **发出去的请求参数一律写成 `type X = {...}`，不要写 `interface`。**
 * `http.get(path, { params })` 与 `http.post(path, body)` 的入参类型是
 * `Record<string, unknown>`，而 TypeScript 只给**类型别名**隐式索引签名，
 * `interface` 拿不到 —— 改成 interface 会当场编译不过（不是风格问题，是会红）。
 */

/** 分页壳：后端一律回 `{ list, total }`（见 `admin-user.service.list`） */
export interface AdminListResult<T> {
  list: T[];
  total: number;
}

/** 环比一个点：比率未定义时为 null（上期基数为 0），界面必须显示"不适用"而不是 0% */
export interface AdminGrowthPoint {
  current: number;
  previous: number;
  /** 百分数，保留一位小数（133.3 读作 +133.3%）；分母为 0 时 null */
  rate: number | null;
}

/** 概览页要的全部数字（后端 `AdminDashboardService.stats()` 的返回） */
export interface AdminStats {
  users: {
    total: number;
    /** 账号状态正常数（`status='active'`）—— 是账号状态，不是"登录活跃" */
    active: number;
    banned: number;
    newToday: number;
    newWeek: number;
    newMonth: number;
    growth?: { day: AdminGrowthPoint; week: AdminGrowthPoint; month: AdminGrowthPoint };
  };
  verifications: { pending: number };
  orders: {
    total: number;
    inProgress: number;
    disputed: number;
    completed: number;
    /** 成交额，单位**分**，只统计已完成订单 */
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
  /** 余额，单位分 */
  balance: number;
  lastLogin: string | null;
  createdAt: string;
}

export type AdminUserQuery = {
  page?: number;
  size?: number;
  keyword?: string;
  status?: string;
  role?: string;
}

/* ==================== 认证审核 ==================== */

export interface AdminVerificationItem {
  id: string;
  type: string;
  typeLabel: string;
  status: string;
  userId: string;
  nickname: string | null;
  realName: string | null;
  studentNo: string | null;
  schoolName: string | null;
  college: string | null;
  skillTags: string[];
  /** 材料是文件 id 列表；小程序侧不逐个展开（点开要看图另说） */
  materials: string[];
  rejectReason: string | null;
  createdAt: string;
}

export type AdminVerificationQuery = {
  page?: number;
  size?: number;
  type?: string;
  status?: string;
}

/**
 * 审核动作。后端 schema：`ReviewVerificationSchema`（与 C 端审核共用同一份）。
 *
 * ⚠️ 驳回**必须**填 ≥4 个字的原因（后端 `.refine` 拦），否则会被打回
 * "驳回必须填写具体原因，否则用户不知道该改什么" —— 界面要在提交前就提示，
 * 不要让用户点下去才吃到这个错。
 */
export type AdminReviewBody = {
  approved: boolean;
  /** 驳回时必填，至少 4 个字；通过时不需要 */
  reason?: string;
}

/* ==================== 订单 ==================== */

export interface AdminOrderItem {
  id: string;
  orderNo: string;
  status: string;
  /** 金额一律分 */
  amount: number;
  platformFee: number;
  providerIncome: number;
  buyerName: string | null;
  providerName: string | null;
  refundReason: string | null;
  createdAt: string;
  paidAt: string | null;
  completedAt?: string | null;
  deliveredAt: string | null;
}

export type AdminOrderQuery = {
  page?: number;
  size?: number;
  keyword?: string;
  status?: string;
  disputed?: boolean;
}
