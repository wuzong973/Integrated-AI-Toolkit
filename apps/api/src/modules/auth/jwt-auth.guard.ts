import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { BizException, ErrorCode, Role } from '@qz/core';

import type { AuthUser } from '../../common/decorators';
import { PUBLIC_KEY, ROLES_KEY } from '../../common/decorators';

import { TokenService } from './token.service';

/**
 * 鉴权守卫（任务清单 M0-16，文档 6.1.2）
 * - 校验 Bearer token 并注入 req.user
 * - @Public() 标记的接口直接放行
 * - @Roles(...) 做 RBAC 功能权限校验
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const token = extractBearer(req);

    // 公开接口：有 token 也解析（便于埋点拿到 userId），无 token 直接放行
    if (isPublic && !token) return true;
    if (!token) throw new BizException(ErrorCode.Unauthorized);

    req.user = await this.parseUser(token);
    if (isPublic) return true;

    this.assertRoles(context, req.user);
    return true;
  }

  /** 解析并校验 access token → AuthUser */
  private async parseUser(token: string): Promise<AuthUser> {
    try {
      const payload = await this.tokens.verifyAccess(token);
      return {
        id: payload.sub,
        openid: payload.openid,
        roles: payload.roles ?? [],
        isAdmin: !!payload.isAdmin,
      };
    } catch (e) {
      const expired = (e as Error).name === 'TokenExpiredError';
      throw new BizException(expired ? ErrorCode.TokenExpired : ErrorCode.TokenInvalid);
    }
  }

  /** RBAC 功能权限校验（文档 6.1.2） */
  private assertRoles(context: ExecutionContext, user: AuthUser): void {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return;

    const ok = user.isAdmin || required.some((r) => user.roles.includes(r));
    if (!ok) throw new BizException(ErrorCode.NoPermission);
  }
}

function extractBearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const [scheme, token] = h.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}
