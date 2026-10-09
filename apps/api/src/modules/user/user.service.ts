import { Injectable } from '@nestjs/common';
import {
  BizException,
  ErrorCode,
  Role,
  asStringArray,
  maskPhone,
  type UpdateProfileDto,
} from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';
import type { MeResult } from '../auth/auth.service';
import { AuthService } from '../auth/auth.service';
import { ModerationService } from '../moderation/moderation.service';

/** 对外返回的用户详情（手机号脱敏） */
export interface UserDetail extends Omit<MeResult, 'openid' | 'isAdmin'> {
  bio: string | null;
  skills: string[];
  tags: string[];
  maskedPhone: string | null;
}

/**
 * 用户服务（任务清单 M0-20）
 * 纪律：对外输出必须脱敏（文档 6.7.4 / 6.12.3）
 */
@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly moderation: ModerationService,
  ) {}

  /** 我的资料 */
  async getMe(userId: string): Promise<UserDetail> {
    const me = await this.auth.buildMe(userId);
    const profile = await this.prisma.userProfile.findUnique({ where: { userId } });

    return {
      id: me.id,
      nickname: me.nickname,
      avatar: me.avatar,
      phone: me.phone,
      college: me.college,
      grade: me.grade,
      gender: me.gender,
      roles: me.roles,
      isStudentVerified: me.isStudentVerified,
      isProvider: me.isProvider,
      creditScore: me.creditScore,
      points: me.points,
      balance: me.balance,
      completedOrders: me.completedOrders,
      bio: profile?.bio ?? null,
      // MySQL 无标量数组，skills/tags 落为 Json 列，读出来必须显式收窄
      skills: asStringArray(profile?.skills),
      tags: asStringArray(profile?.tags),
      maskedPhone: me.phone ? maskPhone(me.phone) : null,
    };
  }

  /**
   * 更新资料（真实落库，M0-20 验收要求"改昵称后重进仍生效"）
   *
   * ⚠️ 昵称与个人简介是**公开可见的 UGC**（订单、评价、服务者列表都会展示），
   * 必须在落库**之前**送审（M4-05，红线）。放在最前面而不是写完再查：
   * 先写后查会出现"内容已入库但用户看到报错"的不一致状态。
   */
  async updateMe(userId: string, dto: UpdateProfileDto): Promise<UserDetail> {
    await this.moderation.assertTexts(
      [
        { field: '昵称', text: dto.nickname },
        { field: '个人简介', text: dto.bio },
      ],
      // 昵称一并作为上下文提交：官方建议带上它，能显著提高广告号识别率
      { userId, scene: 'profile', nickname: dto.nickname },
    );

    const userData = pickUserFields(dto);
    if (Object.keys(userData).length) {
      try {
        await this.prisma.user.update({ where: { id: userId }, data: userData });
      } catch (e) {
        throw translateUniqueViolation(e);
      }
    }

    const profileData = pickProfileFields(dto);
    if (profileData) {
      await this.prisma.userProfile.upsert({
        where: { userId },
        create: { userId, ...profileData },
        update: profileData,
      });
    }

    return this.getMe(userId);
  }

  /** 切换身份（一账号多身份，ADR-06） */
  async listRoles(userId: string): Promise<{ role: Role; scope: string; status: string }[]> {
    const roles = await this.prisma.userRole.findMany({ where: { userId } });
    return roles.map((r) => ({ role: r.role as Role, scope: r.scope, status: r.status }));
  }

  /** 信用分与流水（文档 6.6.4） */
  async getCredit(userId: string) {
    const [profile, logs] = await Promise.all([
      this.prisma.userProfile.findUnique({ where: { userId } }),
      this.prisma.creditLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    return {
      score: profile?.creditScore ?? 80,
      logs: logs.map((l) => ({
        delta: l.delta,
        reason: l.reason,
        balanceAfter: l.balanceAfter,
        createdAt: l.createdAt.toISOString(),
      })),
    };
  }

  /** 积分与流水（文档 6.11） */
  async getPoints(userId: string) {
    const [wallet, logs] = await Promise.all([
      this.prisma.wallet.findUnique({ where: { userId } }),
      this.prisma.pointsLedger.findMany({
        // 只取有金额变动的行：delta=0 的 `charge` 行是 M1-06 的**结清确认记录**，
        // 用于审计与对账（"哪些预扣真的转成了消费"），对用户来说是一条
        // "变动 0 分"的噪音条目，展示出来只会让人困惑"为什么有笔 0 分的账"
        where: { userId, delta: { not: 0 } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    return {
      points: wallet?.points ?? 0,
      logs: logs.map((l) => ({
        delta: l.delta,
        reason: l.reason,
        kind: l.kind,
        balanceAfter: l.balanceAfter,
        createdAt: l.createdAt.toISOString(),
      })),
    };
  }

  /** 钱包（含担保中冻结金额） */
  async getWallet(userId: string) {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new BizException(ErrorCode.NotFound, undefined, '钱包不存在');

    const ledgers = await this.prisma.walletLedger.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return {
      balance: wallet.balance,
      frozen: wallet.frozen,
      totalIncome: wallet.totalIncome,
      points: wallet.points,
      ledger: ledgers.map((l) => ({
        type: l.type,
        amount: l.amount,
        balanceAfter: l.balanceAfter,
        remark: l.remark,
        createdAt: l.createdAt.toISOString(),
      })),
    };
  }
}

/** 只挑选 user 表可更新字段（undefined 不参与更新，避免误覆盖） */
function pickUserFields(dto: UpdateProfileDto): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (dto.nickname !== undefined) data.nickname = dto.nickname;
  if (dto.avatar !== undefined) data.avatar = dto.avatar;
  if (dto.college !== undefined) data.college = dto.college;
  if (dto.grade !== undefined) data.grade = dto.grade;
  if (dto.gender !== undefined) data.gender = dto.gender;
  if (dto.phone !== undefined) data.phone = dto.phone;
  return data;
}

/**
 * 把唯一约束冲突翻译成用户能自己解决的提示。
 *
 * `user.phone` 是 `@unique`：两个人填同一个手机号会被 MySQL 拦成 P2002。
 * 不转译的话，`GlobalExceptionFilter` 对未知异常一律按 500 报，用户看到的是
 * Prisma 原话（`Unique constraint failed on the fields: phone_key`）——
 * 一件"换个手机号就行"的事被演成了"系统故障"。
 */
function translateUniqueViolation(err: unknown): unknown {
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e?.code !== 'P2002') return err;
  // MySQL 下 target 是索引名（`user_phone_key`），不是列名；按包含关系判即可
  if (String(e.meta?.target ?? '').includes('phone')) {
    return new BizException(ErrorCode.ParamInvalid, { field: 'phone' }, '该手机号已被其他账号绑定');
  }
  return new BizException(ErrorCode.ParamInvalid, undefined, '该信息已被其他账号占用');
}

/** 只挑选 user_profile 表可更新字段；都不涉及则返回 null 不写库 */
function pickProfileFields(dto: UpdateProfileDto): Record<string, unknown> | null {
  const touched = dto.bio !== undefined || dto.skills !== undefined;
  if (!touched) return null;
  const data: Record<string, unknown> = {};
  if (dto.bio !== undefined) data.bio = dto.bio;
  if (dto.skills !== undefined) data.skills = dto.skills;
  return data;
}
