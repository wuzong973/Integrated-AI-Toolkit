import { Injectable } from '@nestjs/common';
import { BizException, ErrorCode, type InvokeToolDto } from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import { RateLimiterService } from '../../infra/redis/rate-limiter.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { BillingService } from '../billing/billing.service';
import { JobService } from '../job/job.service';
import { JobRunnerService } from '../job/job-runner.service';
import { ToolExecutorService } from '../job/tool-executor.service';
/** 调用结果（对齐 apps/mp/utils/api.ts 的 invoke 返回） */
export interface InvokeResult {
  jobId: string;
  status: string;
  /** 同步执行完成时直接带回结果，省一次轮询 */
  result?: { outputFiles: string[] };
  /** 命中幂等键时为 true（未重复执行） */
  reused?: boolean;
}

/**
 * 工具调用入口（任务清单 M1-02，预扣接入见 M1-06）
 *
 * 校验顺序（顺序即优先级，越靠前越"便宜"，避免为必然失败的请求做多余工作）：
 *   ① 工具存在且已上线（status=active）
 *   ② 已接入执行器
 *   ③ 涉版权工具必须声明（文档 6.7.2，服务端二次校验，不信任前端）
 *   ④ 每日配额（复用 M0-11 的 RateLimiterService）
 *   ⑤ 幂等键（唯一索引兜底并发）
 *   ⑥ 建 Job → **预扣积分** → 同步直接执行 / 异步入队
 *
 * 注意：**建 Job 之前的任何失败都抛异常，不产生作业记录**；
 * 进入执行阶段才失败则落 failed（有记录可追溯、可退费）。
 *
 * ⚠️ 与文档 6.11 的措辞差异（有意为之）：文档写"预扣积分 → 建 job"，
 *    这里顺序反过来。原因是流水必须带 `ref_id` 才可对账，而 jobId 在建作业之前不存在；
 *    若用幂等键当 ref_id，则同一作业的多次重试会散在多个键上，反而对不上账。
 *    把预扣放在建作业之后就消除了这个问题 —— 预扣失败时作业会被置为 `rejected`
 *    （校验未通过、未扣费），用户仍能在执行记录里看到它并知道原因。
 */
@Injectable()
export class ToolInvokeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobService,
    private readonly runner: JobRunnerService,
    private readonly executor: ToolExecutorService,
    private readonly rateLimiter: RateLimiterService,
    private readonly billing: BillingService,
    private readonly logger: AppLogger,
  ) {}

  async invoke(
    userId: string,
    toolName: string,
    dto: InvokeToolDto,
    idempotencyKey?: string,
  ): Promise<InvokeResult> {
    const tool = await this.prisma.tool.findUnique({ where: { name: toolName } });
    if (!tool) {
      throw new BizException(ErrorCode.NotFound, undefined, `工具不存在：${toolName}`);
    }

    assertAvailable(tool.status, tool.displayName);
    assertSupported(this.executor.supports(toolName), tool.displayName);
    assertCopyright(tool.requiresCopyrightAck, dto.copyrightAck, tool.displayName);

    await this.consumeQuota(userId, toolName, tool.dailyQuota, tool.displayName);

    const { job, reused } = await this.jobs.create({
      userId,
      toolName,
      params: dto.params,
      inputFiles: dto.fileIds,
      idempotencyKey,
      runId: dto.runId,
      nodeId: dto.nodeId,
      cost: tool.price,
    });

    // 命中幂等键：直接返回既有作业状态，**绝不重复执行、也绝不重复预扣**
    if (reused) {
      this.logger.log(`幂等命中，复用作业 ${job.id}（${toolName}）`, 'ToolInvoke');
      return { jobId: job.id, status: job.status, reused: true };
    }

    await this.holdPoints(userId, job.id, tool.price, tool.displayName);

    if (dto.async) {
      await this.enqueue(job.id);
      return { jobId: job.id, status: job.status };
    }

    // 同步路径：直接执行完再返回，省去前端轮询
    await this.runner.handle(job.id);
    const finished = await this.jobs.get(userId, job.id);
    return {
      jobId: finished.id,
      status: finished.status,
      ...(finished.outputFiles.length > 0 ? { result: { outputFiles: finished.outputFiles } } : {}),
    };
  }

  /**
   * 预扣积分；余额不足则把作业置为 `rejected` 并抛 403。
   *
   * 为什么置 rejected 而不是删掉作业：用户需要看到"我提交过、因为积分不够没跑"，
   * 否则会出现"点了没反应"的经典困惑。`rejected` 在状态机里的语义正是
   * "校验未通过、未扣费"，且它是终态，不会再被 worker 捡起来执行。
   */
  private async holdPoints(
    userId: string,
    jobId: string,
    cost: number,
    displayName: string,
  ): Promise<void> {
    try {
      await this.billing.hold(userId, jobId, cost, `「${displayName}」预扣`);
    } catch (e) {
      await this.jobs
        .reject(jobId, e instanceof BizException ? e.message : '积分不足，未开始执行')
        .catch(() => undefined);
      throw e;
    }
  }

  /** 入队；队列不可用时把作业置 failed，避免留在 queued 无人处理 */
  private async enqueue(jobId: string): Promise<void> {
    try {
      await this.runner.enqueue(jobId);
    } catch (e) {
      const message = `任务入队失败：${(e as Error).message}`;
      this.logger.error(message, undefined, 'ToolInvoke');
      await this.jobs.fail(jobId, message).catch(() => undefined);
      throw new BizException(ErrorCode.QueueBusy, undefined, '任务队列繁忙，请稍后重试');
    }
  }

  /** 每日配额；dailyQuota<=0 表示不限 */
  private async consumeQuota(
    userId: string,
    toolName: string,
    dailyQuota: number,
    displayName: string,
  ): Promise<void> {
    if (dailyQuota <= 0) return;

    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const key = `quota:tool:${toolName}:user:${userId}:${day}`;
    const result = await this.rateLimiter.consume(key, dailyQuota, 86_400);

    if (!result.allowed) {
      throw new BizException(
        ErrorCode.DailyQuotaExceeded,
        { limit: dailyQuota },
        `「${displayName}」今日可用次数已用完，明天再来`,
      );
    }
  }
}

/** 未上线工具明确拒绝，而不是让它进入执行再失败 */
function assertAvailable(status: string, displayName: string): void {
  if (status !== 'active') {
    throw new BizException(
      ErrorCode.NotFound,
      { status },
      `「${displayName}」正在建设中，敬请期待`,
    );
  }
}

function assertSupported(supported: boolean, displayName: string): void {
  if (!supported) {
    throw new BizException(
      ErrorCode.NotFound,
      undefined,
      `「${displayName}」尚未开放（执行器接入中）`,
    );
  }
}

/** 涉版权工具必须由用户显式确认（服务端二次校验，不信任前端传值） */
function assertCopyright(required: boolean, acked: boolean, displayName: string): void {
  if (required && !acked) {
    throw new BizException(
      ErrorCode.CopyrightAckRequired,
      { tool: displayName },
      '该工具仅限处理你拥有版权的内容，请先勾选声明',
    );
  }
}
