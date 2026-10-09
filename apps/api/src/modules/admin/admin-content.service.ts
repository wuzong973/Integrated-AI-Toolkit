import { Injectable } from '@nestjs/common';
import { BizException, ErrorCode, type VerificationListQueryDto } from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProviderService, VERIFICATION_TYPE_PROVIDER } from '../provider/provider.service';

import { AdminAuditService } from './admin-audit.service';

/** 待审项（后台视角：比 C 端的个人视图多一层"申请人是谁"） */
export interface AdminVerificationItem {
  id: string;
  type: string;
  typeLabel: string;
  status: string;
  userId: string;
  nickname: string | null;
  phone: string | null;
  realName: string | null;
  /** ⚠️ 学号属敏感信息，仅管理端下发 */
  studentNo: string | null;
  schoolName: string | null;
  college: string | null;
  skillTags: string[];
  materials: string[];
  rejectReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

/** 认证类型中文名（列表筛选项与标签都用它） */
const TYPE_LABELS: Record<string, string> = {
  provider: '服务者认证',
  student: '学生认证',
  merchant: '商户认证',
};

/**
 * 内容审核（任务清单 M0-23）
 *
 * ## 队列里实际上有什么
 *
 * 全项目只有**一处**会创建认证申请：`ProviderService.apply()`（`type='provider'`）。
 * `auth.service` 里读 `type === 'student'` 的那段是一个**目前没有写入方**的分支。
 * 所以本模块的列表按"全部类型"查（这样将来新增类型不会变成"看不见的积压"），
 * 但**审核动作只对已定义流程的类型开放**。
 *
 * ## 为什么不做成"通用审核"
 *
 * 审核通过是有**副作用**的：provider 通过后会授予接单角色、写回真实姓名与技能画像。
 * 如果这里对任意类型都只改 `status`，就会造出一个"状态是 approved、但什么都没发生"
 * 的申请人 —— 比拒绝更糟，因为他会以为自己过了。所以遇到未定义流程的类型，
 * 这里明确报错，而不是半实现。
 *
 * ## 与 `/provider/verifications` 的关系
 *
 * 后者是同一件事的旧入口（当时管理后台还没开工，接口先落在 provider 模块）。
 * 它仍然可用（`verify:provider` 脚本依赖它）。本模块是后台 UI 的入口，
 * 区别在于权限粒度：旧入口只校验"是不是管理员"，这里要 `content:review` 权限点。
 * 两者最终都调用 `ProviderService.review()`，**审核逻辑只有一份**。
 */
@Injectable()
export class AdminContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderService,
    private readonly audit: AdminAuditService,
  ) {}

  async listVerifications(
    query: VerificationListQueryDto & { type?: string },
  ): Promise<{ list: AdminVerificationItem[]; total: number }> {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.verification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.size,
        take: query.size,
        include: {
          user: { select: { nickname: true, phone: true } },
        },
      }),
      this.prisma.verification.count({ where }),
    ]);

    const schoolIds = [...new Set(rows.map((r) => r.schoolId).filter((v): v is string => !!v))];
    const schools = schoolIds.length
      ? await this.prisma.school.findMany({
          where: { id: { in: schoolIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(schools.map((s) => [s.id, s.name]));

    return { list: rows.map((r) => toItem(r, nameById)), total };
  }

  /** 审核（委托 `ProviderService.review`，审核逻辑只此一份） */
  async review(
    reviewerId: string,
    id: string,
    dto: { approved: boolean; reason?: string },
  ): Promise<AdminVerificationItem> {
    const target = await this.loadReviewable(id);
    const reviewed = await this.providers.review(reviewerId, id, dto);

    await this.audit.record({
      actorId: reviewerId,
      action: dto.approved ? 'content.verification.approve' : 'content.verification.reject',
      targetType: 'verification',
      targetId: id,
      after: { approved: dto.approved, reason: dto.reason ?? null },
      reason: dto.reason,
    });

    return toReviewedItem(reviewed, target.userId);
  }

  /**
   * 取出待审项并校验"这类申请有没有定义审核流程"。
   *
   * 单独抽出来是为了让 `review` 的复杂度留在可读范围内 ——
   * 分支堆在一个方法里，正是 `max-lines` / `complexity` 这类规则想拦的东西。
   */
  private async loadReviewable(id: string): Promise<{ userId: string; type: string }> {
    const row = await this.prisma.verification.findUnique({
      where: { id },
      select: { userId: true, type: true },
    });
    if (!row) throw new BizException(ErrorCode.NotFound, undefined, '认证申请不存在');
    if (row.type !== VERIFICATION_TYPE_PROVIDER) {
      throw new BizException(
        ErrorCode.ParamInvalid,
        { type: row.type },
        `「${TYPE_LABELS[row.type] ?? row.type}」尚未定义审核流程，暂不支持在后台处理`,
      );
    }
    return row;
  }
}

function toItem(
  row: {
    id: string;
    type: string;
    status: string;
    userId: string;
    realName: string | null;
    studentNo: string | null;
    schoolId: string | null;
    college: string | null;
    skillTags: unknown;
    materials: unknown;
    rejectReason: string | null;
    reviewedAt: Date | null;
    createdAt: Date;
    user: { nickname: string | null; phone: string | null };
  },
  schoolNameById: Map<string, string>,
): AdminVerificationItem {
  return {
    id: row.id,
    type: row.type,
    typeLabel: TYPE_LABELS[row.type] ?? row.type,
    status: row.status,
    userId: row.userId,
    nickname: row.user.nickname,
    phone: row.user.phone,
    realName: row.realName,
    studentNo: row.studentNo,
    schoolName: row.schoolId ? (schoolNameById.get(row.schoolId) ?? null) : null,
    college: row.college,
    skillTags: asStrings(row.skillTags),
    materials: asStrings(row.materials),
    rejectReason: row.rejectReason,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Json 列 → string[]（形状不可信，必须收窄） */
function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * `ProviderService.review()` 的返回 → 管理端形状。
 *
 * 抽成函数的原因与 `loadReviewable` 相同：十几个 `??` 兜底堆在 `review` 里
 * 会让该方法的分支数直接超标。
 */
function toReviewedItem(
  reviewed: {
    id: string;
    type: string;
    status: string;
    realName?: string;
    studentNo?: string;
    college?: string;
    skillTags: string[];
    materials: string[];
    rejectReason?: string;
    reviewedAt?: string;
    createdAt: string;
  },
  userId: string,
): AdminVerificationItem {
  return {
    id: reviewed.id,
    type: reviewed.type,
    typeLabel: TYPE_LABELS[reviewed.type] ?? reviewed.type,
    status: reviewed.status,
    userId,
    // 审核动作不重新查申请人资料：这些字段是列表视图用的，
    // 审核完前端会回到列表页并重新拉一次（那里有完整的 user 关联）
    nickname: null,
    phone: null,
    realName: reviewed.realName ?? null,
    studentNo: reviewed.studentNo ?? null,
    schoolName: null,
    college: reviewed.college ?? null,
    skillTags: reviewed.skillTags,
    materials: reviewed.materials,
    rejectReason: reviewed.rejectReason ?? null,
    reviewedAt: reviewed.reviewedAt ?? null,
    createdAt: reviewed.createdAt,
  };
}
