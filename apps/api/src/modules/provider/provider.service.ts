import { Injectable } from '@nestjs/common';
import {
  BizException,
  ErrorCode,
  Role,
  asStringArray,
  type ProviderApplyDto,
  type ReviewVerificationDto,
  type VerificationListQueryDto,
} from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ModerationService } from '../moderation/moderation.service';

/** 认证类型（`verification.type`）。`student` 是学生认证，`provider` 是服务者入驻 */
export const VERIFICATION_TYPE_PROVIDER = 'provider';

/** 认证申请条目 */
export interface VerificationItemDto {
  id: string;
  type: string;
  status: string;
  realName?: string;
  /** ⚠️ 学号属敏感信息，**只在本人与管理员**的接口里下发 */
  studentNo?: string;
  schoolId?: string;
  college?: string;
  skillTags: string[];
  materials: string[];
  rejectReason?: string;
  reviewedAt?: string;
  createdAt: string;
}

/** 我的服务者资料（含认证状态） */
export interface ProviderProfileDto {
  isProvider: boolean;
  skills: string[];
  creditScore: number;
  completedOrders: number;
  realName: string | null;
  college: string | null;
  /** 最近一次入驻申请。`null` = 从未申请过 */
  verification: VerificationItemDto | null;
}

/**
 * 服务者入驻与认证（任务清单 M3-02）
 *
 * ## 验收标准决定了实现形态
 *
 * 任务清单写的是：**未认证账号无法接单；驳回时给出具体原因**。所以：
 *
 *   · "无法接单"由 `StationWriteService.assertIsProvider` 保证（报名时校验 provider 角色），
 *     本模块只负责**把人变成 provider** —— 两者必须成对，缺一个就会出现
 *     "认证了但还是接不了单"或"没认证也能接单"；
 *   · "驳回给出原因"由 `ReviewVerificationSchema` 的 `refine` + 本模块的写入共同保证，
 *     不能只在界面上提示（接口是公开契约，管理后台之外还有别的调用方）。
 *
 * ## 身份信息存**快照**，不读 `user` 表
 *
 * 审核要看到的是"**这次提交的**是谁"。用户事后改了资料，历史申请记录不能跟着变 ——
 * 否则"当初凭什么通过的"就再也说不清了。所以 `real_name / student_no / school_id / college`
 * 落在 `verification` 行上（见 schema 注释）。
 *
 * ## 为什么审核通过才写 `user` / `user_profile`
 *
 * 申请阶段就把技能写进画像，会让**未通过的人**出现在智能匹配的候选池里 ——
 * 而匹配是发布者挑人的依据，把没认证的人混进去等于让发布者承担审核成本。
 */
@Injectable()
export class ProviderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
  ) {}

  /**
   * 提交入驻申请（M3-02）。
   *
   * 允许**被驳回后重新提交**（新建一条申请，保留历史）。
   * 但审核中不允许重复提交 —— 否则管理员会看到同一个人的多条待审记录，
   * 且无法判断哪条才是用户当前的意图。
   */
  async apply(userId: string, dto: ProviderApplyDto): Promise<{ verificationId: string; status: string }> {
    const role = await this.prisma.userRole.findUnique({
      where: { userId_role: { userId, role: Role.Provider } },
      select: { status: true },
    });
    if (role?.status === 'active') {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '你已经是认证服务者了');
    }

    await this.assertSchool(dto.schoolId);
    await this.assertMaterialsOwned(userId, [...dto.materialIds, ...dto.portfolioIds]);

    const pending = await this.prisma.verification.findFirst({
      where: { userId, type: VERIFICATION_TYPE_PROVIDER, status: 'pending' },
      select: { id: true },
    });
    if (pending) {
      throw new BizException(
        ErrorCode.DuplicateOperation,
        { verificationId: pending.id },
        '你的入驻申请正在审核中，请耐心等待结果',
      );
    }

    // 技能标签会展示在服务者主页上，属 UGC，必须送审（M4-05）
    await this.moderation.assertText(dto.skillTags.join('、'), {
      userId,
      scene: 'profile',
      field: '技能标签',
    });

    const created = await this.prisma.verification.create({
      data: {
        userId,
        type: VERIFICATION_TYPE_PROVIDER,
        status: 'pending',
        // 身份快照
        realName: dto.realName,
        studentNo: dto.studentNo,
        schoolId: dto.schoolId,
        college: dto.college ?? null,
        // 材料：学生证 + 作品集。作品集可为空（不是所有技能都有作品）
        materials: [...dto.materialIds, ...dto.portfolioIds],
        skillTags: dto.skillTags,
      },
      select: { id: true, status: true },
    });

    return { verificationId: created.id, status: created.status };
  }

  /** 我的服务者资料与认证状态（小程序「认证中心」用） */
  async profile(userId: string): Promise<ProviderProfileDto> {
    const [user, role, latest] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          realName: true,
          college: true,
          profile: { select: { skills: true, creditScore: true, completedOrders: true } },
        },
      }),
      this.prisma.userRole.findUnique({
        where: { userId_role: { userId, role: Role.Provider } },
        select: { status: true },
      }),
      this.prisma.verification.findFirst({
        where: { userId, type: VERIFICATION_TYPE_PROVIDER },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    if (!user) throw new BizException(ErrorCode.NotFound, undefined, '用户不存在');

    return {
      isProvider: role?.status === 'active',
      skills: asStringArray(user.profile?.skills),
      creditScore: user.profile?.creditScore ?? 80,
      completedOrders: user.profile?.completedOrders ?? 0,
      realName: user.realName,
      college: user.college,
      // 本人看自己的申请：学号不脱敏（本来就是他自己填的）
      verification: latest ? toVerificationItem(latest, true) : null,
    };
  }

  /**
   * 学校列表（入驻表单的学校选择器用）。
   *
   * 公开接口：学校名不是敏感信息，而**表单要在用户还没提交任何东西时就能渲染**。
   * 让它依赖登录只会平白多一个"未登录时表单是空的"的状态。
   */
  async schools(): Promise<{ id: string; name: string; city?: string }[]> {
    const rows = await this.prisma.school.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, city: true },
    });
    return rows.map((r) => ({ id: r.id, name: r.name, ...(r.city ? { city: r.city } : {}) }));
  }

  /** 待审列表（管理端，M0-23 管理后台的接口侧） */
  async listVerifications(
    query: VerificationListQueryDto,
  ): Promise<{ list: VerificationItemDto[]; total: number }> {
    const where = {
      type: VERIFICATION_TYPE_PROVIDER,
      ...(query.status ? { status: query.status } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.verification.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (query.page - 1) * query.size,
        take: query.size,
      }),
      this.prisma.verification.count({ where }),
    ]);

    // 管理员看得到学号（审核必须要核对学号与学生证是否一致）
    return { list: rows.map((r) => toVerificationItem(r, true)), total };
  }

  /**
   * 审核（管理端）。
   *
   * ## 通过时必须**一次性**把三处写全
   *
   * `verification` 标记已通过、`user_role` 授予 provider、`user_profile` 写入技能 ——
   * 三者必须同一事务。分开写会出现两类坏状态：
   *   · 有角色没技能 → 匹配算法把他算成"零技能"，永远排在最后；
   *   · 有技能没角色 → 界面显示已认证，报名却报 40312。
   * 两种都**不报错**，只是"看起来好了但用不了"。
   */
  async review(
    reviewerId: string,
    id: string,
    dto: ReviewVerificationDto,
  ): Promise<VerificationItemDto> {
    const v = await this.prisma.verification.findUnique({ where: { id } });
    if (!v) throw new BizException(ErrorCode.NotFound, undefined, '认证申请不存在');
    if (v.status !== 'pending') {
      throw new BizException(ErrorCode.OrderStatusConflict, { status: v.status }, '该申请已审核过');
    }

    const now = new Date();
    const status = dto.approved ? 'approved' : 'rejected';
    const rejectReason = dto.approved ? null : (dto.reason ?? '').trim();

    const updated = await this.prisma.$transaction(async (tx) => {
      // 条件更新：两个管理员同时审同一条时，后者 count=0 → 抛 40902，而不是覆盖前者的结论
      const moved = await tx.verification.updateMany({
        where: { id, status: 'pending' },
        data: { status, rejectReason, reviewerId, reviewedAt: now },
      });
      if (moved.count === 0) {
        throw new BizException(ErrorCode.OrderStatusConflict, undefined, '该申请已被其他人审核');
      }

      if (dto.approved) {
        await tx.userRole.upsert({
          where: { userId_role: { userId: v.userId, role: Role.Provider } },
          update: { status: 'active' },
          create: { userId: v.userId, role: Role.Provider, scope: 'self', status: 'active' },
        });
        await tx.user.update({
          where: { id: v.userId },
          data: {
            realName: v.realName ?? undefined,
            college: v.college ?? undefined,
            schoolId: v.schoolId ?? undefined,
          },
        });
        await tx.userProfile.upsert({
          where: { userId: v.userId },
          update: { skills: asStringArray(v.skillTags) },
          create: { userId: v.userId, skills: asStringArray(v.skillTags) },
        });
      }

      return tx.verification.findUniqueOrThrow({ where: { id } });
    });

    return toVerificationItem(updated, true);
  }

  // ---------- 内部校验 ----------

  private async assertSchool(schoolId: string): Promise<void> {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { id: true },
    });
    if (!school) {
      throw new BizException(ErrorCode.ParamInvalid, { schoolId }, '学校不存在，请重新选择');
    }
  }

  /**
   * 材料必须**属于申请人自己**。
   *
   * 不做这个校验的话，任何人拿到别人的文件 id 就能把别人的学生证当作自己的材料提交 ——
   * 而文件 id 是 uuid、又能从列表接口拿到，这不是理论风险。
   * 逐条比对数量而不是"存在即通过"：少一条就说明有 id 不属于他。
   */
  private async assertMaterialsOwned(userId: string, ids: string[]): Promise<void> {
    const unique = [...new Set(ids)];
    if (!unique.length) return;

    const owned = await this.prisma.fileAsset.count({
      where: { id: { in: unique }, userId, deletedAt: null },
    });
    if (owned !== unique.length) {
      throw new BizException(
        ErrorCode.NoPermission,
        { submitted: unique.length, owned },
        '认证材料里有文件不存在或不属于你，请重新上传',
      );
    }
  }
}

/** 行 → 对端条目。`withStudentNo=false` 时脱敏（对外展示的场合用） */
function toVerificationItem(
  row: {
    id: string;
    type: string;
    status: string;
    realName: string | null;
    studentNo: string | null;
    schoolId: string | null;
    college: string | null;
    skillTags: unknown;
    materials: unknown;
    rejectReason: string | null;
    reviewedAt: Date | null;
    createdAt: Date;
  },
  withStudentNo: boolean,
): VerificationItemDto {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    ...(row.realName ? { realName: row.realName } : {}),
    ...(withStudentNo && row.studentNo ? { studentNo: row.studentNo } : {}),
    ...(row.schoolId ? { schoolId: row.schoolId } : {}),
    ...(row.college ? { college: row.college } : {}),
    skillTags: asStringArray(row.skillTags),
    materials: asStringArray(row.materials),
    ...(row.rejectReason ? { rejectReason: row.rejectReason } : {}),
    ...(row.reviewedAt ? { reviewedAt: row.reviewedAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}
