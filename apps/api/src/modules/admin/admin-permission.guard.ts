import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  BizException,
  ErrorCode,
  hasAdminPermission,
  isAdminRole,
  permissionsOfRoles,
  type AdminPermission,
} from '@qz/core';

import type { AuthUser } from '../../common/decorators';
import { PUBLIC_KEY } from '../../common/decorators';
import { PrismaService } from '../../infra/prisma/prisma.service';

import { ADMIN_PERMISSIONS_KEY, type AdminContext } from './admin.decorators';

/**
 * 后台权限守卫（任务清单 M0-23）
 *
 * ## 用法
 *
 * ```ts
 * @UseGuards(JwtAuthGuard, AdminPermissionGuard)   // 顺序不能反
 * @RequirePermission(AdminPermission.OrderSettle)
 * ```
 *
 * `JwtAuthGuard` 在前，负责"你是谁"（校验 token、注入 `req.user`）；
 * 本守卫在后，负责"你能不能"。反过来的话 `req.user` 还是空的，会一律 401。
 *
 * ## 为什么每次请求都要回查 `admin_account`
 *
 * 管理员的**后台角色**（`AdminRole`）不在 JWT 里 —— JWT 只带全局 `roles` 与 `isAdmin`。
 * 把子角色塞进 token 会带来一个更糟的问题：超管把某人从"财务"降成"审核员"后，
 * 对方手里的 token 仍然带着旧角色，**在过期前一直是降权前的权限**。
 * 对一个能放款、能封号的系统来说，这个窗口不可接受，所以每次回查。
 *
 * 代价是每次后台请求多一次主键查询。后台流量是人工操作量级（每分钟个位数），
 * 用一次索引查询换取"收回权限立刻生效"，这个交换是划算的。
 *
 * ## 收窄失败时不放大权限
 *
 * `admin_role` 列是无约束 VarChar。若库里存了本代码不认识的值（改名 / 手改数据 / 回滚），
 * `isAdminRole` 会返回 false，此时**直接拒绝**而不是退回某个默认角色 ——
 * 退默认值的写法一旦默认成 `super_admin`，就是"数据脏了反而权限变大"。
 */
@Injectable()
export class AdminPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // `@Public()` 必须放行，否则**登录接口本身**会被本守卫拦成 403 ——
    // 登录时本来就没有身份，要求"先证明你是管理员再允许你登录"是死循环。
    // 之所以做成显式放行而不是"没有 req.user 就跳过"：后者会让任何
    // 忘记挂 JwtAuthGuard 的接口**静默变成匿名可访问**，是更难发现的漏洞。
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser; admin?: AdminContext }>();

    const user = req.user;
    if (!user) throw new BizException(ErrorCode.Unauthorized);

    const account = await this.prisma.adminAccount.findUnique({ where: { userId: user.id } });
    if (!account) {
      throw new BizException(ErrorCode.NoPermission, undefined, '当前账号不是后台管理员');
    }
    if (account.status !== 'active') {
      throw new BizException(ErrorCode.AccountFrozen, undefined, '管理员账号已被禁用');
    }
    if (!isAdminRole(account.adminRole)) {
      throw new BizException(
        ErrorCode.NoPermission,
        { adminRole: account.adminRole },
        '管理员角色无效，请联系超级管理员',
      );
    }

    const adminRole = account.adminRole;
    this.assertPermissions(context, adminRole);

    req.admin = {
      accountId: account.id,
      userId: user.id,
      username: account.username,
      displayName: account.displayName,
      adminRole,
      permissions: permissionsOfRoles([adminRole]),
    };
    return true;
  }

  /** 校验接口声明的权限点（任一满足即可，与 @Roles 语义一致） */
  private assertPermissions(context: ExecutionContext, adminRole: AdminContext['adminRole']): void {
    const required = this.reflector.getAllAndOverride<AdminPermission[]>(ADMIN_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return;

    const ok = required.some((p) => hasAdminPermission([adminRole], p));
    if (!ok) {
      throw new BizException(
        ErrorCode.NoPermission,
        { required: required.join(','), adminRole },
        '当前角色没有该操作的权限',
      );
    }
  }
}
