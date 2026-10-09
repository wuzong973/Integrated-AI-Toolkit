/**
 * 接口层的数据类型（从 `utils/api.ts` 拆出来）。
 *
 * ## 为什么要拆
 *
 * `api.ts` 是一个"按域划分的调用表"，`audit:api` 会解析它来核对
 * "客户端调的每个接口后端是否注册"。接口一多，类型声明就把这个文件撑到 300 行上限 ——
 * 而**调用表本身才是这个文件存在的理由**，被类型挤掉是本末倒置。
 *
 * 所以：**类型在这里，调用方法在 `api.ts`**。`api.ts` 用 `export *` 原样转出，
 * 页面继续从 `utils/api` 导入，不需要改任何调用方。
 */
import type { OsToolCard } from './os';

/** 管理后台（M3-20）那一域的类型单独成文件，这里原样转出 */
export * from './api-types-admin';

// ---------- 健康检查 / 配置 ----------

export interface HealthInfo {
  status: string;
  version: string;
  env: string;
  providerMode: string;
  dependencies: { database: string };
  mockProviders: string[];
  time: string;
}

export interface PublicConfig {
  version: string;
  billing: {
    enabled: boolean;
    mode: 'free' | 'points';
    /** 免费期的展示文案（服务端下发，保证各端一致） */
    notice: string;
  };
}

// ---------- 认证 / 用户 ----------

export interface MeInfo {
  id: string;
  nickname: string | null;
  avatar: string | null;
  phone: string | null;
  college: string | null;
  grade: string | null;
  /**
   * 性别：`male` / `female` / `unspecified`，或 null。
   *
   * ⚠️ null 与 `unspecified` **不是一回事**：前者是"从没填过"（可以提示补全），
   * 后者是"看过了、主动选了不想说"（不该再追问）。同源定义见 core 的 `Gender`。
   */
  gender: string | null;
  roles: string[];
  /**
   * 是否管理员（后端由"状态为 active 的 admin 角色"推出，见 `auth.service.buildMe`）。
   *
   * ⚠️ 它只用来决定**要不要显示管理员入口**，不是权限本身 ——
   * 真正的拦截在后端。所以它缺失/为 false 时一律按"不是管理员"处理（fail-closed）。
   */
  isAdmin: boolean;
  isStudentVerified: boolean;
  isProvider: boolean;
  creditScore: number;
  points: number;
  balance: number;
  completedOrders: number;
  bio?: string | null;
  skills?: string[];
  tags?: string[];
  maskedPhone?: string | null;
}

/**
 * 个人资料提交体（`PUT /user/me`）。
 *
 * **PATCH 语义**：只提交改动过的字段，后端 `UpdateProfileSchema` 全部 optional，
 * 空对象是合法的。所以编辑页保存时必须做差异比较，不能把没动的字段一起发回去 ——
 * 尤其 `phone`：把别人已占用的号原样重发会撞唯一约束，报出"该手机号已被其他账号绑定"。
 *
 * 规则本体在后端（`packages/core/src/validators`），这里的类型只保证形状对得上。
 *
 * ⚠️ 必须是 `type` 而不是 `interface`：`http.put` 的 body 形参是
 * `Record<string, unknown>`，而 TS 只给类型别名隐式索引签名。
 */
export type ProfileUpdatePayload = {
  nickname?: string;
  avatar?: string;
  bio?: string;
  college?: string;
  grade?: string;
  gender?: 'male' | 'female' | 'unspecified';
  /** 用户自填，平台未做真实性校验：界面必须标"未验证" */
  phone?: string;
};

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: MeInfo;
  isNewUser: boolean;
}

// ---------- 工具箱 / 作业 / 文件 ----------

export interface ToolItem {
  name: string;
  displayName: string;
  categoryId: string;
  description: string;
  price: number;
  status: string;
  sync: boolean;
  useCount: number;
  requiresCopyrightAck: boolean;
}

export interface ToolCategoryItem {
  id: string;
  name: string;
  icon?: string;
  scene: string;
}

export interface JobItem {
  id: string;
  toolName: string;
  status: string;
  progress: number;
  stage?: string;
  cost: number;
  /** ⚠️ 里面是**文件 id**，不是 URL（要 `GET /files/:id` 拿名字） */
  outputFiles: string[];
  error?: string;
  createdAt: string;
  /**
   * 产出指标（压缩率/分辨率/时长/页数…）。
   *
   * 没有它，结果页只能显示「共 N 个产物」—— 用户无从判断这次产出好不好。
   * 结构由后端 `job-result.ts` 定义，前端只消费、不重定义判据。
   */
  result?: JobResultMetrics;
  /** AI 产出的质量分（0-100），非 AI 工具为空 */
  qualityScore?: number;
  /** 质量扣分项（人类可读） */
  qualityIssues?: string[];
}

/** 产出指标（与后端 job-result.ts 同形状，仅取展示需要的字段） */
export interface JobResultMetrics {
  kind: 'image' | 'media' | 'content' | 'pdf' | 'other';
  inputBytes?: number;
  outputBytes?: number;
  targetMet?: boolean;
  width?: number;
  height?: number;
  format?: string;
  durationSec?: number;
  encoder?: string;
  chars?: number;
  pages?: number;
  layoutKinds?: number;
  chartKinds?: number;
}

export interface FileItem {
  id: string;
  name: string;
  type: string;
  size: number;
  scene: string;
  createdAt: string;
}

/** 文件归属场景（与 packages/core 的 PresignSchema 取值一致） */
export type UploadScene =
  'ai_generated' | 'uploaded' | 'order_delivery' | 'avatar' | 'verification' | 'other';

/** 直传签名（`uploadUrl` 是对象存储地址，不走本服务的响应体） */
export interface PresignResult {
  uploadUrl: string;
  headers: Record<string, string>;
  objectKey: string;
  expiresIn: number;
}

// ---------- 驿站 ----------

export interface TaskItem {
  id: string;
  taskNo: string;
  title: string;
  description: string;
  /** 预算，单位**分** */
  budget: number;
  budgetType: string;
  deadline?: string;
  location?: string;
  skillTags: string[];
  status: string;
  source: string;
  applyCount: number;
  createdAt: string;
  publisher?: { id: string; nickname: string; creditScore: number };
  /**
   * 是否为**示例数据**（seed 写入的任务），由服务端下发。
   * 为 true 时列表必须显示"演示数据"角标 —— 否则用户分不清
   * "平台的真实任务" 与 "造出来的示例"（红线 10）。
   */
  isDemo?: boolean;
  /**
   * 与**当前登录用户**的匹配度（0~100），未登录时不下发。
   *
   * ⚠️ 以前工作台自己算过这个数（`Math.max(60, 95 - i * 7)`，按列表序号递减），
   * 以"匹配度 95%"展示给服务者 —— 那是假数据冒充功能（红线 10）。
   * 现在由服务端 `calcMatchScore` 真实计算；**没有该字段时不要自己编一个**，
   * 应当隐藏这一行。
   */
  matchScore?: number;
  /** 为什么是这个分（服务端给的事实依据） */
  matchReasons?: string[];
}

/**
 * 推荐服务者（发布者视角，`GET /station/match`）。
 *
 * 用于"还没有人报名"时告诉发布者"这条需求适合谁"。
 * `reasons` 是服务端给的事实依据 —— 界面要展示它，
 * 否则用户只能看到一个没有来源的百分比（这正是匹配度最容易变成装饰的地方）。
 */
export interface MatchedProvider {
  userId: string;
  nickname: string;
  avatar?: string;
  skills: string[];
  creditScore: number;
  completedOrders: number;
  /** 匹配度 0~100，服务端真实计算 */
  score: number;
  reasons: string[];
}

/** 报名者（发布者视角，见 `GET /station/tasks/:id/applications`） */ export interface ApplicationItem {
  id: string;
  providerId: string;
  nickname: string;
  avatar?: string;
  creditScore: number;
  completedOrders: number;
  /** 报价，单位**分**；0 表示未报价 */
  quote: number;
  message?: string;
  status: string;
  createdAt: string;
  /** 与这条需求的匹配度（服务端真实计算，未算出时不下发） */
  matchScore?: number;
  matchReasons?: string[];
}

// ---------- 订单 ----------

export interface OrderItem {
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

// ---------- 服务者入驻认证（M3-02） ----------

/** 认证申请（本人视角；管理端另有列表接口） */
export interface VerificationItem {
  id: string;
  type: string;
  /** pending | approved | rejected */
  status: string;
  realName?: string;
  /** ⚠️ 学号是敏感信息，只在本人与管理员接口下发 */
  studentNo?: string;
  schoolId?: string;
  college?: string;
  skillTags: string[];
  /** 材料文件 id（学生证 + 作品集） */
  materials: string[];
  /** 驳回原因。**驳回时必定有值**（服务端强制），界面必须展示它 */
  rejectReason?: string;
  reviewedAt?: string;
  createdAt: string;
}

/** 我的服务者资料与认证状态 */
export interface ProviderProfile {
  isProvider: boolean;
  skills: string[];
  creditScore: number;
  completedOrders: number;
  realName: string | null;
  college: string | null;
  /** 最近一次入驻申请。`null` = 从未申请过 */
  verification: VerificationItem | null;
}

// ---------- 服务商品（M3-04） ----------
export interface ServiceItem {
  id: string;
  title: string;
  description: string;
  cover?: string;
  /** 价格，单位「分」 */
  price: number;
  priceUnit: string;
  deliveryDays?: number;
  serviceArea?: string;
  skillTags: string[];
  status: string;
  categoryId: string;
  categoryName?: string;
  orderCount: number;
  viewCount: number;
  createdAt: string;
  updatedAt: string;
  provider: {
    id: string;
    nickname: string;
    avatar?: string;
    /** 均分 = ratingSum/ratingCount；无人评价时后端给 null，界面显示"暂无评价" */
    rating: number | null;
    ratingCount: number;
    creditScore: number;
    completedOrders: number;
  };
}

// ---------- 提现记录（M3-13） ----------
export interface WithdrawalItem {
  id: string;
  amount: number;
  fee: number;
  status: string;
  remark?: string;
  createdAt: string;
}

// ---------- 评价（M3-16） ----------
export interface ReviewItem {
  id: string;
  orderId: string;
  rating: number;
  tags: string[];
  anonymous: boolean;
  nickname: string;
  createdAt: string;
  content?: string;
  /** 匿名时后端不下发（结构性防泄露） */
  peerId?: string;
}

// ---------- OS 计划 Run 看板（M2-06） ----------
export interface OsRunNode {
  nodeId: string;
  name: string;
  type: string;
  status: string;
  actorLabel: string;
  detail: string;
  dependsOn: string[];
  progress: number;
  budget: number;
  refTaskId?: string;
  error?: string;
  updatedAt: string;
}
export interface OsRunView {
  runId: string;
  sessionId: string;
  goal: string;
  status: string;
  progress: { done: number; total: number; percent: number };
  stages: { name: string; nodes: OsRunNode[] }[];
  jobs: { jobId: string; toolName: string; status: string; createdAt: string }[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

// ---------- OS 会话与聊天记录（历史记录页） ----------
/**
 * 会话条目（对应后端 `GET /os/sessions`）。
 *
 * 后端已按 `updatedAt desc` 排序、且**只返回有消息的会话** ——
 * 客户端每次进 AI 页都会建一个新会话，不过滤的话列表会被空壳会话淹掉。
 */
export interface OsSessionItem {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}

/** 消息条目（对应后端 `GET /os/sessions/:id/messages`，按 `createdAt asc`） */
export interface OsMessageItem {
  id: string;
  role: string;
  agentName?: string;
  /** 后端 contentType（text / card / …），客户端按白名单映射成渲染形态 */
  kind: string;
  content: string;
  cards?: OsToolCard[];
  createdAt: string;
}

/**
 * 记单词 / 四六级词汇训练（M4-15）的类型在 `./vocab-types`。
 * 在下面原样转出，页面继续 `from '../../utils/api'` 导入，调用方无需改动。
 */
export * from './vocab-types';

/**
 * 练习中心（M4-16：句子 / 口语 / 作文）的类型在 `./practice-types`。
 * 同样原样转出 —— 单独成文件是因为这里也贴着 300 行上限。
 */
export * from './practice-types';

