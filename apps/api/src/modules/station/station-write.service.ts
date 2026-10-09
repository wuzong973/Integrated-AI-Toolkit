import { Injectable } from '@nestjs/common';
import {
  ApplicationStatus,
  BizException,
  ErrorCode,
  Role,
  TaskStatus,
  taskNo,
  transitionTask,
  type ApplyTaskDto,
  type PublishTaskDto,
  type SelectProviderDto,
} from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ModerationService } from '../moderation/moderation.service';
import { NotificationType } from '../notification/dto/notification.dto';
import { NotificationService } from '../notification/notification.service';
import { OrderService } from '../order/order.service';

import { toTaskItem, type TaskItemDto } from './station.service';

/**
 * 驿站 · 写路径（任务清单 M3-06 发布 / M3-10 报名·派单 / M3-08 关闭）
 *
 * ## 为什么这四条必须整块做
 *
 * 它们是一条链：**发布 → 报名 → 选定 → 生成订单**。
 * 只做前一半（比如只做发布）会让用户走到"报名成功"之后卡住 ——
 * 而卡住的地方没有任何报错，只是"什么都没发生"，
 * 这正是本项目反复出现的"看起来能用、其实断路"的形态。
 *
 * ## 三条纪律
 *
 * 1. **状态迁移一律走 `transitionTask()`**（红线）：非法迁移抛 40904，而不是静默写坏数据。
 * 2. **UGC 一律先送审**（M4-05）：标题 / 描述 / 报名留言都走 `ModerationService`，
 *    且位置在**权限校验之后、落库之前**。
 * 3. **选定服务者与建订单必须同一事务**：否则会留下"任务已选定、却没有订单"的死状态。
 */
@Injectable()
export class StationWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
    private readonly orders: OrderService,
    // 站内信扇出（M3-19）。TS 可选、线上必需（@Global 模块装配不上会启动失败）；
    // 可选只为兼容既有的手工构造单测，详见 `order.service.ts` 构造函数上的说明。
    private readonly notifications?: NotificationService,
  ) {}

  /**
   * 发布需求（M3-06）。
   *
   * ## 为什么直接落 `published`、不走 `draft → reviewing`
   *
   * 状态机里确实有这两个中间态，它们是为**人工预审队列**准备的。
   * 而本平台的内容安全是**同步 fail-closed** 的（M4-05）——
   * 违规内容在写入口就被 40051 拦下，根本进不了库。
   * 再让用户等一次人工审核，只会让"发布"这个动作变成异步的，
   * 而异步意味着前端要处理"待审核"状态、要轮询、要有审核不通过的文案 ——
   * 这些复杂度换不来任何合规收益。
   *
   * ⚠️ 一旦引入人工复审（如举报后回查），这里要改回 `reviewing`。
   */
  async publish(publisherId: string, dto: PublishTaskDto): Promise<TaskItemDto> {
    const category = await this.prisma.serviceCategory.findUnique({
      where: { id: dto.categoryId },
      select: { id: true },
    });
    if (!category) {
      throw new BizException(ErrorCode.ParamInvalid, { categoryId: dto.categoryId }, '服务分类不存在');
    }

    // 标题与描述都是公开可见的 UGC，落库前必须送审（M4-05）
    await this.moderation.assertTexts(
      [
        { field: '需求标题', text: dto.title },
        { field: '需求描述', text: dto.description },
      ],
      { userId: publisherId, scene: 'forum', title: dto.title },
    );

    const now = new Date();
    const created = await this.prisma.task.create({
      data: {
        taskNo: taskNo(now),
        publisherId,
        categoryId: dto.categoryId,
        title: dto.title,
        description: dto.description,
        budget: dto.budget,
        budgetType: dto.budgetType,
        deadline: dto.deadline ? new Date(dto.deadline) : null,
        location: dto.location ?? null,
        skillTags: dto.skillTags,
        attachments: dto.attachmentIds,
        source: dto.source ?? 'manual',
        refRunId: dto.refRunId ?? null,
        status: TaskStatus.Published,
        publishedAt: now,
      },
      include: PUBLISHER_INCLUDE,
    });

    return toTaskItem(created);
  }

  /**
   * 报名 / 抢单（M3-10）。
   *
   * ## 为什么用唯一约束 + 原子自增，而不是"先查再写"
   *
   * 报名是一个**用户会连点**的动作。先 `findFirst` 判断"报过没有"再 `create`，
   * 在两次点击之间有空隙，结果是两条报名记录（或一条 500）。
   * `@@unique([taskId, providerId])` 把并发收口到数据库，重复插入抛 P2002 ——
   * 那是**可判定**的冲突，可以翻译成 40901 让用户看懂。
   *
   * `applyCount` 用 `increment` 而不是"读出来 +1 再写回"：后者在并发下会丢计数，
   * 而计数丢失是**静默**的（列表上的"3 人报名"永远比实际少）。
   */
  async apply(userId: string, taskId: string, dto: ApplyTaskDto): Promise<{ applicationId: string }> {
    const task = await this.loadOpenTask(taskId);
    if (task.publisherId === userId) {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '不能报名自己发布的需求');
    }
    await this.assertIsProvider(userId);

    await this.moderation.assertText(dto.message, {
      userId,
      scene: 'comment',
      field: '报名留言',
    });

    try {
      const application = await this.prisma.$transaction(async (tx) => {
        const row = await tx.taskApplication.create({
          data: {
            taskId,
            providerId: userId,
            quote: dto.quote ?? 0,
            message: dto.message ?? null,
            status: ApplicationStatus.Pending,
          },
          select: { id: true },
        });
        await tx.task.update({ where: { id: taskId }, data: { applyCount: { increment: 1 } } });
        // 扇出（M3-19）：报名的要义是"发布者该看到我了"。与报名记录同事务 ——
        // 计数加了、通知没发，发布者就永远等不到那条提醒。
        await this.notifications?.notify(tx, {
          userId: task.publisherId,
          type: NotificationType.Task,
          title: '有人报名了你的需求',
          body: '去任务详情查看报名者与报价，选定后会自动生成担保订单。',
          refType: 'task',
          refId: taskId,
        });
        return row;
      });
      return { applicationId: application.id };
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new BizException(ErrorCode.DuplicateOperation, undefined, '你已经报过名了，请等待发布者选定');
      }
      throw e;
    }
  }

  /**
   * 选定服务者（M3-10 派单）→ 生成担保订单（M3-11）。
   *
   * ## 为什么订单在这里建、而不是让前端"选定后再去下单"
   *
   * 两段式会让用户在中间掉队：选定了却没下单，任务停在 `assigned`，
   * 而发布者以为自己已经找好人了。所以选定与建单是**一个动作**，
   * 且必须在同一事务里 —— 见 `OrderService.createInTx` 的说明。
   *
   * ## 金额从哪来
   *
   * 默认取任务预算；`dto.amount` 允许覆盖（议价场景）。
   * 但**只允许发布者自己传**，且服务端仍会重算平台费（红线：金额一律服务端算）。
   */
  async select(
    userId: string,
    taskId: string,
    dto: SelectProviderDto,
  ): Promise<{ taskId: string; orderId: string; orderNo: string; amount: number }> {
    const task = await this.loadOpenTask(taskId);
    if (task.publisherId !== userId) {
      throw new BizException(ErrorCode.NoPermission, undefined, '只有发布者可以选定服务者');
    }

    const application = await this.prisma.taskApplication.findUnique({
      where: { taskId_providerId: { taskId, providerId: dto.providerId } },
      select: { id: true, status: true },
    });
    if (!application) {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '该服务者没有报名这条需求');
    }

    await this.orders.assertCreatable(userId, dto.providerId);
    const amount = dto.amount ?? task.budget;
    if (amount <= 0) {
      throw new BizException(ErrorCode.ParamInvalid, { amount }, '成交金额必须大于 0');
    }

    // 状态机校验放在事务外：非法迁移是**调用方逻辑错误**，不该占着数据库事务
    transitionTask(task.status as TaskStatus, TaskStatus.Assigned);

    return this.prisma.$transaction(async (tx) => {
      // 条件更新：只有仍是 `published` 才改得动。两个人同时选定不同服务者时，
      // 后者会 count=0 → 抛 40903，而不是把前者的选定悄悄覆盖掉
      const moved = await tx.task.updateMany({
        where: { id: taskId, status: TaskStatus.Published },
        data: { status: TaskStatus.Assigned, selectedProviderId: dto.providerId },
      });
      if (moved.count === 0) {
        throw new BizException(ErrorCode.TaskAlreadyAssigned, undefined, '该需求已被选定服务者');
      }

      await tx.taskApplication.update({
        where: { id: application.id },
        data: { status: ApplicationStatus.Selected },
      });
      await tx.taskApplication.updateMany({
        where: { taskId, id: { not: application.id } },
        data: { status: ApplicationStatus.Rejected },
      });

      // 需求描述已经过发布时送审，这里直接作为订单的"需求说明"带过去
      const order = await this.orders.createInTx(
        tx,
        userId,
        { taskId, providerId: dto.providerId, amount },
        { requirement: task.description },
      );
      // 扇出（M3-19）：被选定的人要立刻知道"有单了"。付的是买家，所以文案说清
      // "等买家支付"，别让服务者以为可以马上开工（开工条件是订单进入已支付）。
      await this.notifications?.notify(tx, {
        userId: dto.providerId,
        type: NotificationType.Task,
        title: '你被选定为服务者',
        body: `订单 ${order.orderNo} 已生成，等待买家支付后即可开始服务。`,
        refType: 'order',
        refId: order.id,
      });
      return { taskId, orderId: order.id, orderNo: order.orderNo, amount: order.amount };
    });
  }

  /**
   * 关闭需求（M3-08）。
   *
   * 只有发布者、且只在**还没有选定服务者**时可用 ——
   * 已选定意味着已经有订单在走支付，那是取消订单的事（M3-15），不是关需求。
   */
  async close(userId: string, taskId: string): Promise<{ status: string }> {
    const task = await this.loadOpenTask(taskId);
    if (task.publisherId !== userId) {
      throw new BizException(ErrorCode.NoPermission, undefined, '只有发布者可以关闭需求');
    }
    transitionTask(task.status as TaskStatus, TaskStatus.Closed);

    await this.prisma.$transaction(async (tx) => {
      /**
       * 条件更新（并发守卫）：只有仍是 `published` 才关得动。
       *
       * 与同文件 `selectProvider` 口径一致 —— 那边早就是
       * `updateMany + where.status`。裸 `update` 时，"关需求"与"选定服务者"
       * 并发发生会双写：一边把需求置为已选定并生成订单，另一边把它置为已关闭，
       * 于是订单挂在一个"已关闭"的需求上。
       */
      const closed = await tx.task.updateMany({
        where: { id: taskId, status: TaskStatus.Published },
        data: { status: TaskStatus.Closed },
      });
      if (closed.count === 0) {
        throw new BizException(
          ErrorCode.OrderStatusConflict,
          undefined,
          '该需求已被处理（可能已选定服务者），请刷新后重试',
        );
      }

      // 扇出（M3-19）：关需求的代价是"所有报名者白等"。逐个通知，且与状态变更同事务 ——
      // 关成功了、通知丢了，报名者看到的就是一条永远停在"招募中"的需求。
      const applicants = await tx.taskApplication.findMany({
        where: { taskId },
        select: { providerId: true },
      });
      for (const applicant of applicants) {
        await this.notifications?.notify(tx, {
          userId: applicant.providerId,
          type: NotificationType.Task,
          title: '你报名的需求已关闭',
          body: '发布者关闭了这条需求，不必再继续等待选定；可以去任务大厅找其他需求。',
          refType: 'task',
          refId: taskId,
        });
      }
    });
    return { status: TaskStatus.Closed };
  }

  // ---------- 内部 ----------

  /** 取一条"还在招募中"的任务（其余状态由调用方各自判断） */
  private async loadOpenTask(taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, status: true, budget: true, publisherId: true, description: true },
    });
    if (!task) throw new BizException(ErrorCode.NotFound, undefined, '任务不存在或已下架');
    if (task.status !== TaskStatus.Published) {
      throw new BizException(
        ErrorCode.OrderStatusConflict,
        { status: task.status },
        '该需求已不在招募中',
      );
    }
    return task;
  }

  /** 报名需要服务者身份（文档 5.3.12：完成服务者认证即可接单） */
  private async assertIsProvider(userId: string): Promise<void> {
    const role = await this.prisma.userRole.findFirst({
      where: { userId, role: Role.Provider, status: 'active' },
      select: { id: true },
    });
    if (!role) {
      throw new BizException(ErrorCode.ProviderVerificationRequired, undefined, '完成服务者认证即可接单');
    }
  }
}

/** Prisma 唯一约束冲突（P2002）。用结构判断而不是 `instanceof`，避免耦合生成客户端的类 */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

/** 与 StationService 共用同一份关联字段（发布者摘要含信用分） */
const PUBLISHER_INCLUDE = {
  publisher: {
    select: { id: true, nickname: true, profile: { select: { creditScore: true } } },
  },
} as const;
