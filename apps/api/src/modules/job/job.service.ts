import { Injectable } from '@nestjs/common';
import {
  BizException,
  ErrorCode,
  JobStatus,
  isJobTerminal,
  transitionJob,
  type JobProgressSnapshot,
  type JobStatus as JobStatusType,
} from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { BillingService } from '../billing/billing.service';

import { JobEventsService } from './job-events.service';
import { asMetrics, type JobItem, type JobRow } from './job-result';

export type { JobItem };

/** 创建 Job 的入参 */
export interface CreateJobInput {
  userId: string;
  toolName: string;
  params: Record<string, unknown>;
  inputFiles: string[];
  idempotencyKey?: string;
  runId?: string;
  nodeId?: string;
  cost: number;
}

/**
 * Job 异步执行体系（任务清单 M1-03）
 *
 * 核心约束（验收要求"状态与进度全部落库，服务重启后不丢；超时任务自动置 failed"）：
 *   · 每一次状态变更都先过 `transitionJob()` 状态机再落库 —— 状态只能由状态机改（红线）；
 *   · 进度与阶段名实时写库，前端轮询/重连都能拿到最新值；
 *   · 超时扫描把卡在 running 的作业置为 failed，避免"永远转圈"。
 *
 * 幂等：`(userId, idempotencyKey)` 是**复合唯一索引**。并发重复提交会撞唯一约束，
 * 此时捕获 P2002 再读回该用户已存在的 Job —— 保证"同一用户、同一幂等键只执行一次"。
 *
 * ⚠️ **幂等范围是单个用户，不是全局**（这里踩过坑，务必看清）：
 *   幂等键原先做成全局唯一，于是"用户 B 用了用户 A 用过的键"会命中 A 的作业、
 *   而 B 自己的请求被静默丢弃（reused=true，不执行也不扣费），随后访问那个 jobId 还会 403。
 *   库层面已改为 `@@unique([userId, idempotencyKey])`，代码里所有读取**必须带 userId** ——
 *   只按 key 查就会退回旧行为（哪怕只漏一处）。
 */
@Injectable()
export class JobService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: JobEventsService,
    private readonly billing: BillingService,
    private readonly logger: AppLogger,
  ) {}

  /** 创建 Job；命中幂等键时返回该用户已存在的 Job（不重复执行） */
  async create(input: CreateJobInput): Promise<{ job: JobItem; reused: boolean }> {
    if (input.idempotencyKey) {
      const existing = await this.findByUserAndKey(input.userId, input.idempotencyKey);
      if (existing) return { job: toJobItem(existing), reused: true };
    }

    try {
      const job = await this.prisma.toolJob.create({
        data: {
          userId: input.userId,
          toolName: input.toolName,
          params: input.params as never,
          inputFiles: input.inputFiles as never,
          outputFiles: [] as never,
          status: JobStatus.Queued,
          cost: input.cost,
          idempotencyKey: input.idempotencyKey ?? null,
          runId: input.runId ?? null,
          nodeId: input.nodeId ?? null,
        },
      });
      return { job: toJobItem(job), reused: false };
    } catch (e) {
      // 并发提交同一幂等键：唯一约束挡下后读回既有记录。
      // 若读不到（说明撞的不是这条约束，或键属于别的用户），就把原始异常抛出去 ——
      // 静默吞掉会让"提交失败"变成"查不到原因的空结果"。
      if (input.idempotencyKey && isUniqueViolation(e)) {
        const existing = await this.findByUserAndKey(input.userId, input.idempotencyKey);
        if (existing) return { job: toJobItem(existing), reused: true };
      }
      throw e;
    }
  }

  /**
   * 按（用户 + 幂等键）查作业。
   *
   * 用 `findFirst` 而不是 `findUnique`：复合唯一约束下 `findUnique` 需要
   * `userId_idempotencyKey` 复合输入类型，而生成该类型要求重新 `prisma generate`；
   * `findFirst` 的语义完全等价（本查询恰好命中唯一索引），且不依赖客户端重新生成。
   */
  async findByUserAndKey(userId: string, key: string) {
    return this.prisma.toolJob.findFirst({ where: { userId, idempotencyKey: key } });
  }

  /**
   * 取原始作业行（含 params / inputFiles）。
   * 供"重试"这类需要复用原参数的内部流程使用；对外接口只暴露 JobItem。
   */
  async getRaw(
    userId: string,
    id: string,
  ): Promise<{
    id: string;
    toolName: string;
    params: Record<string, unknown>;
    inputFiles: string[];
    cost: number;
    status: string;
  }> {
    const job = await this.prisma.toolJob.findUnique({ where: { id } });
    if (!job) throw new BizException(ErrorCode.NotFound, undefined, '任务不存在');
    if (job.userId !== userId) {
      throw new BizException(ErrorCode.NoPermission, undefined, '无权操作该任务');
    }
    return {
      id: job.id,
      toolName: job.toolName,
      params: asRecord(job.params),
      inputFiles: asStringArray(job.inputFiles),
      cost: job.cost,
      status: job.status,
    };
  }

  /** 查询单个 Job（归属校验） */
  async get(userId: string, id: string): Promise<JobItem> {
    const job = await this.prisma.toolJob.findUnique({ where: { id } });
    if (!job) throw new BizException(ErrorCode.NotFound, undefined, '任务不存在');
    if (job.userId !== userId) {
      throw new BizException(ErrorCode.NoPermission, undefined, '无权查看该任务');
    }
    return toJobItem(job);
  }

  /** 我的执行记录（可按状态筛选） */
  async list(userId: string, status?: string): Promise<JobItem[]> {
    const jobs = await this.prisma.toolJob.findMany({
      where: { userId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return jobs.map(toJobItem);
  }

  /**
   * 取若干作业的当前状态快照（供 WebSocket 订阅时"补齐进度"用）。
   *
   * 一次查询完成**归属过滤**：非本人作业不会出现在结果里。
   * 调用方（网关）据此既完成授权，又拿到要下发的数据，不必查两遍。
   */
  async snapshotsFor(userId: string, ids: string[]): Promise<JobProgressSnapshot[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.toolJob.findMany({
      where: { id: { in: ids }, userId },
      select: { id: true, status: true, progress: true, stage: true, error: true },
    });
    return rows.map((r) => ({
      jobId: r.id,
      status: r.status,
      progress: r.progress,
      stage: r.stage ?? undefined,
      error: r.error ?? undefined,
    }));
  }

  // ---------- 状态流转（全部经状态机校验） ----------

  /** queued → running，并记录开始时间 */
  async markRunning(id: string): Promise<void> {
    await this.transition(id, JobStatus.Running, {
      startedAt: new Date(),
      progress: 0,
      stage: '开始处理',
    });
  }

  /**
   * 上报进度（running 期间）。
   *
   * **单调写入**：比库中已有进度更低的值直接忽略。
   * 这是"进度不倒退"的**服务端保证** —— 客户端的合并逻辑（core 的 mergeJobProgress）
   * 是第二道防线，两者都有才是完整的：只有客户端防，服务端一旦写入倒退值，
   * 轮询（GET /jobs/:id）通道就会把倒退暴露给所有端。
   * 写入后退化成"事件被丢弃"而不是"抛错"，因为进度抖动不值得让作业失败。
   */
  async updateProgress(id: string, progress: number, stage?: string): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(progress)));
    const job = await this.prisma.toolJob.findUnique({
      where: { id },
      select: { userId: true, progress: true, status: true },
    });
    if (!job) return;

    if (clamped < job.progress) {
      this.logger.warn(
        `忽略倒退的进度上报：作业 ${id} 当前 ${job.progress}%，上报 ${clamped}%`,
        'Job',
      );
      return;
    }

    await this.prisma.toolJob.update({
      where: { id },
      data: { progress: clamped, ...(stage ? { stage } : {}) },
    });

    this.events.publishProgress(job.userId, {
      jobId: id,
      status: job.status,
      progress: clamped,
      stage,
    });
  }

  /** running → succeeded。`extra` 携带产出指标与质量分（MQ-01 度量闭环） */
  async succeed(
    id: string,
    outputFiles: string[],
    stage = '已完成',
    extra: {
      metrics?: unknown;
      qualityScore?: number;
      qualityIssues?: string[];
      attempts?: number;
    } = {},
  ): Promise<void> {
    await this.transition(id, JobStatus.Succeeded, {
      progress: 100,
      stage,
      outputFiles: outputFiles as never,
      result: (extra.metrics ?? {}) as never,
      qualityScore: extra.qualityScore ?? null,
      qualityIssues: (extra.qualityIssues ?? []) as never,
      attempts: extra.attempts ?? 1,
      finishedAt: new Date(),
    });
  }

  /** running → failed（记录原因，积分退回由 M1-06 处理） */
  async fail(id: string, error: string): Promise<void> {
    await this.transition(id, JobStatus.Failed, {
      error: error.slice(0, 600),
      stage: '处理失败',
      finishedAt: new Date(),
    });
  }

  /** queued → rejected（校验未通过，未扣费） */
  async reject(id: string, reason: string): Promise<void> {
    await this.transition(id, JobStatus.Rejected, {
      error: reason.slice(0, 600),
      stage: '已拒绝',
      finishedAt: new Date(),
    });
  }

  /** → canceled（用户主动取消） */
  async cancel(userId: string, id: string): Promise<JobItem> {
    const job = await this.prisma.toolJob.findUnique({ where: { id } });
    if (!job) throw new BizException(ErrorCode.NotFound, undefined, '任务不存在');
    if (job.userId !== userId) {
      throw new BizException(ErrorCode.NoPermission, undefined, '无权操作该任务');
    }
    if (isJobTerminal(job.status as JobStatusType)) {
      throw new BizException(ErrorCode.IllegalStateTransition, undefined, '任务已结束，无法取消');
    }
    await this.transition(id, JobStatus.Canceled, { stage: '已取消', finishedAt: new Date() });
    return this.get(userId, id);
  }

  /**
   * 找出"投递丢失"的作业：卡在 queued 过久，说明入队消息没送达队列。
   *
   * 为什么需要（M1-04 验收"Worker 强杀后任务重回队列"的数据库侧防线）：
   *   Redis Stream 的消费组能救回"已投递未确认"的消息，但救不了更早的那一段 ——
   *   ① 进程在 `toolJob.create()` 与 `XADD` 之间被强杀；
   *   ② Redis 本身不可用，队列降级成进程内执行，随后进程重启。
   *   这两种情况下作业会永远停在 queued，前端一直转圈。本方法把这类作业捞回来重投。
   *
   * 代价与取舍：重投会产生**重复消息**，但 `JobRunnerService.handle()` 进执行前会先查状态，
   *   已终态或已在跑的直接跳过，因此重复消息只是白跑一次读取，不会重复执行。
   *   （M1-06 计费也必须按同一前提做幂等，否则重投会重复扣费。）
   */
  async findOrphanQueued(olderThanMs: number, limit = 100): Promise<string[]> {
    const before = new Date(Date.now() - olderThanMs);
    const rows = await this.prisma.toolJob.findMany({
      where: { status: JobStatus.Queued, createdAt: { lt: before } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * 超时扫描：把 running 超时的作业置为 failed。
   * 返回被处理的 Job id，便于调用方（M1-06）据此退回积分。
   *
   * 说明：当前用进程内定时器驱动（见 JobRunnerService），
   * 多实例部署时每个实例都会扫一遍 —— 因为置失败是幂等的（终态不可再流转），重复扫描无害。
   * M1-04 接入 Redis Stream 后应改为带锁的单实例定时任务。
   *
   * ⚠️ `orderBy` 不能省：`take: 200` 是硬上限，无排序时 MySQL 返回哪 200 条**没有保证**。
   * running 一超过 200 条，最老的那批（最该判超时的）就可能永远不在取样窗口里 ——
   * 表现是作业一直转圈，而日志里连一行"超时"都没有。
   * 用 `createdAt` 而非 `startedAt`：后者可能为 null、排序时排在最前，与 `?? createdAt` 的口径对不上。
   */
  async sweepTimeouts(): Promise<string[]> {
    const candidates = await this.prisma.toolJob.findMany({
      where: { status: JobStatus.Running },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: { id: true, toolName: true, startedAt: true, createdAt: true },
    });
    if (candidates.length === 0) return [];

    // 批量预取超时配置：逐条 findUnique 是 N+1（200 条 = 200 次查询），而取值只有个位数
    const tools = await this.prisma.tool.findMany({
      where: { name: { in: [...new Set(candidates.map((j) => j.toolName))] } },
      select: { name: true, timeoutSec: true },
    });
    const timeoutByName = new Map(tools.map((t) => [t.name, t.timeoutSec]));

    const expired: string[] = [];
    for (const job of candidates) {
      const timeoutSec = timeoutByName.get(job.toolName) ?? 300;
      const startedAt = job.startedAt ?? job.createdAt;
      if (Date.now() - startedAt.getTime() <= timeoutSec * 1000) continue;

      await this.fail(job.id, `执行超时（超过 ${timeoutSec} 秒）`);
      expired.push(job.id);
    }

    if (expired.length) this.logger.warn(`超时作业已置为 failed：${expired.length} 个`, 'Job');
    return expired;
  }

  /**
   * 统一出口：先过状态机再落库，杜绝绕过状态机直接写状态。
   *
   * 状态变更成功后在这里做两件"必须且只能做一次"的事：
   *   ① **发事件**（M1-05）—— 分散到各方法里做会漏，漏发的表现是"界面永远不动"，
   *      联调时极易被误判成前端问题；
   *   ② **结清积分**（M1-06）—— 成功转正、失败/取消/拒绝退回。
   *      挂在唯一出口上，就不存在"某条流转路径忘了计费"的可能。
   * 两者都不允许把已经落库的状态改回去，所以内部各自吞错并记日志。
   */
  private async transition(
    id: string,
    to: JobStatusType,
    data: Record<string, unknown>,
  ): Promise<void> {
    const job = await this.prisma.toolJob.findUnique({ where: { id } });
    if (!job) throw new BizException(ErrorCode.NotFound, undefined, '任务不存在');

    const from = job.status as JobStatusType;
    if (from === to) return;
    transitionJob(from, to); // 非法流转在此抛 IllegalTransitionError

    const updated = await this.prisma.toolJob.update({
      where: { id },
      data: { status: to, ...data },
    });

    const snapshot: JobProgressSnapshot = {
      jobId: id,
      status: to,
      progress: updated.progress,
      stage: updated.stage ?? undefined,
      error: updated.error ?? undefined,
    };
    if (isJobTerminal(to)) {
      // 先计费后推送：退费到账的消息应该和"已失败"一起被用户看到，
      // 反过来的话用户会在明细里先看到余额变了、再看到状态变
      await this.billing.onJobTerminal(job.userId, id, to);
      this.events.publishFinished(job.userId, snapshot);
    } else {
      this.events.publishProgress(job.userId, snapshot);
    }
  }
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function toJobItem(j: JobRow): JobItem {
  return {
    id: j.id,
    toolName: j.toolName,
    status: j.status,
    progress: j.progress,
    stage: j.stage ?? undefined,
    cost: j.cost,
    outputFiles: Array.isArray(j.outputFiles) ? (j.outputFiles as string[]) : [],
    error: j.error ?? undefined,
    createdAt: j.createdAt.toISOString(),
    result: asMetrics(j.result),
    qualityScore: j.qualityScore ?? undefined,
    qualityIssues: asStringArray(j.qualityIssues),
  };
}

