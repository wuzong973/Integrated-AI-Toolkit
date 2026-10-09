/**
 * 管理后台 RBAC（任务清单 M0-23；ADR-06 账号模型）
 *
 * ## 为什么权限矩阵放在 `@qz/core` 而不是后端
 *
 * 后台前端要靠它**渲染菜单与按钮**，后端要靠它**拦截接口**。两处各写一份的
 * 必然结局是漂移：界面显示了按钮但接口 403（用户看到"点了报错"），
 * 或者更糟 —— 接口漏配权限而界面把它藏起来了（**看不见的越权**）。
 * 放在共享层，两边 import 同一个常量，漂移在编译期就不可能发生。
 *
 * ## ⚠️ 前端按权限隐藏菜单只是"体验"，不是安全边界
 *
 * 真正的边界是后端 `@RequirePermission()` 守卫。隐藏按钮挡不住任何人直接调接口，
 * 所以**每一个**写接口都必须在服务端声明权限点，不能因为"界面藏了"就省掉。
 *
 * ## 权限点按"动作"划分，不按"接口"划分
 *
 * 例如 `user:manage` 同时保护"改状态"和"改角色"两个接口。按接口划分会让
 * 权限点数量随接口数爆炸，而管理员配权限时想的是"能不能改用户"，
 * 不是"能不能调 PATCH /admin/users/:id"。
 */

/** 管理员角色 */
export enum AdminRole {
  /** 超级管理员：全部权限，含管理员账号与角色矩阵 */
  SuperAdmin = 'super_admin',
  /** 运营：用户、内容、工具与作业、订单查看 */
  Operator = 'operator',
  /** 审核员：认证与内容审核 */
  Auditor = 'auditor',
  /** 财务：订单资金裁决与对账 */
  Finance = 'finance',
}

/** 权限点 */
export enum AdminPermission {
  DashboardView = 'dashboard:view',

  UserView = 'user:view',
  /** 改用户状态（封禁/解封）、改用户角色 */
  UserManage = 'user:manage',

  AdminView = 'admin:view',
  /** 增删改管理员账号、重置密码 */
  AdminManage = 'admin:manage',
  /** 调整角色 → 权限矩阵 */
  RoleManage = 'role:manage',

  ContentView = 'content:view',
  /** 审核认证申请、下架内容 */
  ContentReview = 'content:review',

  ToolView = 'tool:view',
  JobView = 'job:view',
  /** 重跑 / 取消作业、上下线工具 */
  JobManage = 'job:manage',

  OrderView = 'order:view',
  /** 放款 / 退款 / 争议裁决 —— 碰钱的动作用独立权限点，不与 OrderView 合并 */
  OrderSettle = 'order:settle',

  AuditView = 'audit:view',
}

/** 角色 → 权限矩阵（唯一事实来源，后端守卫与前端菜单都读它） */
export const ADMIN_ROLE_PERMISSIONS: Record<AdminRole, readonly AdminPermission[]> = {
  [AdminRole.SuperAdmin]: Object.values(AdminPermission),
  [AdminRole.Operator]: [
    AdminPermission.DashboardView,
    AdminPermission.UserView,
    AdminPermission.UserManage,
    AdminPermission.ContentView,
    AdminPermission.ContentReview,
    AdminPermission.ToolView,
    AdminPermission.JobView,
    AdminPermission.JobManage,
    AdminPermission.OrderView,
  ],
  [AdminRole.Auditor]: [
    AdminPermission.DashboardView,
    AdminPermission.UserView,
    AdminPermission.ContentView,
    AdminPermission.ContentReview,
    AdminPermission.AuditView,
  ],
  [AdminRole.Finance]: [
    AdminPermission.DashboardView,
    AdminPermission.UserView,
    AdminPermission.OrderView,
    AdminPermission.OrderSettle,
    AdminPermission.AuditView,
  ],
};

/** 权限点 → 分组（角色权限矩阵页按分组渲染，避免一长条平铺看不完） */
export const ADMIN_PERMISSION_GROUPS: readonly {
  key: string;
  label: string;
  permissions: readonly AdminPermission[];
}[] = [
  {
    key: 'overview',
    label: '概览',
    permissions: [AdminPermission.DashboardView, AdminPermission.AuditView],
  },
  {
    key: 'user',
    label: '用户',
    permissions: [AdminPermission.UserView, AdminPermission.UserManage],
  },
  {
    key: 'admin',
    label: '管理员与角色',
    permissions: [AdminPermission.AdminView, AdminPermission.AdminManage, AdminPermission.RoleManage],
  },
  {
    key: 'content',
    label: '内容审核',
    permissions: [AdminPermission.ContentView, AdminPermission.ContentReview],
  },
  {
    key: 'tool',
    label: '工具与作业',
    permissions: [AdminPermission.ToolView, AdminPermission.JobView, AdminPermission.JobManage],
  },
  {
    key: 'order',
    label: '订单与资金',
    permissions: [AdminPermission.OrderView, AdminPermission.OrderSettle],
  },
];

/** 权限点中文名（矩阵页与菜单文案；小程序不涉及，故不进 MP-VISUAL-SYSTEM） */
export const ADMIN_PERMISSION_LABELS: Record<AdminPermission, string> = {
  [AdminPermission.DashboardView]: '查看数据看板',
  [AdminPermission.UserView]: '查看用户',
  [AdminPermission.UserManage]: '管理用户（改状态/角色）',
  [AdminPermission.AdminView]: '查看管理员',
  [AdminPermission.AdminManage]: '管理管理员账号',
  [AdminPermission.RoleManage]: '调整角色权限',
  [AdminPermission.ContentView]: '查看待审内容',
  [AdminPermission.ContentReview]: '审核内容',
  [AdminPermission.ToolView]: '查看工具',
  [AdminPermission.JobView]: '查看作业',
  [AdminPermission.JobManage]: '管理作业（重跑/取消）',
  [AdminPermission.OrderView]: '查看订单',
  [AdminPermission.OrderSettle]: '订单资金裁决',
  [AdminPermission.AuditView]: '查看操作日志',
};

/** 角色中文名 */
export const ADMIN_ROLE_LABELS: Record<AdminRole, string> = {
  [AdminRole.SuperAdmin]: '超级管理员',
  [AdminRole.Operator]: '运营',
  [AdminRole.Auditor]: '审核员',
  [AdminRole.Finance]: '财务',
};

/** 角色说明（新建管理员时的选择提示） */
export const ADMIN_ROLE_DESCRIPTIONS: Record<AdminRole, string> = {
  [AdminRole.SuperAdmin]: '拥有全部权限，可管理其他管理员',
  [AdminRole.Operator]: '用户与内容治理、工具作业运维、订单查看',
  [AdminRole.Auditor]: '认证申请与内容审核',
  [AdminRole.Finance]: '订单资金裁决与对账',
};

export const ADMIN_ROLES: readonly AdminRole[] = Object.values(AdminRole);

/** 某个角色的权限点 */
export function permissionsOf(role: AdminRole): readonly AdminPermission[] {
  return ADMIN_ROLE_PERMISSIONS[role] ?? [];
}

/** 多角色合并权限（去重）。目前一人一角色，但契约上支持多角色，避免以后改接口。 */
export function permissionsOfRoles(roles: readonly AdminRole[]): AdminPermission[] {
  const out = new Set<AdminPermission>();
  for (const r of roles) for (const p of permissionsOf(r)) out.add(p);
  return [...out];
}

/** 是否拥有某权限点 */
export function hasAdminPermission(
  roles: readonly AdminRole[],
  permission: AdminPermission,
): boolean {
  return roles.some((r) => permissionsOf(r).includes(permission));
}

/** 运行时校验：从字符串（DB / 请求体）安全收窄为 AdminRole */
export function isAdminRole(v: unknown): v is AdminRole {
  return typeof v === 'string' && (ADMIN_ROLES as readonly string[]).includes(v);
}

/** 运行时校验：收窄为 AdminPermission */
export function isAdminPermission(v: unknown): v is AdminPermission {
  return typeof v === 'string' && (Object.values(AdminPermission) as string[]).includes(v);
}
