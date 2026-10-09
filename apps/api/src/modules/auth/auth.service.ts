import { Injectable } from '@nestjs/common';
import { BizException, ErrorCode, Role } from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import { PrismaService } from '../../infra/prisma/prisma.service';

import { TokenService, type TokenPair } from './token.service';
import { WechatService } from './wechat.service';

/** 登录结果：token + 用户态（前端一次拿到全部初始化信息） */
export interface LoginResult extends TokenPair {
  user: MeResult;
  /** 是否是本次新建的账号 */
  isNewUser: boolean;
}

export interface MeResult {
  id: string;
  openid: string;
  nickname: string | null;
  avatar: string | null;
  phone: string | null;
  college: string | null;
  grade: string | null;
  /** null = 从没填过；'unspecified' = 用户主动选了"不想说"。界面提示要区分 */
  gender: string | null;
  roles: Role[];
  isAdmin: boolean;
  /** 是否已完成学生认证 */
  isStudentVerified: boolean;
  /** 是否已认证服务者 */
  isProvider: boolean;
  creditScore: number;
  points: number;
  balance: number;
  completedOrders: number;
}

/**
 * 认证服务（任务清单 M0-16）
 * 纪律：重复登录不得产生重复用户（靠 openid 唯一约束 + upsert）。
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wechat: WechatService,
    private readonly tokens: TokenService,
    private readonly logger: AppLogger,
  ) {}

  /** 微信登录：code → openid → 建/查用户 → 签发 token */
  async login(code: string): Promise<LoginResult> {
    const identity = await this.wechat.code2Session(code);

    const existing = await this.prisma.user.findUnique({ where: { openid: identity.openid } });

    // 封禁 / 停用的账号不允许再登录。
    //
    // ⚠️ 这一列此前**全项目没有任何一处读取** —— 也就是说后台的"封号"只改了个
    // 没人看的字段：用户照常登录、照常下单，而界面上按钮和库里的值都像是生效了。
    // 这比"没做这个功能"更糟，因为它看起来做了。
    //
    // 覆盖范围说明：这里只拦住**新登录**。已经签发出去的 accessToken 在过期前
    // （默认 2 小时）仍然可用；`refresh` 那条路径由 `buildMe` 一并拦住，
    // 所以最长 2 小时后必然失效。要做到"立刻踢下线"需要每次请求回查用户状态
    // 或引入吊销名单 —— 那是一条独立的性能取舍，不在这里假装做到。
    if (existing && existing.status !== 'active') {
      throw new BizException(
        ErrorCode.AccountFrozen,
        { status: existing.status },
        '账号已被停用，如有疑问请联系客服',
      );
    }

    const user = existing
      ? await this.prisma.user.update({
          where: { id: existing.id },
          data: {
            lastLogin: new Date(),
            ...(identity.unionid && !existing.unionid ? { unionid: identity.unionid } : {}),
          },
        })
      : await this.createUser(identity.openid, identity.unionid);

    const me = await this.buildMe(user.id);
    const pair = await this.tokens.issue({
      id: user.id,
      openid: user.openid,
      roles: me.roles,
      isAdmin: me.isAdmin,
    });

    this.logger.log(`用户登录成功 userId=${user.id} 新用户=${!existing}`, 'Auth');

    return { ...pair, user: me, isNewUser: !existing };
  }

  /** 新建用户：同时创建角色、画像、钱包（保证后续业务不空指针） */
  private async createUser(openid: string, unionid?: string) {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          openid,
          unionid: unionid ?? null,
          nickname: `青智同学${openid.slice(-4)}`,
          status: 'active',
          /*
           * 首次登录同样是"一次登录"，必须记下来。
           *
           * 原先只有 `login()` 的"老用户"分支写 `lastLogin`，新注册用户走这里就不写 ——
           * 后果是后台用户列表的「最后登录」对新用户显示为空，而**新用户恰恰是运营
           * 最常点开看的那一类**；一个注册后再没登录过的账号会永远显示空，
           * 看起来像"这个用户从没登录过"，而事实正好相反。
           */
          lastLogin: new Date(),
        },
      });

      await tx.userRole.create({ data: { userId: user.id, role: Role.Student, scope: 'self' } });
      await tx.userProfile.create({ data: { userId: user.id, creditScore: 80, points: 20 } });
      await tx.wallet.create({ data: { userId: user.id, points: 20 } });

      return user;
    });
  }

  /** 刷新 token */
  async refresh(refreshToken: string): Promise<LoginResult> {
    let payload;
    try {
      payload = await this.tokens.verifyRefresh(refreshToken);
    } catch {
      throw new BizException(ErrorCode.TokenExpired);
    }

    const me = await this.buildMe(payload.sub);
    const pair = await this.tokens.issue({
      id: payload.sub,
      openid: me.openid,
      roles: me.roles,
      isAdmin: me.isAdmin,
    });

    return { ...pair, user: me, isNewUser: false };
  }

  /** 组装当前用户态 */
  async buildMe(userId: string): Promise<MeResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        roles: true,
        profile: true,
        wallet: true,
        verifications: { where: { status: 'approved' } },
      },
    });

    if (!user) throw new BizException(ErrorCode.NotFound, undefined, '用户不存在');

    // 停用 / 封禁的账号在这里拦住：`buildMe` 同时服务于 `refresh` 与 `GET /auth/me`，
    // 所以封号后最迟在 accessToken 过期（默认 2h）时被彻底挡下。
    if (user.status !== 'active') {
      throw new BizException(
        ErrorCode.AccountFrozen,
        { status: user.status },
        '账号已被停用，如有疑问请联系客服',
      );
    }

    const roles = user.roles.filter((r) => r.status === 'active').map((r) => r.role as Role);

    return {
      id: user.id,
      openid: user.openid,
      nickname: user.nickname,
      avatar: user.avatar,
      phone: user.phone,
      college: user.college,
      grade: user.grade,
      gender: user.gender,
      roles,
      isAdmin: roles.includes(Role.Admin),
      isStudentVerified: user.verifications.some((v) => v.type === 'student'),
      isProvider: roles.includes(Role.Provider),
      creditScore: user.profile?.creditScore ?? 80,
      points: user.wallet?.points ?? 0,
      balance: user.wallet?.balance ?? 0,
      completedOrders: user.profile?.completedOrders ?? 0,
    };
  }
}
