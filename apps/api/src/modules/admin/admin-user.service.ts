import { Injectable } from '@nestjs/common';
import {
  BizException,
  ErrorCode,
  Role,
  type AdminUserListQueryDto,
  type AdminUserUpdateDto,
} from '@qz/core';
import type { Prisma } from '@prisma/client';

import { AppLogger } from '../../common/logger/logger.service';
import { PrismaService } from '../../infra/prisma/prisma.service';

import { AdminAuditService } from './admin-audit.service';

/** 用户列表行 */
export interface AdminUserItem {
  id: string;
  nickname: string | null;
  avatar: string | null;
  phone: string | null;
  status: string;
  roles: string[];
  creditScore: number;
  points: number;
  balance: number;
  lastLogin: string | null;
  createdAt: string;
}

export interface AdminUserDetail extends AdminUserItem {
  college: string | null;
  grade: string | null;
  realName: string | null;
  /** 已通过的认证类型 */
  verified: string[];
  /** 待审的认证申请数（顺带让详情页能作为"这个人卡在审核"的线索） */
  pendingVerifications: number;
  orderCount: number;
  jobCount: number;
  /** 后台是否也拥有管理员身份（能直接跳转到管理员详情） */
  adminAccountId: string | null;
}

const USER_SELECT = {
  id: true,
  nickname: true,
  avatar: true,
  phone: true,
  college: true,
  grade: true,
  realName: true,
  status: true,
  lastLogin: true,
  createdAt: true,
  roles: { select: { role: true, status: true } },
  profile: { select: { creditScore: true, points: true } },
  wallet: { select: { points: true, balance: true } },
  verifications: { select: { type: true, status: true } },
  adminAccount: { select: { id: true } },
} as const;

type Row = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

/** 合法的用户状态。库里是无约束 VarChar，取值只在这里收口。 */
const USER_STATUSES = ['active', 'banned', 'disabled'] as const;

/**
 * 用户管理（任务清单 M0-23）
 *
 * ## 这个模块最重要的作用：让"封号"真的生效
 *
 * 动手前查过一遍 —— `user.status` 这一列**全项目没有任何一处读取**。
 * 也就是说，在此之前的"封禁"只会改一个没人看的字段：用户照常登录、照常下单。
 * 这比"功能没做"更糟，因为它看起来做了（界面上有按钮、库里也有值）。
 *
 * 本模块的 `update()` 写状态，配套的拦截在 `AuthService.login` / `refresh`
 * （见那里的注释：登录与刷新直接被拒）。**已经签发的 accessToken 在过期前仍然有效**
 * （默认 2 小时）—— 要让它立刻失效，需要每次请求回查用户状态或引入吊销名单，
 * 那是一条独立的性能取舍，不在本轮假装做到。
 *
 * ## 为什么封禁与禁用分成两个状态
 *
 *   banned    —— 内容违规封禁（用户可见的惩罚，客服会解释）
 *   disabled  —— 账号停用（注销中 / 风控冻结，通常不对外解释）
 *
 * 两者当前行为一致（都不允许登录），分开是为了**统计与申诉**时能区分原因。
 */
@Injectable()
export class AdminUserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly logger: AppLogger,
  ) {}

  async list(query: AdminUserListQueryDto): Promise<{ list: AdminUserItem[]; total: number }> {
    const where: Prisma.UserWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.role ? { roles: { some: { role: query.role, status: 'active' } } } : {}),
      ...(query.keyword
        ? {
            OR: [
              { nickname: { contains: query.keyword } },
              { phone: { contains: query.keyword } },
              { realName: { contains: query.keyword } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: USER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.size,
        take: query.size,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { list: rows.map(toItem), total };
  }

  async detail(id: string): Promise<AdminUserDetail> {
    const row = await this.prisma.user.findUnique({ where: { id }, select: USER_SELECT });
    if (!row) throw new BizException(ErrorCode.NotFound, undefined, '用户不存在');

    const [orderCount, jobCount] = await this.prisma.$transaction([
      this.prisma.order.count({ where: { OR: [{ buyerId: id }, { providerId: id }] } }),
      this.prisma.toolJob.count({ where: { userId: id } }),
    ]);

    return {
      ...toItem(row),
      college: row.college,
      grade: row.grade,
      realName: row.realName,
      verified: row.verifications.filter((v) => v.status === 'approved').map((v) => v.type),
      pendingVerifications: row.verifications.filter((v) => v.status === 'pending').length,
      orderCount,
      jobCount,
      adminAccountId: row.adminAccount?.id ?? null,
    };
  }

  /**
   * 改状态 / 改角色。
   *
   * `roles` 是**全量覆盖**：增量语义在并发下会丢更新（两次"加个角色"可能只生效一个），
   * 全量覆盖天然幂等 —— 请求里写了什么，结果就是什么。
   */
  async update(
    id: string,
    dto: AdminUserUpdateDto,
    actor: { userId: string },
  ): Promise<AdminUserDetail> {
    const row = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, status: true, roles: { select: { role: true } } },
    });
    if (!row) throw new BizException(ErrorCode.NotFound, undefined, '用户不存在');

    // 不能封自己：一旦生效，操作者立刻失去登录能力，连"改回来"都做不到
    if (id === actor.userId && dto.status && dto.status !== 'active') {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '不能封禁或停用自己');
    }

    const nextStatus = dto.status ?? row.status;
    const nextRoles = dto.roles ? dedupeRoles(dto.roles) : null;

    await this.prisma.$transaction(async (tx) => {
      if (dto.status) {
        await tx.user.update({ where: { id }, data: { status: dto.status } });
      }

      if (nextRoles) {
        // 先删后建：全量覆盖。注意 `admin` 角色不由这里授予 ——
        // 后台身份的唯一凭据是 `admin_account` 行，见 AdminPermissionGuard。
        await tx.userRole.deleteMany({ where: { userId: id } });
        if (nextRoles.length) {
          await tx.userRole.createMany({
            data: nextRoles.map((role) => ({ userId: id, role, scope: 'self' })),
          });
        }
      }

      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'user.update',
          targetType: 'user',
          targetId: id,
          before: { status: row.status, roles: row.roles.map((r) => r.role) },
          after: { status: nextStatus, roles: nextRoles ?? row.roles.map((r) => r.role) },
          // 封禁必须留得下"为什么" —— 申诉与复盘都靠它
          reason: dto.reason,
        },
        tx,
      );
    });

    if (dto.status && dto.status !== row.status) {
      this.logger.warn(
        `用户状态变更 ${id}: ${row.status} → ${dto.status} by=${actor.userId}`,
        'AdminUser',
      );
    }

    return this.detail(id);
  }
}

/** 去重 + 过滤非法角色值（库层无约束，必须在写入口守住） */
function dedupeRoles(roles: readonly string[]): string[] {
  const valid = new Set<string>(Object.values(Role));
  return [...new Set(roles)].filter((r) => valid.has(r));
}

function toItem(row: Row): AdminUserItem {
  return {
    id: row.id,
    nickname: row.nickname,
    avatar: row.avatar,
    phone: row.phone,
    status: (USER_STATUSES as readonly string[]).includes(row.status) ? row.status : 'active',
    roles: row.roles.filter((r) => r.status === 'active').map((r) => r.role),
    creditScore: row.profile?.creditScore ?? 80,
    // 积分以 wallet 为准（BillingService 的唯一作用点就是它），profile.points 是历史遗留
    points: row.wallet?.points ?? row.profile?.points ?? 0,
    balance: row.wallet?.balance ?? 0,
    lastLogin: row.lastLogin ? row.lastLogin.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
