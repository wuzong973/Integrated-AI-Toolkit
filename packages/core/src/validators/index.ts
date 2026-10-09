import { z } from 'zod';

import { Gender, TaskStatus } from '../enums';

/**
 * 共享校验规则（前后端共用，避免"两边规则不一致"）
 * 纪律：DTO 校验规则定义在此处，后端用它做参数校验，前端用它做表单校验。
 */

/** 微信登录：code 换取 token */
export const LoginSchema = z.object({
  code: z.string().min(1, '缺少微信登录 code'),
  /** 邀请码（可选，用于校园推广归因） */
  inviteCode: z.string().max(32).optional(),
});
export type LoginDto = z.infer<typeof LoginSchema>;

/** 刷新 token */
export const RefreshSchema = z.object({ refreshToken: z.string().min(10) });
export type RefreshDto = z.infer<typeof RefreshSchema>;

/**
 * 中国大陆手机号：1 开头、第二位 3~9、共 11 位。
 *
 * **这是全项目唯一的手机号格式规则**：小程序表单、`UpdateProfileSchema`、
 * 以及短信网关侧的 `isChinaMobile` 都指到这里。
 * 规则分两处写迟早漂移（改号段时只想起义的那一份，另一份就会静默放行或静默拦截）。
 */
export const CHINA_MOBILE_PATTERN = /^1[3-9]\d{9}$/;

/** 更新个人资料 */
export const UpdateProfileSchema = z.object({
  nickname: z.string().min(1).max(30).optional(),
  avatar: z.string().url().max(500).optional(),
  bio: z.string().max(200).optional(),
  college: z.string().max(60).optional(),
  grade: z.string().max(20).optional(),
  skills: z.array(z.string().max(20)).max(20).optional(),
  gender: z.nativeEnum(Gender).optional(),
  /**
   * 手机号：目前是**用户自填**，平台不做真实性校验（没有短信网关、也没接微信
   * 手机号快速验证组件），所以界面必须标"未验证"。落库受 `user.phone @unique`
   * 约束，撞号由 `UserService.updateMe` 转成可读提示。
   */
  phone: z
    .string()
    .regex(CHINA_MOBILE_PATTERN, '请输入 11 位中国大陆手机号')
    .optional(),
});
export type UpdateProfileDto = z.infer<typeof UpdateProfileSchema>;

/** 文件直传：申请签名 */
export const PresignSchema = z.object({
  filename: z.string().min(1).max(200),
  size: z.number().int().positive(),
  contentType: z.string().min(1).max(100),
  scene: z.enum(['ai_generated', 'uploaded', 'order_delivery', 'avatar', 'verification', 'other']),
});
export type PresignDto = z.infer<typeof PresignSchema>;

/** 文件确认上传 */
export const ConfirmFileSchema = z.object({
  objectKey: z.string().min(1),
  filename: z.string().min(1).max(200),
  size: z.number().int().positive(),
  hash: z.string().max(128).optional(),
  scene: z.enum(['ai_generated', 'uploaded', 'order_delivery', 'avatar', 'verification', 'other']),
});
export type ConfirmFileDto = z.infer<typeof ConfirmFileSchema>;

/** 文件列表查询 */
export const FileListQuerySchema = z.object({
  scene: z
    .enum(['ai_generated', 'uploaded', 'order_delivery', 'avatar', 'verification', 'other'])
    .optional(),
  /** 是否只看回收站；同样不能用 z.coerce.boolean()（'false' 会被当成 true） */
  trashed: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === 'true'),
});
export type FileListQueryDto = z.infer<typeof FileListQuerySchema>;

/** 作业列表查询（M1-03） */
export const JobListQuerySchema = z.object({
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled', 'rejected']).optional(),
});
export type JobListQueryDto = z.infer<typeof JobListQuerySchema>;

/** 工具目录列表查询（M1-01） */
export const ToolListQuerySchema = z.object({
  categoryId: z.string().max(40).optional(),
  /** 关键词，匹配工具名 / 显示名 / 描述 */
  keyword: z.string().max(40).optional(),
  /**
   * 是否包含 Agent 内部工具（visible=false），默认不返回。
   * 注意：不能用 z.coerce.boolean() —— Boolean('false') === true，
   * 查询串里的 "false" 会被当成开启。这里显式比较字符串。
   */
  includeInternal: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === 'true'),
});
export type ToolListQueryDto = z.infer<typeof ToolListQuerySchema>;

/**
 * 任务大厅列表查询（M3 驿站只读入口）
 *
 * `status` 不传时**默认只看已发布** —— 这是"任务大厅"的语义：
 * 大厅里不应该出现 draft / reviewing 的草稿，否则用户会看到自己还没提交完的需求。
 * 要查别的状态必须显式传（服务方工作台查 assigned 走这条路）。
 */
export const TaskListQuerySchema = z.object({
  categoryId: z.string().max(40).optional(),
  /** 关键词，匹配标题 / 描述 */
  keyword: z.string().max(40).optional(),
  status: z.nativeEnum(TaskStatus).optional(),
  /**
   * 只看"与我相关"的任务（**必须登录**，未登录时忽略）。
   *
   *   publisher —— 我发布的（"我的发布"）
   *   provider  —— 我接的单（`selectedProviderId` 是我）
   *
   * ⚠️ 为什么必须由服务端过滤而不是客户端筛：
   * 工作台此前用 `status=assigned` 查"我的任务"，拿到的是**全站所有已选定任务** ——
   * 别人接的单会出现在我的工作台上。这不是显示问题，是**越权看到他人订单**。
   */
  role: z.enum(['publisher', 'provider']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(50).default(20),
});
export type TaskListQueryDto = z.infer<typeof TaskListQuerySchema>;

/** 工具调用（文档 6.4.3） */
export const InvokeToolSchema = z.object({
  runId: z.string().optional(),
  nodeId: z.string().optional(),
  async: z.boolean().optional().default(false),
  params: z.record(z.unknown()).optional().default({}),
  fileIds: z.array(z.string()).max(9).optional().default([]),
  /** 涉版权工具的强制声明（文档 6.7.2，服务端二次校验） */
  copyrightAck: z.boolean().optional().default(false),
});
export type InvokeToolDto = z.infer<typeof InvokeToolSchema>;

/** 发送会话消息 */
export const SendMessageSchema = z.object({
  content: z.string().min(1).max(4000),
  contentType: z.enum(['text', 'image', 'file']).optional().default('text'),
  fileIds: z.array(z.string()).max(9).optional(),
});
export type SendMessageDto = z.infer<typeof SendMessageSchema>;

/** HITL 决策提交（文档 6.2.5） */
export const HitlDecisionSchema = z.object({
  nodeId: z.string().min(1),
  type: z.enum(['confirm', 'choice', 'input']),
  approved: z.boolean().optional(),
  choice: z.string().optional(),
  input: z.record(z.unknown()).optional(),
});
export type HitlDecisionDto = z.infer<typeof HitlDecisionSchema>;

/** 发布需求（标准表单，文档 6.6.2） */
export const PublishTaskSchema = z.object({
  title: z.string().min(4, '标题至少 4 个字').max(60),
  categoryId: z.string().min(1),
  description: z.string().min(10, '请补充需求描述').max(2000),
  budget: z.number().int().nonnegative(), // 单位：分
  budgetType: z.enum(['fixed', 'negotiable', 'hourly']),
  deadline: z.string().datetime().optional(),
  location: z.string().max(120).optional(),
  skillTags: z.array(z.string().max(20)).max(10).optional().default([]),
  attachmentIds: z.array(z.string()).max(9).optional().default([]),
  /**
   * 需求来源。
   *
   *   manual       —— 用户手填表单
   *   ai_generated —— 走 AI 极速发布（模型解析出来的草稿）
   *   os_plan      —— 来自青智 OS 编排的真人节点（闭环回流）
   *   result       —— 来自工具箱结果页的「找人帮做」
   *
   * ⚠️ 客户端从 v1 起就在传这个字段，而 schema 里一直没有 ——
   * 于是它被 Zod 的严格对象**静默丢弃**，所有任务都落成 `manual`。
   * 这类"字段名对得上、但没进 schema"的丢失不会报错，只会让来源统计永远只有一个值。
   */
  source: z.enum(['manual', 'ai_generated', 'os_plan', 'result']).optional().default('manual'),
  /** 来自 OS 编排的计划 ID（闭环回流用） */
  refRunId: z.string().optional(),
});
export type PublishTaskDto = z.infer<typeof PublishTaskSchema>;

/** AI 极速发布：一句话解析 */
export const ParseRequirementSchema = z.object({
  text: z.string().min(4).max(500),
});
export type ParseRequirementDto = z.infer<typeof ParseRequirementSchema>;

/** 报名 / 抢单 */
export const ApplyTaskSchema = z.object({
  quote: z.number().int().nonnegative().optional(),
  message: z.string().max(500).optional(),
});
export type ApplyTaskDto = z.infer<typeof ApplyTaskSchema>;

/**
 * 选定服务者（M3-10 派单）。
 *
 * 选定后会**在同一事务里**把任务置为 `assigned` 并生成担保订单（M3-11），
 * 所以它不是一个纯粹的"改状态"接口 —— 金额与状态必须一起成功或一起失败。
 */
export const SelectProviderSchema = z.object({
  providerId: z.string().min(1),
  /** 成交金额（分）。不传则取任务预算 */
  amount: z.number().int().positive().optional(),
});
export type SelectProviderDto = z.infer<typeof SelectProviderSchema>;

/** 智能匹配查询（M3-09）：为某条任务推荐服务者 */
export const MatchQuerySchema = z.object({
  taskId: z.string().min(1),
  /** 返回条数上限。默认 10 —— 发布者实际只会看前几个 */
  limit: z.coerce.number().int().min(1).max(20).default(10),
});
export type MatchQueryDto = z.infer<typeof MatchQuerySchema>;

/** 创建订单 */
export const CreateOrderSchema = z.object({
  taskId: z.string().optional(),
  serviceId: z.string().optional(),
  providerId: z.string().min(1),
  amount: z.number().int().positive(),
});
export type CreateOrderDto = z.infer<typeof CreateOrderSchema>;

/** 提交交付物 */
export const DeliverSchema = z.object({
  fileIds: z.array(z.string()).min(1, '请上传交付物'),
  remark: z.string().max(500).optional(),
});
export type DeliverDto = z.infer<typeof DeliverSchema>;

/** 验收 / 要求修改 / 退款 */
export const AcceptSchema = z.object({ rating: z.number().int().min(1).max(5).optional() });
export type AcceptDto = z.infer<typeof AcceptSchema>;
export const RequestRevisionSchema = z.object({ reason: z.string().min(2).max(300) });
export type RequestRevisionDto = z.infer<typeof RequestRevisionSchema>;
export const RefundSchema = z.object({ reason: z.string().min(2).max(300) });
export type RefundDto = z.infer<typeof RefundSchema>;

/** 评价（文档 6.6.4） */
export const ReviewSchema = z.object({
  orderId: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  tags: z.array(z.string().max(20)).max(10).optional().default([]),
  content: z.string().max(500).optional(),
  images: z.array(z.string()).max(9).optional().default([]),
  isAnonymous: z.boolean().optional().default(false),
});
export type ReviewDto = z.infer<typeof ReviewSchema>;

/** 服务者入驻申请（文档 5.3.12） */
/** 服务者入驻申请（文档 5.3.12 三步表单的 step 1 + step 2 核心） */
export const ProviderApplySchema = z.object({
  realName: z.string().min(2).max(20),
  studentNo: z.string().min(4).max(30),
  schoolId: z.string().min(1),
  college: z.string().max(60).optional(),
  materialIds: z.array(z.string()).min(1, '请上传学生证照片'),
  skillTags: z.array(z.string().max(20)).min(1, '至少填写一项技能').max(10),
  portfolioIds: z.array(z.string()).optional().default([]),
  /**
   * ⚠️ `startPrice`（起步价）与 `serviceArea`（可服务范围）**不在这里**。
   *
   * 它们属于 **M3-03 技能画像**（"服务定价、接单偏好"），而不是入驻认证 ——
   * 而且 `serviceArea` 在库里本来就是 **`service` 表**的字段（每个商品各自的范围），
   * 不是服务者级属性。
   *
   * 之前这两个字段挂在入驻 schema 上，但**库里没有任何列接得住**：
   * 客户端填了、接口收了、然后被丢掉，且不会有任何报错 ——
   * 典型的"看着像存了、其实没存"。要加回来请连同 `user_profile` 的新列一起加。
   */
});
export type ProviderApplyDto = z.infer<typeof ProviderApplySchema>;

/**
 * 认证审核（管理端，M3-02）。
 *
 * `refine` 不是装饰：M3-02 的验收标准就是「**驳回时给出具体原因**」。
 * 只把 `reason` 声明成 optional 是不够的 —— 那样服务端仍然可能存下一条
 * 没有原因的驳回，用户看到"未通过"却不知道改什么，只能反复重交。
 */
export const ReviewVerificationSchema = z
  .object({
    approved: z.boolean(),
    /** 驳回原因。通过时不需要 */
    reason: z.string().max(300).optional(),
  })
  .refine((v) => v.approved || (v.reason ?? '').trim().length >= 4, {
    message: '驳回必须填写具体原因（至少 4 个字），否则用户不知道该改什么',
    path: ['reason'],
  });
export type ReviewVerificationDto = z.infer<typeof ReviewVerificationSchema>;

/** 认证申请列表查询（管理端） */
export const VerificationListQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(50).default(20),
});
export type VerificationListQueryDto = z.infer<typeof VerificationListQuerySchema>;

/** 分页查询（统一约定，文档 9.1） */
export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  size: z.coerce.number().int().min(1).max(100).optional().default(20),
  sort: z.string().max(60).optional(),
});
export type PageQueryDto = z.infer<typeof PageQuerySchema>;

// ==================== 青智 OS（AI 助手） ====================

/**
 * 意图类型。
 * ⚠️ 取值必须与小程序 `pages/os/index.ts` 的 `INTENT_TOOL_MAP` / `localIntent`
 * 以及 `MockLlmProvider.guessIntent` 保持一致 —— 三处任一处改了名字，
 * 界面就会退化成"什么都不知道"的兜底回复。
 */
export const OS_INTENTS = [
  'file_process',
  'media_ai',
  'ai_generate',
  'campus_service',
  'knowledge',
] as const;
export type OsIntentName = (typeof OS_INTENTS)[number];

/** 意图识别结果（服务端产出、客户端渲染，共用同一套契约） */
export interface OsIntentResult {
  intent: OsIntentName;
  confidence: number;
  /** 复合意图：需要拆成"AI 节点 + 人力节点"的计划卡 */
  isComposite: boolean;
  /** 抽出的关键实体（如文件格式、目标体积、活动人数） */
  entities?: Record<string, string>;
  /** 信息不足时，先向用户确认而不是硬猜 */
  needsClarification?: boolean;
  questions?: string[];
  /**
   * 复合意图下的子任务（用于渲染计划卡）。
   * `type` 决定它是 AI 节点还是需要真人的节点 —— 客户端据此决定
   * 是否提供"发布到驿站"的入口。**全部为待执行状态**，不代表已经跑完。
   */
  subtasks?: { name: string; type: 'ai' | 'human' }[];
}

/** 新建 OS 会话 */
export const CreateOsSessionSchema = z.object({
  title: z.string().max(120).optional(),
  scene: z.string().max(40).optional(),
});
export type CreateOsSessionDto = z.infer<typeof CreateOsSessionSchema>;

/** 发送消息 */
export const SendOsMessageSchema = z.object({
  content: z.string().min(1, '消息不能为空').max(4000, '消息过长'),
  /**
   * 当前对话里用户**已上传**的文件 id（来自 `POST /files/confirm`）。
   *
   * 有了它，"帮我抠个图"这类请求才能在**对话里直接执行**（用户刚传完图就说了一句），
   * 而不是只能回一张"请先上传"的引导卡。没有它时不是错误，只是退化为引导。
   *
   * 上限 9 与 `InvokeToolSchema.fileIds` 一致：最终会原样传给工具调用，
   * 两边上限不同会让"界面上允许 20 个、到了执行器被拒"这种怪事发生。
   */
  fileIds: z.array(z.string()).max(9).optional().default([]),
});
export type SendOsMessageDto = z.infer<typeof SendOsMessageSchema>;

/** 意图识别请求 */
export const OsIntentSchema = z.object({
  text: z.string().min(1, '缺少 text').max(4000, '文本过长'),
});
export type OsIntentDto = z.infer<typeof OsIntentSchema>;

/**
 * 计划节点类型（M2-05 planner：`type ∈ ai/human/hitl/external`）。
 *
 * - `ai`：机器可独立完成（写方案、做预算表、生成海报提示词…）
 * - `human`：必须真人到场或动手（摄影摄像、现场主持…）→ 界面给"去驿站发布"入口
 * - `hitl`：需要用户本人确认（Human-In-The-Loop），如"确认预算口径"
 * - `external`：依赖平台外的第三方（如场地审批）
 */
export const OS_PLAN_NODE_TYPES = ['ai', 'human', 'hitl', 'external'] as const;
export type OsPlanNodeType = (typeof OS_PLAN_NODE_TYPES)[number];

/** 单个计划节点（DAG 中的一个顶点） */
export interface OsPlanNode {
  id: string;
  name: string;
  type: OsPlanNodeType;
  /** 依赖的前置节点 id 列表；由服务端做"存在性 + 无环"校验 */
  dependsOn: string[];
  /** 建议使用的工具名（可选）。服务端只接受**已上线**的工具，避免把人引到死路 */
  tool?: string;
}

/**
 * 任务规划结果（M2-05 planner）。
 *
 * ⚠️ `degraded` 必须如实上报：模型产出的 JSON 非法时会降级成线性清单，
 * 界面上要能区分"AI 真的拆解过"与"只是排了个顺序"（红线 9：不许假装成功）。
 */
export interface OsPlanResult {
  goal: string;
  nodes: OsPlanNode[];
  /** true = 未经模型成功规划，由服务端降级为线性清单 */
  degraded: boolean;
  /** 降级原因（面向排查，可展示给用户） */
  degradedReason?: string;
  /**
   * 本次计划对应的运行记录 id（M2-06 计划 Run 持久化）。
   *
   * **只有请求带了 `sessionId` 且规划成功（非降级）时才有值** ——
   * Run 必须挂在会话上（`os_plan_run.session_id` 是必填外键），
   * 降级时也没有可持久化的节点。拿不到 runId 的客户端行为与之前完全一致，
   * 所以这里是**可选字段**而不是改形状（不破坏既有契约）。
   */
  runId?: string;
}

/** 计划节点数上限（文档 M2-05 验收：节点 ≤12） */
export const OS_PLAN_MAX_NODES = 12;

/**
 * 任务规划请求。
 *
 * `sessionId`（M2-06 追加，可选）：带上它，服务端才会把产出的计划持久化成
 * `OsPlanRun` + 逐节点 `OsTaskNode`，并在响应里回 `runId`；
 * 不带就退回 M2-05 的行为（只回计划、不留运行记录）——
 * Run 必须挂在会话上（`os_plan_run.session_id` 是必填外键），
 * 没有会话就硬造一个"影子会话"只会让会话列表多出一条用户没建过的记录。
 */
export const OsPlanSchema = z.object({
  goal: z.string().min(1, '缺少 goal').max(4000, '文本过长'),
  sessionId: z.string().max(64, '会话 id 过长').optional(),
});
export type OsPlanDto = z.infer<typeof OsPlanSchema>;

// ============================================================
// 校园知识库 RAG（M4-06）
// ============================================================

/** 知识库文档分类（与 `seed.ts` 的 `KnowledgeDoc.category` 取值保持一致） */
export const KNOWLEDGE_CATEGORIES = ['policy', 'guide', 'template', 'faq', 'general'] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

/**
 * 灌库请求（把一篇文档切片后写入向量库）。
 *
 * ⚠️ 这是**管理侧**接口：知识库是全站共享的，普通学生写入会污染所有人的检索结果，
 * 所以控制器上必须挂 `@Roles(Role.Admin)`，不能只要求登录。
 */
export const KnowledgeIngestSchema = z.object({
  title: z.string().min(1, '缺少标题').max(200, '标题过长'),
  source: z.string().max(300).optional(),
  category: z.enum(KNOWLEDGE_CATEGORIES).default('general'),
  /** 正文。上限 20 万字，约对应 400 个切片，再大应拆成多篇文档 */
  content: z.string().min(1, '正文不能为空').max(200_000, '正文过长，请拆成多篇文档'),
});
export type KnowledgeIngestDto = z.infer<typeof KnowledgeIngestSchema>;

/** 检索请求 */
export const KnowledgeSearchSchema = z.object({
  query: z.string().min(1, '缺少 query').max(1000, '问题过长'),
  topK: z.number().int().min(1).max(20).optional(),
});
export type KnowledgeSearchDto = z.infer<typeof KnowledgeSearchSchema>;

/** 问答请求（检索 + 带引用的回答） */
export const KnowledgeAskSchema = z.object({
  question: z.string().min(1, '缺少 question').max(1000, '问题过长'),
});
export type KnowledgeAskDto = z.infer<typeof KnowledgeAskSchema>;

/**
 * 一条检索命中。
 *
 * `text` 是**切片原文**（存在向量库的 payload 里，不是回表查的）——
 * 检索命中后要立刻把它交给 LLM 或展示给用户，回表会让"检索到了、正文查不到"
 * 变成一类静默错误。
 */
export interface KnowledgeHit {
  documentId: string;
  title: string;
  source?: string;
  category: string;
  /** 该切片在文档中的序号（从 0 开始），用于定位与引用 */
  chunkIndex: number;
  text: string;
  score: number;
}

/**
 * 带引用的回答。
 *
 * ⭐ `grounded` 是这套设计的关键：**检索没命中时不许模型硬答**。
 * 没有这个字段时，模型会拿着 5 条最不相关的切片编出一个听起来很合理的答案，
 * 而用户无从分辨。`grounded: false` 时 `answer` 是一句如实的"知识库里没有相关内容"。
 */
export interface KnowledgeAnswer {
  answer: string;
  citations: { index: number; title: string; source?: string; score: number }[];
  /** 是否有真实检索依据 */
  grounded: boolean;
}

/** 灌库结果 */
export interface KnowledgeIngestResult {
  documentId: string;
  /** 切了多少片 */
  chunkCount: number;
  /** 向量库实际写入的集合名（便于确认没写错地方） */
  collection: string;
}

// 计划 Run 的节点操作校验（M2-06）按主题单独成文件：本文件贴着 300 行红线（`max-lines`），
// 继续往里加只会让下一次追加直接变红。以下三个出口同理。
export * from './os-run';
export * from './admin';
export * from './vocab';
// 服务市场（M3-04 / M3-05）同样单独成文件。
export * from './service-market';
// 练习中心（M4-16）除 schema 外还承载**评分纯逻辑**（`scoreSpoken` / `judgeSentence`），
// 因为后端与小程序必须算同一个分数。
export * from './practice';
