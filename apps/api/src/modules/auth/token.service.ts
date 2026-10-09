import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Role } from '@qz/core';

import type { AppConfig } from '../../common/config/configuration';

export interface AccessPayload {
  sub: string;
  openid: string;
  roles: Role[];
  isAdmin: boolean;
}

export interface RefreshPayload {
  sub: string;
  type: 'refresh';
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** 秒 */
  expiresIn: number;
}

/**
 * JWT 签发与校验（任务清单 M0-16，文档 6.1.1）
 * access 2h + refresh 30d
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  private get cfg(): AppConfig['jwt'] {
    return this.config.get<AppConfig>('app')!.jwt;
  }

  async issue(user: {
    id: string;
    openid: string;
    roles: Role[];
    isAdmin: boolean;
  }): Promise<TokenPair> {
    const accessPayload: AccessPayload = {
      sub: user.id,
      openid: user.openid,
      roles: user.roles,
      isAdmin: user.isAdmin,
    };
    const refreshPayload: RefreshPayload = { sub: user.id, type: 'refresh' };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(accessPayload, {
        secret: this.cfg.secret,
        expiresIn: this.cfg.accessExpire,
      }),
      this.jwt.signAsync(refreshPayload, {
        secret: this.cfg.secret,
        expiresIn: this.cfg.refreshExpire,
      }),
    ]);

    return { accessToken, refreshToken, expiresIn: toSeconds(this.cfg.accessExpire) };
  }

  async verifyAccess(token: string): Promise<AccessPayload> {
    return this.jwt.verifyAsync<AccessPayload>(token, { secret: this.cfg.secret });
  }

  async verifyRefresh(token: string): Promise<RefreshPayload> {
    const payload = await this.jwt.verifyAsync<RefreshPayload>(token, { secret: this.cfg.secret });
    if (payload.type !== 'refresh') throw new Error('token 类型不正确');
    return payload;
  }
}

/** '2h' / '30d' / '900' → 秒 */
export function toSeconds(expr: string): number {
  const m = expr.match(/^(\d+)\s*([smhd])?$/);
  if (!m) return 7200;
  const n = Number(m[1]);
  switch (m[2]) {
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 3600;
    case 'd':
      return n * 86400;
    default:
      return n;
  }
}
