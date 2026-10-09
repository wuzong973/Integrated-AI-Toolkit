import { Injectable } from '@nestjs/common';
import { BizException, ErrorCode, JobStatus, isJobTerminal, transitionJob, type AdminJobListQueryDto } from '@qz/core';
import type { Prisma } from '@prisma/client';

import { AppLogger } from '../../common/logger/logger.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { JobRetryService } from '../job/job-retry.service';

import { AdminAuditService } from './admin-audit.service';

/** 工具行（后台视角：含上下线状态与用量） */
export interface AdminToolItem {
  name: string;
  displayName: string;
  category: string;
  status: string;
  visible: boolean;
  price: number;
  dailyQuota: number;
  /** 最近 7 天的作业数（判断"这个工具到底有没有人用"） */
  jobs7d: number;
}

export interface AdminJobItem {
  id: string;
  toolName: string;
  status: string;
  progress: number;
  stage: string | null;
  cost: number;
  error: string | null;
  qualityScore: number | null;
  outputCount: number;
  userId: string;
  nickname: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AdminJobDetail extends AdminJobItem {
  params: unknown;
  stage: string | null;
  outputFiles: string[];
  qualityIssues: string[];
}

const JOB_SELECT = {
  id: true,
  toolName: true,
  status: true,
  progress: true,
  stage: true,
  cost: true,
  error: true,
  qualityScore: true,
  qualityIssues: true,
  outputFiles: true,
  params: true,
  userId: true,
  createdAt: true,
  finishedAt: true,
  user: { select: { nickname: true } },
} as const;

type Row = Prisma.ToolJobGetPayload<{ select: typeof JOB_SELECT }>;

/**
 * 工具与作业监控（任务清单 M0-23）
 *
 * ## 为什么这一页值得存在
 *
 * 作业失败是**静默**的：用户看到"处理失败"，而运营侧看不到失败率、
 * 看不出"是不是某个工具最近全挂了"。这一页把 `tool_job` 按工具与状态摊开，
 * 让"某个工具突然 100% 失败"变成一眼可见的事实。
 *
 * ## 重跑走 `JobRetryService`，不自己建作业
 *
 * 重试必须重新预扣积分（否则等于无限免费重跑，见 `job-retry.service.ts`）。
 * 这里若图省事直接 `toolJob.create()`，就从后台开了一个绕过计费的口子。
 */
@Injectable()
export class AdminJobService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly retry: JobRetryService,
    private readonly audit: AdminAuditService,
    private readonly logger: AppLogger,
  ) {}

  /** 工具列表 + 近 7 天作业量 */
  async listTools(): Promise<AdminToolItem[]> {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const [tools, grouped] = await Promise.all([
      this.prisma.tool.findMany({
        orderBy: [{ sort: 'asc' }, { name: 'asc' }],
        select: {
          name: true,
          displayName: true,
          status: true,
          visible: true,
          price: true,
          dailyQuota: true,
          category: { select: { id: true } },
        },
      }),
      this.prisma.toolJob.groupBy({
        by: ['toolName'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
    ]);

    const countByTool = new Map(grouped.map((g) => [g.toolName, g._count._all]));
    return tools.map((t) => ({
      name: t.name,
      displayName: t.displayName,
      category: t.category?.id ?? '',
      status: t.status,
      visible: t.visible,
      price: t.price,
      dailyQuota: t.dailyQuota,
      jobs7d: countByTool.get(t.name) ?? 0,
    }));
  }

  /** 跨用户作业列表 */
  async listJobs(query: AdminJobListQueryDto): Promise<{ list: AdminJobItem[]; total: number }> {
    const where: Prisma.ToolJobWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.toolName ? { toolName: query.toolName } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.keyword
        ? {
            OR: [
              { id: { contains: query.keyword } },
              { toolName: { contains: query.keyword } },
              { error: { contains: query.keyword } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.toolJob.findMany({
        where,
        select: JOB_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.size,
        take: query.size,
      }),
      this.prisma.toolJob.count({ where }),
    ]);

    return { list: rows.map(toItem), total };
  }

  async jobDetail(id: string): Promise<AdminJobDetail> {
    const row = await this.prisma.toolJob.findUnique({ where: { id }, select: JOB_SELECT });
    if (!row) throw new BizException(ErrorCode.NotFound, undefined, '作业不存在');
    return {
      ...toItem(row),
      params: row.params,
      outputFiles: asStrings(row.outputFiles),
      qualityIssues: asStrings(row.qualityIssues),
    };
  }

  /**
   * 重跑作业。
   *
   * ⚠️ 用**作业所属用户**的 id 去调 `retry`：`JobRetryService.retry` 会做归属校验
   * （`getRaw(userId, jobId)`），传管理员自己的 id 会直接 NoPermission。
   * 计费落在原用户身上 —— 这是有意的：重跑的是**他的**作业，消耗的是**他的**积分，
   * 与用户自己点重试完全一致（管理员只是替他按了按钮）。
   */
  async retryJob(id: string, actorUserId: string): Promise<AdminJobItem> {
    const row = await this.prisma.toolJob.findUnique({
      where: { id },
      select: { id: true, userId: true, toolName: true },
    });
    if (!row) throw new BizException(ErrorCode.NotFound, undefined, '作业不存在');

    const job = await this.retry.retry(row.userId, id);

    await this.audit.record({
      actorId: actorUserId,
      action: 'job.retry',
      targetType: 'tool_job',
      targetId: row.id,
      after: { newJobId: job.id, toolName: row.toolName, billedTo: row.userId },
    });

    this.logger.log(`管理员重跑作业 ${row.id} → ${job.id} by=${actorUserId}`, 'AdminJob');
    return this.jobDetail(job.id);
  }

  /** 取消作业（终态作业会被 JobService 的状态机拒绝） */
  async cancelJob(id: string, actorUserId: string): Promise<AdminJobItem> {
    const row = await this.prisma.toolJob.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true },
    });
    if (!row) throw new BizException(ErrorCode.NotFound, undefined, '作业不存在');

    const from = row.status as JobStatus;
    if (isJobTerminal(from)) {
      throw new BizException(ErrorCode.IllegalStateTransition, undefined, '作业已结束，无法取消');
    }
    transitionJob(from, JobStatus.Canceled);

    const moved = await this.prisma.toolJob.updateMany({
      where: { id, status: from },
      data: { status: JobStatus.Canceled, stage: '已取消（管理员）', finishedAt: new Date() },
    });
    if (moved.count === 0) {
      throw new BizException(ErrorCode.OrderStatusConflict, undefined, '作业状态已变更，请刷新后重试');
    }

    await this.audit.record({
      actorId: actorUserId,
      action: 'job.cancel',
      targetType: 'tool_job',
      targetId: id,
      before: { status: from },
      after: { status: JobStatus.Canceled },
    });

    return this.jobDetail(id);
  }

  /** 工具上下线（改 status；`active` 才在 C 端可见可跑） */
  async updateToolStatus(
    name: string,
    status: string,
    actorUserId: string,
  ): Promise<AdminToolItem> {
    const tool = await this.prisma.tool.findUnique({ where: { name }, select: { name: true, status: true } });
    if (!tool) throw new BizException(ErrorCode.NotFound, undefined, `工具不存在：${name}`);

    await this.prisma.$transaction(async (tx) => {
      await tx.tool.update({ where: { name }, data: { status } });
      await this.audit.record(
        {
          actorId: actorUserId,
          action: 'tool.status.update',
          targetType: 'tool',
          targetId: name,
          before: { status: tool.status },
          after: { status },
        },
        tx,
      );
    });

    const list = await this.listTools();
    return list.find((t) => t.name === name)!;
  }
}

function toItem(row: Row): AdminJobItem {
  return {
    id: row.id,
    toolName: row.toolName,
    status: row.status,
    progress: row.progress,
    stage: row.stage,
    cost: row.cost,
    error: row.error,
    qualityScore: row.qualityScore,
    outputCount: asStrings(row.outputFiles).length,
    userId: row.userId,
    nickname: row.user.nickname,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
