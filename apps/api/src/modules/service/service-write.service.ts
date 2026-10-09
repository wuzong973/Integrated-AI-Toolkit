import { Injectable } from '@nestjs/common';
import {
  BizException,
  ErrorCode,
  Role,
  type ServiceCreateDto,
  type ServiceStatusValue,
} from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ModerationService } from '../moderation/moderation.service';

import {
  SERVICE_INCLUDE,
  SERVICE_STATUS_LABEL,
  ServiceStatus,
  toServiceItem,
  type ServiceItemDto,
} from './dto/service.dto';

/**
 * 服务商品 · 写路径（任务清单 M3-04 上架 / 下架 / 重新上架）
 *
 * ## 谁能写
 *
 * **只有认证服务者**（`user_role` 里 `role=provider` 且 `status=active`）。
 * 判定方式与 `StationWriteService.assertIsProvider` 完全一致，且**读的是角色表而不是
 * `verification` 表** —— 认证通过时 `ProviderService.review()` 会在同一事务里
 * 授予 `user_role`、写入技能（M3-02）。所以 `user_role.active` 是唯一权威结论；
 * 若这里改去查 `verification.status='approved'`，就会出现
 * "审核记录被删/重提后角色还在、判定却变了" 的两套口径。
 *
 * ## 顺序纪律：先越权、再送审（照抄驿站写路径）
 *
 * `assertProvider` → 分类存在性 → `ModerationService` → 落库。
 * 送审是**花钱的外部调用**（微信 `msgSecCheck` 有配额），把它放在权限与参数校验之后，
 * 未授权请求就不会消耗审核配额，也不会出现"内容违规"盖住"你没权限"这种误导文案。
 *
 * ## 状态一律经 `transitionService()`
 *
 * 红线：状态变更不许直接赋值。本模块自带一张小迁移表（见文件末尾），
 * 原因是 core 的 `state-machine/` 本次不在可改文件范围内 ——
 * M3-05 接线（下单要校验商品在架）时把它整体搬进 `packages/core/src/state-machine/service.ts`，
 * 与 `transitionTask()` 并列为唯一入口。
 */
@Injectable()
export class ServiceWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
  ) {}

  /**
   * 上架服务（M3-04）。落库即为 `on`：内容安全是同步 fail-closed 的，
   * 违规在这一步就被 40051 拦下，不需要"待审核"中间态（详见 core 的 `SERVICE_STATUSES` 注释）。
   */
  async create(providerId: string, dto: ServiceCreateDto): Promise<ServiceItemDto> {
    await this.assertProvider(providerId);
    await this.assertCategory(dto.categoryId);

    // 标题、描述、技能标签都会公开出现在服务卡上，三条都是 UGC，必须逐条送审（M4-05）
    await this.moderation.assertTexts(
      [
        { field: '服务标题', text: dto.title },
        { field: '服务描述', text: dto.description },
        { field: '技能标签', text: dto.skillTags.join('、') },
      ],
      { userId: providerId, scene: 'forum', title: dto.title },
    );

    // `cover` 是 URL，**本期不做图片审核**：`checkImage` 依赖公网可达的图与异步回调
    // （`mediaCheckAsync`），接入点尚未落地（见 docs/dev/CONFIG-GAPS.md）。
    // 这里如实存 URL，不假装"已审"。
    const created = await this.prisma.service.create({
      data: {
        providerId,
        categoryId: dto.categoryId,
        title: dto.title,
        description: dto.description,
        cover: dto.cover ?? null,
        price: dto.price,
        priceUnit: dto.priceUnit,
        deliveryDays: dto.deliveryDays,
        serviceArea: dto.serviceArea,
        skillTags: dto.skillTags,
        status: ServiceStatus.On,
      },
      // 回读时带出服务者摘要与分类名：上架成功的响应要与列表/详情**同一份形状**，
      // 否则前端拿到响应后还得再查一次列表才能刷新服务卡
      include: SERVICE_INCLUDE,
    });
    return toServiceItem(created);
  }

  /** 下架（仅本人）。已经是 `off` 再点下架 = 非法迁移，明确拒绝而不是静默成功 */
  async off(providerId: string, id: string): Promise<{ id: string; status: string }> {
    return this.setStatus(providerId, id, ServiceStatus.Off);
  }

  /**
   * 重新上架（仅本人）。
   *
   * 不重复送审：本期没有编辑接口，`on` 的内容与首次上架时**逐字相同**，
   * 而那一份已经过 fail-closed 审核。⚠️ 一旦加上"编辑服务"（M3-04 的 U），
   * 改过文本就必须重新送审，否则"审核一次、终身免检"就成了绕过口。
   */
  async on(providerId: string, id: string): Promise<{ id: string; status: string }> {
    return this.setStatus(providerId, id, ServiceStatus.On);
  }

  // ---------- 内部 ----------

  /** 取本人的一条服务。不存在 404；不是自己的 403（越权先拒，别把状态信息漏给外人） */
  private async loadOwned(id: string, providerId: string) {
    const row = await this.prisma.service.findUnique({
      where: { id },
      select: { id: true, providerId: true, status: true },
    });
    if (!row) throw new BizException(ErrorCode.NotFound, undefined, '服务不存在或已被删除');
    if (row.providerId !== providerId) {
      throw new BizException(ErrorCode.NoPermission, undefined, '只能管理自己上架的服务');
    }
    return row;
  }

  /** 改状态：条件更新，避免"两个人同时点"把对方的结论盖掉（与驿站同一手法） */
  private async setStatus(
    providerId: string,
    id: string,
    target: ServiceStatusValue,
  ): Promise<{ id: string; status: string }> {
    const row = await this.loadOwned(id, providerId);
    const next = transitionService(row.status, target);

    const moved = await this.prisma.service.updateMany({
      where: { id, status: row.status },
      data: { status: next },
    });
    if (moved.count === 0) {
      throw new BizException(
        ErrorCode.OrderStatusConflict,
        { status: next },
        '该服务状态刚被改动，请刷新后重试',
      );
    }
    return { id, status: next };
  }

  /** 认证服务者判定（见文件头）。40312 的文案要说清"上架"这件事，不能沿用"接单" */
  private async assertProvider(userId: string): Promise<void> {
    const role = await this.prisma.userRole.findUnique({
      where: { userId_role: { userId, role: Role.Provider } },
      select: { status: true },
    });
    if (role?.status !== 'active') {
      throw new BizException(
        ErrorCode.ProviderVerificationRequired,
        undefined,
        '完成服务者认证即可上架服务',
      );
    }
  }

  /** 分类必须存在：`service.category_id` 是必填外键，写错就是 500，不如提前 400 */
  private async assertCategory(categoryId: string): Promise<void> {
    const category = await this.prisma.serviceCategory.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) {
      throw new BizException(ErrorCode.ParamInvalid, { categoryId }, '服务分类不存在，请重新选择');
    }
  }
}

/**
 * 服务商品状态机：`draft → on ⇄ off`。
 *
 * 非法迁移抛 40904（HTTP 409）。这里抛 `BizException` 而不是 core 的
 * `IllegalTransitionError`：后者经全局过滤器会变成统一文案"当前状态不允许该操作"，
 * 而用户点了"下架"却看到这句，会以为按钮坏了 —— 状态机报错必须说清**现在是什么状态**。
 */
const SERVICE_TRANSITIONS: Record<ServiceStatusValue, readonly ServiceStatusValue[]> = {
  [ServiceStatus.Draft]: [ServiceStatus.On],
  [ServiceStatus.On]: [ServiceStatus.Off],
  [ServiceStatus.Off]: [ServiceStatus.On],
};

export function transitionService(from: string, to: ServiceStatusValue): ServiceStatusValue {
  const allowed = SERVICE_TRANSITIONS[from as ServiceStatusValue] ?? [];
  if (!allowed.includes(to)) {
    const fromLabel = SERVICE_STATUS_LABEL[from as ServiceStatusValue] ?? from;
    const message =
      from === to
        ? `该服务已是「${fromLabel}」状态，无需重复操作`
        : `当前状态是「${fromLabel}」，不支持该操作`;
    throw new BizException(ErrorCode.IllegalStateTransition, { from, to }, message);
  }
  return to;
}
