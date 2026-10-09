import { Injectable } from '@nestjs/common';
import {
  ADMIN_ROLE_LABELS,
  AdminRole,
  BizException,
  ErrorCode,
  Role,
  type AdminAccountCreateDto,
  type AdminAccountListQueryDto,
  type AdminAccountUpdateDto,
} from '@qz/core';
import type { Prisma } from '@prisma/client';

import { AppLogger } from '../../common/logger/logger.service';
import { PrismaService } from '../../infra/prisma/prisma.service';

import { ITEM_SELECT, permissionsOfRole, requireAdminRole, toAccountItem } from './admin-account.view';
import type { AdminAccountDetail, AdminAccountItem } from './admin-account.types';
import { AdminAuditService } from './admin-audit.service';
import { PasswordService } from './password.service';

export type { AdminAccountDetail, AdminAccountItem };

/**
 * 管理员账号管理（任务清单 M0-23）
 *
 * ## 三条不可绕过的业务规则
 *
 * ① **改不了自己**：不能给自己改角色（等于给自己提权）、也不能禁用/删除自己。
 *    "提权"这件事必须由另一个超管来做 —— 单点操作就能自我提权的话，
 *    权限体系在这一个入口上等于不存在。
 *
 * ② **不能删掉最后一个有效超管**：否则此后没人能进"管理员与权限"，
 *    系统永久失去管理能力（只能改库修）。
 *
 * ③ **删除是"摘掉后台身份"，不是删用户**：清掉 `admin_account` 行 +
 *    收回该 user 的 `admin` 角色，但保留 `User` 本身 —— 他可能还是个正常学生，
 *    而且 `audit_log` 与订单都要留得住这个人。
 */
@Injectable()
export class AdminAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: AdminAuditService,
    private readonly logger: AppLogger,
  ) {}

  async list(query: AdminAccountListQueryDto): Promise<{ list: AdminAccountItem[]; total: number }> {
    const where: Prisma.AdminAccountWhereInput = {
      ...(query.adminRole ? { adminRole: query.adminRole } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.keyword
        ? {
            OR: [
              { username: { contains: query.keyword } },
              { displayName: { contains: query.keyword } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.adminAccount.findMany({
        where,
        select: ITEM_SELECT,
        orderBy: [{ createdAt: 'asc' }],
        skip: (query.page - 1) * query.size,
        take: query.size,
      }),
      this.prisma.adminAccount.count({ where }),
    ]);

    return { list: rows.map(toAccountItem), total };
  }

  async detail(id: string): Promise<AdminAccountDetail> {
    const row = await this.prisma.adminAccount.findUnique({ where: { id }, select: ITEM_SELECT });
    if (!row) throw new BizException(ErrorCode.NotFound, undefined, '管理员不存在');

    const adminRole = requireAdminRole(row.adminRole);
    return { ...toAccountItem(row), permissions: permissionsOfRole(adminRole) };
  }

  /** 新建管理员：同时建 User（若无）+ 授予 admin 角色 + 写入凭证 */
  async create(
    dto: AdminAccountCreateDto,
    actor: { userId: string; accountId: string },
  ): Promise<AdminAccountDetail> {
    const dup = await this.prisma.adminAccount.findUnique({ where: { username: dto.username } });
    if (dup) {
      throw new BizException(
        ErrorCode.DuplicateOperation,
        { username: dto.username },
        `用户名「${dto.username}」已被占用`,
      );
    }

    /*
     * 复用"前管理员"遗留的 User。
     *
     * `remove()` 按设计只删 `admin_account` 与全局 admin 角色，**保留 User 本体**
     * （他仍是普通学生）。于是"先删号、过后再加回来"是运营的正常动作 —— 但
     * `User.openid` 上有唯一键（`admin:<username>`），直接 `create` 会撞唯一约束，
     * 被全局异常过滤器兜成 `50001 服务器内部错误`：
     * 界面上只看到"内部错误"，而管理员列表里偏偏查不到这个名字，排查方向会被彻底带偏。
     *
     * 所以这里显式复用遗留 User（而不是报"用户名已被占用"—— 那是假话，
     * 管理员列表里确实没有），让"删了还能再加回来"成立。
     */
    const legacyUser = await this.prisma.user.findUnique({
      where: { openid: `admin:${dto.username}` },
    });
    if (legacyUser) {
      const bound = await this.prisma.adminAccount.findUnique({
        where: { userId: legacyUser.id },
        select: { username: true },
      });
      if (bound) {
        throw new BizException(
          ErrorCode.DuplicateOperation,
          { username: dto.username },
          `该用户已绑定后台账号「${bound.username}」`,
        );
      }
    }

    const passwordHash = await this.passwords.hash(dto.password);

    const created = await this.prisma.$transaction(async (tx) => {
      // 后台账号必须绑定到一个 User：审计、订单、作业的责任人都指向 User，
      // 另起一套身份会让"操作人是谁"分裂成两套口径。
      const user =
        legacyUser ??
        (await tx.user.create({
          data: {
            // 后台账号没有微信身份，用确定性占位 openid（前缀 `admin:` 便于识别与排查）
            openid: `admin:${dto.username}`,
            nickname: dto.displayName,
            status: 'active',
          },
        }));

      // 复用路径下角色一定已被 `remove()` 摘掉，这里补回来；
      // profile / wallet 从未被删，重建会撞主键，所以只在新 User 时创建。
      await tx.userRole.upsert({
        where: { userId_role: { userId: user.id, role: Role.Admin } },
        update: { scope: 'global', status: 'active' },
        create: { userId: user.id, role: Role.Admin, scope: 'global' },
      });
      if (!legacyUser) {
        await tx.userProfile.create({ data: { userId: user.id, creditScore: 80 } });
        await tx.wallet.create({ data: { userId: user.id } });
      }

      const account = await tx.adminAccount.create({
        data: {
          userId: user.id,
          username: dto.username,
          passwordHash,
          displayName: dto.displayName,
          adminRole: dto.adminRole,
          status: 'active',
          createdBy: actor.userId,
        },
        select: ITEM_SELECT,
      });

      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'admin.account.create',
          targetType: 'admin_account',
          targetId: account.id,
          after: { username: dto.username, adminRole: dto.adminRole, displayName: dto.displayName },
        },
        tx,
      );

      return account;
    });

    this.logger.log(
      `新建管理员 ${dto.username}（${ADMIN_ROLE_LABELS[dto.adminRole]}）by=${actor.userId}`,
      'AdminAccount',
    );
    if (legacyUser) {
      // 特殊路径必须留痕：否则以后看到"这个 User 的创建时间比账号早很多"会当成脏数据
      this.logger.warn(
        `复用已存在的用户 ${legacyUser.id} 重建后台账号 ${dto.username}（此前账号被删除，User 本体按设计保留）`,
        'AdminAccount',
      );
    }

    return { ...toAccountItem(created), permissions: permissionsOfRole(dto.adminRole) };
  }

  /** 编辑管理员（显示名 / 角色 / 状态） */
  async update(
    id: string,
    dto: AdminAccountUpdateDto,
    actor: { userId: string; accountId: string },
  ): Promise<AdminAccountDetail> {
    const row = await this.prisma.adminAccount.findUnique({ where: { id }, select: ITEM_SELECT });
    if (!row) throw new BizException(ErrorCode.NotFound, undefined, '管理员不存在');

    // 规则 ①：改不了自己
    if (id === actor.accountId) {
      throw new BizException(
        ErrorCode.ParamInvalid,
        undefined,
        '不能修改自己的角色或状态，请让另一位超级管理员操作',
      );
    }

    const nextRole = dto.adminRole ?? requireAdminRole(row.adminRole);
    const nextStatus = dto.status ?? row.status;

    // 规则 ②：不能把最后一个有效超管降权或禁用
    await this.assertNotLastSuperAdmin(id, row.adminRole, row.status, nextRole, nextStatus);

    const updated = await this.prisma.$transaction(async (tx) => {
      const account = await tx.adminAccount.update({
        where: { id },
        data: {
          ...(dto.displayName ? { displayName: dto.displayName } : {}),
          ...(dto.adminRole ? { adminRole: dto.adminRole } : {}),
          ...(dto.status ? { status: dto.status } : {}),
        },
        select: ITEM_SELECT,
      });

      // 角色同步到全局 UserRole：`@Roles(Role.Admin)` 认的是它。
      // 禁用时保留 admin 角色（否则重新启用要再补一次），但此时权限守卫
      // 已经因 status != active 而拒绝 —— 该角色不再产生任何能力。
      if (dto.adminRole) {
        await tx.userRole.upsert({
          where: { userId_role: { userId: row.userId, role: Role.Admin } },
          create: { userId: row.userId, role: Role.Admin, scope: 'global' },
          update: { status: 'active' },
        });
      }

      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'admin.account.update',
          targetType: 'admin_account',
          targetId: id,
          before: { adminRole: row.adminRole, status: row.status, displayName: row.displayName },
          after: { adminRole: nextRole, status: nextStatus, displayName: account.displayName },
        },
        tx,
      );

      return account;
    });

    return { ...toAccountItem(updated), permissions: permissionsOfRole(nextRole) };
  }

  /**
   * 删除管理员（摘掉后台身份）。
   *
   * 规则 ③：只删 `admin_account` 行 + 收回 `admin` 角色，**保留 User** ——
   * 他可能还是正常学生，而且历史审计与订单要留得住这个人。
   */
  async remove(id: string, actor: { userId: string; accountId: string }): Promise<{ ok: true }> {
    const row = await this.prisma.adminAccount.findUnique({ where: { id }, select: ITEM_SELECT });
    if (!row) throw new BizException(ErrorCode.NotFound, undefined, '管理员不存在');

    if (id === actor.accountId) {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '不能删除自己');
    }
    await this.assertNotLastSuperAdmin(id, row.adminRole, row.status, null, 'deleted');

    await this.prisma.$transaction(async (tx) => {
      await tx.adminAccount.delete({ where: { id } });
      // 收回后台身份对应的全局角色，否则 `@Roles(Role.Admin)` 仍会放行
      await tx.userRole.deleteMany({ where: { userId: row.userId, role: Role.Admin } });

      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'admin.account.delete',
          targetType: 'admin_account',
          targetId: id,
          before: { username: row.username, adminRole: row.adminRole },
        },
        tx,
      );
    });

    this.logger.warn(`删除管理员 ${row.username} by=${actor.userId}`, 'AdminAccount');
    return { ok: true };
  }

  /** 重置他人密码（超管专用） */
  async resetPassword(
    id: string,
    newPassword: string,
    actor: { userId: string; accountId: string },
  ): Promise<{ ok: true }> {
    const row = await this.prisma.adminAccount.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw new BizException(ErrorCode.NotFound, undefined, '管理员不存在');

    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.adminAccount.update({ where: { id }, data: { passwordHash } });
      // 只记"重置了谁的密码"，**绝不把新密码或哈希写进审计日志**
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'admin.account.reset_password',
          targetType: 'admin_account',
          targetId: id,
        },
        tx,
      );
    });

    this.logger.warn(`重置管理员密码 target=${id} by=${actor.userId}`, 'AdminAccount');
    return { ok: true };
  }

  /** 修改自己的密码（需验旧密码） */
  async changeOwnPassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<{ ok: true }> {
    const row = await this.prisma.adminAccount.findUnique({ where: { userId } });
    if (!row) throw new BizException(ErrorCode.NoPermission, undefined, '当前账号不是后台管理员');

    if (!(await this.passwords.verify(oldPassword, row.passwordHash))) {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '当前密码不正确');
    }

    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.adminAccount.update({ where: { id: row.id }, data: { passwordHash } });
      await this.audit.record(
        { actorId: userId, action: 'admin.password.change', targetType: 'admin_account', targetId: row.id },
        tx,
      );
    });
    return { ok: true };
  }

  /**
   * 保证变更后仍至少存在一个"有效的超级管理员"。
   *
   * `nextRole`/`nextStatus` 为 null 表示"这一行即将消失"（删除）。
   * 判据用**变更后**的状态去数，而不是"变更前有几个"——
   * 后者会在"两个超管互相降权"的并发下双双向通过。
   */
  private async assertNotLastSuperAdmin(
    id: string,
    currentRole: string,
    currentStatus: string,
    nextRole: string | null,
    nextStatus: string,
  ): Promise<void> {
    const losingSuper =
      currentRole === AdminRole.SuperAdmin &&
      currentStatus === 'active' &&
      !(nextRole === AdminRole.SuperAdmin && nextStatus === 'active');
    if (!losingSuper) return;

    const remaining = await this.prisma.adminAccount.count({
      where: { adminRole: AdminRole.SuperAdmin, status: 'active', id: { not: id } },
    });
    if (remaining === 0) {
      throw new BizException(
        ErrorCode.ParamInvalid,
        undefined,
        '这是最后一个可用的超级管理员，降权或删除后将无人能管理权限',
      );
    }
  }
}
