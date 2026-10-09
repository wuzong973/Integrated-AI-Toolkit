import { Injectable } from '@nestjs/common';
import {
  ADMIN_ROLE_LABELS,
  AdminRole,
  BizException,
  ErrorCode,
  Role,
  isAdminRole,
  permissionsOfRoles,
  type AdminPermission,
} from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { TokenService } from '../auth/token.service';

import { AdminAuditService } from './admin-audit.service';
import { PasswordService } from './password.service';

/** 后台管理员资料（登录与 `me` 共用；**永不含 passwordHash**） */
export interface AdminProfile {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  adminRole: AdminRole;
  adminRoleLabel: string;
  permissions: AdminPermission[];
  status: string;
  lastLoginAt: string | null;
}

export interface AdminLoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  admin: AdminProfile;
}

export interface LoginMeta {
  ip?: string;
  traceId?: string;
}

/** 管理员行（只取需要的列，避免 `passwordHash` 意外流出） */
const ACCOUNT_WITH_USER = {
  user: { select: { openid: true, roles: { where: { status: 'active' }, select: { role: true } } } },
} as const;

/**
 * 后台登录（任务清单 M0-23）
 *
 * ## 为什么另起一套登录，而不是复用微信 `code2Session`
 *
 * 微信开放平台的「网站应用」扫码登录需要企业资质，本机与首版都跑不通；
 * 而后台是 PC 场景，账号密码本来就是标准形态。签发复用 `TokenService.issue`，
 * 因此 `JwtAuthGuard` / `@Roles(Role.Admin)` / 401 自动刷新链路全部直接沿用。
 *
 * ## 两个必须守住的安全细节
 *
 * ① **不区分"用户名不存在"与"密码错误"**：两者返回同一句话、同一个错误码。
 *    区分开来等于白送攻击者一个枚举有效用户名的接口。
 *
 * ② ①还不够 —— 用户不存在时若直接返回，**响应时间会明显更短**（跳过了
 *    scrypt 的几十毫秒），时间差同样能枚举用户名。所以对"用户不存在"也跑一次
 *    哈希校验（对一个固定的假哈希），让两条路径耗时接近（见 `DUMMY_HASH`）。
 *
 * ## 收回权限立刻生效
 *
 * 登录只负责发 token，但**每次请求** `AdminPermissionGuard` 都会回查
 * `admin_account` 的 `status` 与 `admin_role`。所以"禁用某人"或"降权"不必等
 * token 过期 —— 这也是没有把 `admin_role` 放进 JWT 的原因。
 */
@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AdminAuditService,
    private readonly logger: AppLogger,
  ) {}

  async login(username: string, password: string, meta: LoginMeta): Promise<AdminLoginResult> {
    const account = await this.prisma.adminAccount.findUnique({
      where: { username },
      include: ACCOUNT_WITH_USER,
    });

    if (!account) {
      await this.burnTime(password);
      throw invalidCredentials();
    }
    if (!(await this.passwords.verify(password, account.passwordHash))) {
      this.logger.warn(
        `后台登录失败（密码错误）username=${username} ip=${meta.ip ?? '-'}`,
        'AdminAuth',
      );
      throw invalidCredentials();
    }
    // 密码对了但账号被禁用：这条可以明说，否则管理员只会以为"密码又错了"而反复重试
    if (account.status !== 'active') {
      throw new BizException(ErrorCode.AccountFrozen, undefined, '该管理员账号已被禁用');
    }
    const adminRole = requireRole(account.adminRole);

    const pair = await this.tokens.issue({
      id: account.userId,
      openid: account.user.openid,
      // 用**当前**角色而非 token 里的旧值：降权后重新登录应立刻生效
      roles: [...new Set<Role>([Role.Admin, ...account.user.roles.map((r) => r.role as Role)])],
      isAdmin: true,
    });

    // 两个时间戳都更新：user.last_login 供用户管理页显示"最近活跃"，admin 的供后台自己用
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: account.userId }, data: { lastLogin: now } }),
      this.prisma.adminAccount.update({ where: { id: account.id }, data: { lastLoginAt: now } }),
    ]);

    await this.audit.record({
      actorId: account.userId,
      action: 'admin.login',
      targetType: 'admin_account',
      targetId: account.id,
      ip: meta.ip,
      traceId: meta.traceId,
    });

    return { ...pair, admin: toProfile(account, adminRole) };
  }

  /** 当前管理员资料（`GET /admin/auth/me`，前端刷新页面后恢复菜单用） */
  async profile(userId: string): Promise<AdminProfile> {
    const account = await this.prisma.adminAccount.findUnique({ where: { userId } });
    if (!account) throw new BizException(ErrorCode.NoPermission, undefined, '当前账号不是后台管理员');
    return toProfile(account, requireRole(account.adminRole));
  }

  /**
   * 消耗与真实校验相当的时间（见类注释 ②）。
   *
   * `DUMMY_HASH` 是合法格式的假哈希，对任意输入都必定不匹配，
   * 但会完整跑一遍 scrypt。它只用来抹平时间差，不参与任何鉴权判断。
   */
  private async burnTime(password: string): Promise<void> {
    await this.passwords.verify(password, DUMMY_HASH);
  }
}

/** 固定的假哈希（盐与摘要都是常量，格式与 `PasswordService.hash` 一致） */
const DUMMY_HASH = [
  'scrypt',
  16384,
  8,
  1,
  Buffer.alloc(16).toString('base64'),
  Buffer.alloc(64).toString('base64'),
].join('$');

function invalidCredentials(): BizException {
  return new BizException(ErrorCode.Unauthorized, undefined, '用户名或密码错误');
}

/** 角色收窄失败 → 拒绝（不退回默认角色，那可能是"数据脏了反而权限变大"） */
function requireRole(raw: string): AdminRole {
  if (!isAdminRole(raw)) {
    throw new BizException(
      ErrorCode.NoPermission,
      { adminRole: raw },
      '管理员角色配置有误，请联系超级管理员',
    );
  }
  return raw;
}

/** 实体 → 对外资料（顺带展开 `permissions`，前端菜单直接用） */
export function toProfile(
  account: {
    id: string;
    userId: string;
    username: string;
    displayName: string;
    status: string;
    lastLoginAt: Date | null;
  },
  adminRole: AdminRole,
): AdminProfile {
  return {
    id: account.id,
    userId: account.userId,
    username: account.username,
    displayName: account.displayName,
    adminRole,
    adminRoleLabel: ADMIN_ROLE_LABELS[adminRole],
    permissions: permissionsOfRoles([adminRole]),
    status: account.status,
    lastLoginAt: account.lastLoginAt ? account.lastLoginAt.toISOString() : null,
  };
}
