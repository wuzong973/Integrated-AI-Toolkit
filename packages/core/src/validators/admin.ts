import { z } from 'zod';

import { AdminRole } from '../admin/permissions';

/**
 * 管理后台的共享校验（任务清单 M0-23）
 *
 * ## 为什么单独成文件
 *
 * `validators/index.ts` 已经贴着单文件 300 行红线（`max-lines`），
 * 继续往里加会让下一次追加直接变红。这里按主题拆出来，与 `os-run.ts` 同一做法。
 *
 * ## 为什么这些规则要放在 `@qz/core`
 *
 * 后台前端要拿它做**表单即时校验**（不让用户白提交一次再收到 400），
 * 后端要拿它做**权威校验**。两边各写一份的结局是：前端放行了后端拒绝
 * （表现为"这个字段明明填了却报错"），或前端拦了后端其实接受
 * （表现为"产品上能用的格式，界面不让填"）。
 */

const roleValues = Object.values(AdminRole) as [AdminRole, ...AdminRole[]];

/** 用户名：字母/数字/下划线/短横线，3-32 位。刻意不允许中文与空格，避免日志与 URL 里的编码问题 */
export const ADMIN_USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;

/**
 * 用户账号状态：管理端**能设置**的全集。
 *
 * 为什么要有这个常量而不继续在 schema 里写死字面量：
 * 后台的筛选下拉、编辑表单、以及"把接口返回的 `status: string` 收窄成
 * 可提交值"这三处都要用它。三处各写一遍 `['active','banned','disabled']`
 * 的结果是加一个状态时只改了其中两处 —— 第三处会静默地把新状态当成
 * "未知"而回落到 `active`，**等于一个改了状态的用户被界面改回正常**。
 *
 * ⚠️ 与 `User.status` 的数据库取值一一对应；`disabled` 表示用户主动注销。
 */
export const ADMIN_USER_STATUSES = ['active', 'banned', 'disabled'] as const;
export type AdminUserStatus = (typeof ADMIN_USER_STATUSES)[number];

/** 运行时收窄：接口返回的 `status` 是 string，不能直接当作可提交值 */
export function isAdminUserStatus(v: unknown): v is AdminUserStatus {
  return typeof v === 'string' && (ADMIN_USER_STATUSES as readonly string[]).includes(v);
}

/**
 * 密码下限 8 位。
 *
 * ⚠️ 这是**下限**，不是"够安全"。真正的强度策略（复杂度、泄露库比对、定期更换）
 * 应在生产环境由统一的身份系统承接；这里只保证"不会被随手用 123 打穿"。
 * 上限 128：scrypt 本身没有长度限制，但超长输入会变成一种廉价的 CPU 消耗攻击面。
 */
export const ADMIN_PASSWORD_MIN = 8;
export const ADMIN_PASSWORD_MAX = 128;

export const AdminLoginSchema = z.object({
  username: z.string().min(1, '请输入用户名').max(40),
  password: z.string().min(1, '请输入密码').max(ADMIN_PASSWORD_MAX),
});
export type AdminLoginDto = z.infer<typeof AdminLoginSchema>;

/** 修改自己的密码（账号页用） */
export const AdminChangePasswordSchema = z.object({
  oldPassword: z.string().min(1, '请输入当前密码').max(ADMIN_PASSWORD_MAX),
  newPassword: z
    .string()
    .min(ADMIN_PASSWORD_MIN, `新密码至少 ${ADMIN_PASSWORD_MIN} 位`)
    .max(ADMIN_PASSWORD_MAX),
});
export type AdminChangePasswordDto = z.infer<typeof AdminChangePasswordSchema>;

/** 新建管理员 */
export const AdminAccountCreateSchema = z.object({
  username: z
    .string()
    .regex(ADMIN_USERNAME_PATTERN, '用户名只能是 3-32 位字母、数字、下划线或短横线'),
  password: z
    .string()
    .min(ADMIN_PASSWORD_MIN, `密码至少 ${ADMIN_PASSWORD_MIN} 位`)
    .max(ADMIN_PASSWORD_MAX),
  displayName: z.string().min(1, '请填写显示名').max(30),
  adminRole: z.enum(roleValues),
});
export type AdminAccountCreateDto = z.infer<typeof AdminAccountCreateSchema>;

/**
 * 编辑管理员。
 *
 * `username` 刻意**不可改**：它是登录凭据的一半，改用户名等于换账号，
 * 而审计日志里记的仍是旧名字 —— 追溯时"这个人"就对不上了。
 * 真要换用户名，应禁用旧账号 + 建新账号。
 */
export const AdminAccountUpdateSchema = z.object({
  displayName: z.string().min(1).max(30).optional(),
  adminRole: z.enum(roleValues).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export type AdminAccountUpdateDto = z.infer<typeof AdminAccountUpdateSchema>;

/** 管理员重置他人密码 */
export const AdminResetPasswordSchema = z.object({
  newPassword: z
    .string()
    .min(ADMIN_PASSWORD_MIN, `密码至少 ${ADMIN_PASSWORD_MIN} 位`)
    .max(ADMIN_PASSWORD_MAX),
});
export type AdminResetPasswordDto = z.infer<typeof AdminResetPasswordSchema>;

/** 管理端列表分页（统一 `page` + `size`，与任务大厅一致；上限 100 便于导出场景） */
const AdminPageSchema = {
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
};

/**
 * 用户列表查询。
 *
 * `keyword` 同时匹配昵称 / 手机号 / 真实姓名 —— 运营排查时手上拿到的
 * 往往是其中任意一个，让用户先选"按什么搜"是多余的一步。
 */
export const AdminUserListQuerySchema = z.object({
  keyword: z.string().max(60).optional(),
  status: z.enum(ADMIN_USER_STATUSES).optional(),
  role: z.string().max(20).optional(),
  ...AdminPageSchema,
});
export type AdminUserListQueryDto = z.infer<typeof AdminUserListQuerySchema>;

/**
 * 修改用户状态 / 角色。
 *
 * `roles` 是**全量覆盖**而不是增量：增量语义在并发下会丢更新
 * （两次同时"加个角色"可能只生效一个），而全量覆盖天然幂等。
 */
export const AdminUserUpdateSchema = z.object({
  status: z.enum(ADMIN_USER_STATUSES).optional(),
  roles: z.array(z.string().max(20)).max(6).optional(),
  /** 变更原因，写入审计日志 —— 封禁一个学生必须留得下"为什么" */
  reason: z.string().max(200).optional(),
});
export type AdminUserUpdateDto = z.infer<typeof AdminUserUpdateSchema>;

/**
 * 后台内容审核队列查询。
 *
 * 比 C 端个人视图多一个 `type` 过滤：后台要看的是"某一类申请的积压"，
 * 而个人只看自己的。`status` 不传时**返回全部**（含已审）——
 * 后台排查"这条当时为什么通过"必须能看到历史，默认只看 pending 会让它查不到。
 */
export const AdminVerificationListQuerySchema = z.object({
  type: z.string().max(20).optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  ...AdminPageSchema,
});
export type AdminVerificationListQueryDto = z.infer<typeof AdminVerificationListQuerySchema>;

/** 管理员账号列表查询 */
export const AdminAccountListQuerySchema = z.object({
  keyword: z.string().max(40).optional(),
  adminRole: z.enum(roleValues).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  ...AdminPageSchema,
});
export type AdminAccountListQueryDto = z.infer<typeof AdminAccountListQuerySchema>;

/** 作业列表查询（管理端：跨用户，支持按工具与状态筛） */
export const AdminJobListQuerySchema = z.object({
  keyword: z.string().max(60).optional(),
  toolName: z.string().max(60).optional(),
  status: z
    .enum(['queued', 'running', 'succeeded', 'failed', 'canceled', 'rejected'])
    .optional(),
  userId: z.string().max(36).optional(),
  ...AdminPageSchema,
});
export type AdminJobListQueryDto = z.infer<typeof AdminJobListQuerySchema>;

/**
 * 工具上下线。
 *
 * 取值与 `Tool.status` 的既有约定一致（见 `seed.ts` 与 `check:tools`）：
 * `active` 才会出现在 C 端且真的能跑，其它值都表示"建设中"。
 * 这里只开放 `active` / `planned` 两个 —— 后台点"下线"的语义是"先藏起来"，
 * 而不是发明第三种状态。
 */
export const AdminToolStatusSchema = z.object({
  status: z.enum(['active', 'planned']),
});
export type AdminToolStatusDto = z.infer<typeof AdminToolStatusSchema>;

/** 订单列表查询（管理端） */
export const AdminOrderListQuerySchema = z.object({
  keyword: z.string().max(60).optional(),
  status: z.string().max(30).optional(),
  /** 只看有争议的（退款中 / 已退款），纠纷裁决的默认视图 */
  disputed: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === 'true'),
  ...AdminPageSchema,
});
export type AdminOrderListQueryDto = z.infer<typeof AdminOrderListQuerySchema>;

/**
 * 订单裁决。
 *
 * 只允许两个动作，且都**必须给理由**：
 *   release —— 放行给服务者（把托管资金结算出去）
 *   refund  —— 退款给买家
 *
 * 无理由裁决在纠纷复盘时等于没记录，而钱已经动了。
 */
export const AdminOrderResolveSchema = z.object({
  action: z.enum(['release', 'refund']),
  reason: z.string().min(4, '请填写裁决理由（至少 4 个字）').max(300),
});
export type AdminOrderResolveDto = z.infer<typeof AdminOrderResolveSchema>;

/** 操作日志查询 */
export const AdminAuditListQuerySchema = z.object({
  actorId: z.string().max(36).optional(),
  action: z.string().max(60).optional(),
  targetType: z.string().max(40).optional(),
  targetId: z.string().max(60).optional(),
  ...AdminPageSchema,
});
export type AdminAuditListQueryDto = z.infer<typeof AdminAuditListQuerySchema>;
