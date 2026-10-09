import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AdminPermission, AdminRole } from '@qz/core';

/**
 * 管理员请求上下文（由 `AdminPermissionGuard` 注入到 `req.admin`）
 *
 * 为什么不复用 `AuthUser`：`AuthUser` 描述的是**登录身份**（微信用户 + 全局角色），
 * 而这里描述的是**后台管理员**（后台子角色 + 展开后的权限点）。
 * 混在一起会让"这个人是学生还是管理员"和"这个管理员能做什么"两个问题纠缠不清。
 */
export interface AdminContext {
  /** `admin_account.id` */
  accountId: string;
  /** 对应的 `user.id`（审计日志的 actor_id 用它） */
  userId: string;
  username: string;
  displayName: string;
  adminRole: AdminRole;
  /** 该角色展开后的权限点（前端菜单也按同一份矩阵渲染） */
  permissions: AdminPermission[];
}

export const ADMIN_PERMISSIONS_KEY = 'adminPermissions';

/**
 * 声明接口所需的权限点。
 *
 * 语义是 **"任一满足"**（`some`），与 `JwtAuthGuard` 的 `@Roles(...)` 保持一致 ——
 * 两个装饰器在同一个项目里用相反的语义（一个 any 一个 all）迟早会写错，
 * 而"权限不够"的表现只是 403，排查时很难看出是语义理解错了。
 *
 * 需要"同时满足多个权限"的场景，请新起一个权限点（权限点本来就应该描述一件事）。
 */
export const RequirePermission = (...permissions: AdminPermission[]) =>
  SetMetadata(ADMIN_PERMISSIONS_KEY, permissions);

/** 取当前管理员（守卫已保证非空，故控制器里不必再判空） */
export const CurrentAdmin = createParamDecorator(
  (data: keyof AdminContext | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<Request & { admin?: AdminContext }>();
    return data ? req.admin?.[data] : req.admin;
  },
);
