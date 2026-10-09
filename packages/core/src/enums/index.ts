/**
 * 全局枚举（文档 1.2 角色体系 / 6.1.2 权限 / 6.2.6 状态机 / 6.6 交易 / 6.4 Job）
 * 纪律：所有状态判断必须引用此处枚举，禁止在业务代码里硬编码字符串。
 */

/** 用户角色（一账号多身份，文档 ADR-06） */
export enum Role {
  /** 游客（未登录） */
  Guest = 'guest',
  /** 学生（普通用户） */
  Student = 'student',
  /** 服务者（认证达人） */
  Provider = 'provider',
  /** 社团 / 学院 / 学校（组织方） */
  Organization = 'organization',
  /** 商户 */
  Merchant = 'merchant',
  /** 平台管理员 */
  Admin = 'admin',
}

/**
 * 性别（个人资料可选项）。
 *
 * 刻意留 `Unspecified` 这个**显式值**而不是用 null 表示"没填"：
 * 用户主动选"不想说"和"还没填过"是两件事，界面上要能区分（前者不再追问，后者可以提示补全）。
 * MySQL 侧是 VarChar，取值一律由本枚举约束。
 */
export enum Gender {
  Male = 'male',
  Female = 'female',
  Unspecified = 'unspecified',
}

/** 认证类型（文档 6.1.2） */
export enum VerificationType {
  Student = 'student',
  Skill = 'skill',
  Merchant = 'merchant',
}

/** 认证状态 */
export enum VerificationStatus {
  Pending = 'pending',
  Approved = 'approved',
  Rejected = 'rejected',
}

/** 工具分类（文档 6.4.2 scene） */
export enum ToolCategory {
  AiOffice = 'ai_office',
  Image = 'image',
  Video = 'video',
  Audio = 'audio',
  Pdf = 'pdf',
  File = 'file',
  AiLearn = 'ai_learn',
  Campus = 'campus',
  System = 'system',
}

/** 工具上线状态 */
export enum ToolStatus {
  /** 已上线可用 */
  Active = 'active',
  /** 已规划未实现（M1-01 验收要求） */
  Planned = 'planned',
  /** 灰度中 */
  Beta = 'beta',
  /** 已下线 */
  Disabled = 'disabled',
}

/** Job（工具执行作业）状态机（文档 6.5.1） */
export enum JobStatus {
  /** 已入队 */
  Queued = 'queued',
  /** 执行中 */
  Running = 'running',
  /** 成功（此时才正式扣费） */
  Succeeded = 'succeeded',
  /** 失败（自动退回积分） */
  Failed = 'failed',
  /** 已取消（自动退回积分） */
  Canceled = 'canceled',
  /** 参数校验未通过（未扣费） */
  Rejected = 'rejected',
}

/** 计划运行状态机（文档 6.2.6 Plan Run） */
export enum PlanRunStatus {
  Planning = 'planning',
  AwaitingConfirm = 'awaiting_confirm',
  Running = 'running',
  Succeeded = 'succeeded',
  PartialFailed = 'partial_failed',
  Failed = 'failed',
  Canceled = 'canceled',
}

/** 计划节点类型（文档 6.2.3） */
export enum NodeType {
  /** 可由 AI 工具完成 */
  Ai = 'ai',
  /** 必须真人完成 */
  Human = 'human',
  /** 需要用户决策 */
  Hitl = 'hitl',
  /** 可并行执行的一组 */
  ParallelGroup = 'parallel_group',
}

/** 计划节点状态机（文档 6.2.6 Node） */
export enum NodeStatus {
  Pending = 'pending',
  Running = 'running',
  Succeeded = 'succeeded',
  Failed = 'failed',
  Skipped = 'skipped',
  Blocked = 'blocked',
  AwaitingHitl = 'awaiting_hitl',
  AwaitingHuman = 'awaiting_human',
  Published = 'published',
  Assigned = 'assigned',
  Delivered = 'delivered',
  Accepted = 'accepted',
  Canceled = 'canceled',
}

/** HITL 类型（文档 6.2.5） */
export enum HitlType {
  /** 确认型：是/否 */
  Confirm = 'confirm',
  /** 选择型：方案 A/B/C */
  Choice = 'choice',
  /** 补充型：追问表单 */
  Input = 'input',
}

/** 任务（需求）状态机（文档 5.3.9 / 6.6.1） */
export enum TaskStatus {
  Draft = 'draft',
  Reviewing = 'reviewing',
  Published = 'published',
  Assigned = 'assigned',
  InProgress = 'in_progress',
  PendingAcceptance = 'pending_acceptance',
  Completed = 'completed',
  Closed = 'closed',
  Canceled = 'canceled',
}

/** 任务来源（文档 6.6.1 source 字段，闭环回流的关键） */
export enum TaskSource {
  /** 用户手动发布 */
  Manual = 'manual',
  /** AI 极速发布生成 */
  AiGenerated = 'ai_generated',
  /** 由 OS 编排的人力节点产生 */
  OsPlan = 'os_plan',
}

/** 订单状态机（文档 6.6.3） */
export enum OrderStatus {
  PendingPayment = 'pending_payment',
  Paid = 'paid',
  InService = 'in_service',
  PendingAcceptance = 'pending_acceptance',
  Completed = 'completed',
  RefundRequested = 'refund_requested',
  Refunded = 'refunded',
  Closed = 'closed',
  Canceled = 'canceled',
}

/** 报名状态 */
export enum ApplicationStatus {
  Pending = 'pending',
  Selected = 'selected',
  Rejected = 'rejected',
  Withdrawn = 'withdrawn',
}

/** 计价方式（文档 6.6.1） */
export enum PriceUnit {
  Fixed = 'fixed',
  Hourly = 'hourly',
  Negotiable = 'negotiable',
}

/** 资金流水类型 */
export enum LedgerType {
  Income = 'income',
  Expense = 'expense',
  Refund = 'refund',
  Withdraw = 'withdraw',
  Settle = 'settle',
  Freeze = 'freeze',
}

/** 通知渠道（文档 6.8） */
export enum NotifyChannel {
  InApp = 'in_app',
  SubscribeMessage = 'subscribe_message',
  WebSocket = 'websocket',
}

/** 意图大类（文档 6.2.2） */
export enum IntentType {
  AiGenerate = 'ai_generate',
  FileProcess = 'file_process',
  MediaAi = 'media_ai',
  CampusService = 'campus_service',
  Knowledge = 'knowledge',
  Unknown = 'unknown',
}

/** 文件场景（用于归属与配额，文档 6.5.6） */
export enum FileScene {
  AiGenerated = 'ai_generated',
  Uploaded = 'uploaded',
  OrderDelivery = 'order_delivery',
  Avatar = 'avatar',
  Verification = 'verification',
  Other = 'other',
}
