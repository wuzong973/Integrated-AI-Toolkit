import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Role } from '@qz/core';

/** 当前登录用户 */
export interface AuthUser {
  id: string;
  openid: string;
  roles: Role[];
  isAdmin: boolean;
}

/** 从请求上下文取当前用户 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    return data ? req.user?.[data] : req.user;
  },
);

/** 标记接口无需登录 */
export const PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** 角色要求（RBAC，文档 6.1.2） */
export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** 幂等键（文档 9.4：所有写接口强制幂等） */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const req = ctx.switchToHttp().getRequest<Request>();
    return (req.headers['idempotency-key'] as string) || undefined;
  },
);
