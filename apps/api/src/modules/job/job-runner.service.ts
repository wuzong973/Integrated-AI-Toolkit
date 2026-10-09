import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isJobTerminal, type JobStatus, type Providers } from '@qz/core';

import type { AppConfig } from '../../common/config/configuration';
import { AppLogger } from '../../common/logger/logger.service';
import { PROVIDERS } from '../../infra/providers/providers.module';
import { PrismaService } from '../../infra/prisma/prisma.service';

import { JobService } from './job.service';
import { assertResultSane, describeSize, type JobResultMetrics } from './job-result';
import { ToolExecutorService } from './tool-executor.service';

/** 工具作业队列名（M1-04 换成 Redis Stream 时沿用同名） */
export const JOB_QUEUE = 'tool.job';

/** 超时扫描间隔 */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * 作业执行器（任务清单 M1-03 的执行侧，M1-04 接入 Redis Stream）
 *
 * 传输层由 `QueueProvider` 抽象：默认是 Redis Stream（多 Worker 经消费组竞争消费），
 * Redis 不可用时该 Provider 自行降级为进程内执行，**本服务的业务逻辑完全不变**（M1-04 的要求）。
 *
 * 两道"任务不丢"的防线，职责不同、缺一不可：
 *   ① **消息层**（Redis 消费组）：已投递未确认的消息由 XAUTOCLAIM 认领重投
 *      → 覆盖"Worker 执行中被强杀"；
 *   ② **数据层**（本服务的 queued 重投扫描）：卡在 queued 过久的作业重新入队
 *      → 覆盖"入队消息压根没送达"（进程在写库与 XADD 之间被杀、Redis 不可用期间重启）。
 *
 * 两条纪律：
 *   · **幂等**：进入执行前先查状态，已终态直接返回（消息可能重复投递，这是设计前提）；
 *   · **不吞错**：任何异常都要落到 failed 并写原因，避免作业永远卡在 running。
 */
@Injectable()
export class JobRunnerService implements OnModuleInit, OnModuleDestroy {
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    @Inject(PROVIDERS) private readonly providers: Providers,
    private readonly jobs: JobService,
    private readonly executor: ToolExecutorService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    const cfg = this.config.get<AppConfig>('app')!;

    // 注册消费者：Redis Stream 版由消费循环拉取；降级时由 enqueue 直接回调。
    // 并发数从配置读入（验收项"并发数可配置"，见 QUEUE_WORKER_CONCURRENCY）。
    // handle() 返回 boolean（是否真正执行），这里丢弃返回值以满足 handler 的 void 签名
    this.providers.queue.process<{ jobId: string }>(
      JOB_QUEUE,
      async (msg) => {
        await this.handle(msg.payload.jobId);
      },
      { concurrency: cfg.queue.concurrency },
    );

    // 启动即扫一次：把上次进程退出时"投递丢失"的作业补投（否则它们会永远停在 queued）
    void this.recoverOrphanQueued().catch((e: Error) => {
      this.logger.warn(`遗留 queued 作业重投失败：${e.message}`, 'JobRunner');
    });

    // 超时扫描 + 遗留 queued 重投（验收要求"超时任务自动置 failed"）
    this.sweepTimer = setInterval(() => {
      void this.jobs.sweepTimeouts().catch((e: Error) => {
        this.logger.warn(`超时扫描失败：${e.message}`, 'JobRunner');
      });
      void this.recoverOrphanQueued().catch((e: Error) => {
        this.logger.warn(`遗留 queued 作业重投失败：${e.message}`, 'JobRunner');
      });
    }, SWEEP_INTERVAL_MS);
    // 不阻止进程退出
    this.sweepTimer.unref?.();

    this.logger.log(
      `作业执行器已就绪，队列=${describeQueue(this.providers.queue.name, cfg)}；` +
        `已接入工具：${this.executor.supportedTools.join(', ')}`,
      'JobRunner',
    );
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    void this.providers.queue.close?.();
  }

  /**
   * 把作业投递到队列（异步入队）。
   * 传输层由 QueueProvider 决定：Redis Stream 走 XADD，降级时走进程内执行。
   */
  async enqueue(jobId: string): Promise<void> {
    const cfg = this.config.get<AppConfig>('app')!;
    await this.providers.queue.enqueue(
      JOB_QUEUE,
      { jobId },
      { maxAttempts: cfg.queue.maxAttempts },
    );
  }

  /**
   * 重投"投递丢失"的作业（见 JobService.findOrphanQueued 的说明）。
   * 重复投递不会重复执行 —— handle() 进执行前会先查状态。
   */
  async recoverOrphanQueued(): Promise<number> {
    const cfg = this.config.get<AppConfig>('app')!;
    const orphans = await this.jobs.findOrphanQueued(cfg.queue.orphanQueuedMs);
    if (orphans.length === 0) return 0;

    this.logger.warn(
      `发现 ${orphans.length} 个卡在 queued 超过 ${cfg.queue.orphanQueuedMs}ms 的作业，重新投递`,
      'JobRunner',
    );
    for (const jobId of orphans) {
      await this.enqueue(jobId).catch((e: Error) => {
        this.logger.warn(`重投作业失败：${jobId} —— ${e.message}`, 'JobRunner');
      });
    }
    return orphans.length;
  }

  /**
   * 执行一个作业。可被队列消费者或同步路径直接调用。
   * @returns 是否真正执行（false 表示已终态、被跳过）
   */
  async handle(jobId: string): Promise<boolean> {
    const job = await this.prisma.toolJob.findUnique({ where: { id: jobId } });
    if (!job) {
      this.logger.warn(`作业不存在，跳过：${jobId}`, 'JobRunner');
      return false;
    }
    if (isJobTerminal(job.status as JobStatus)) {
      this.logger.log(`作业已是终态（${job.status}），跳过：${jobId}`, 'JobRunner');
      return false;
    }

    // 未接入执行器的工具：直接 rejected（校验未通过，未扣费），不要进入 running 再失败
    if (!this.executor.supports(job.toolName)) {
      await this.jobs.reject(jobId, `工具「${job.toolName}」尚未开放（M1-07~M1-12）`);
      return false;
    }

    try {
      await this.jobs.markRunning(jobId);
      const result = await this.executor.run(job.toolName, {
        jobId,
        userId: job.userId,
        params: asRecord(job.params),
        inputFiles: asStringArray(job.inputFiles),
        onProgress: (progress, stage) => this.jobs.updateProgress(jobId, progress, stage),
      });
      // 后置校验：产出"明显不合理"（空文件、时长为 0）时判失败，
      // 而不是把坏产物当成功交付 —— 这正是"成功但结果不对"的来源。
      const insane = result.metrics ? assertResultSane(result.metrics) : undefined;
      if (insane) {
        await this.jobs.fail(jobId, `产出校验未通过：${insane}`);
        this.logger.warn(`作业产出异常：${jobId}（${job.toolName}）—— ${insane}`, 'JobRunner');
        return false;
      }

      await this.jobs.succeed(jobId, result.outputFiles, undefined, {
        metrics: result.metrics,
        qualityScore: result.qualityScore,
        qualityIssues: result.qualityIssues,
        attempts: result.attempts,
      });
      this.logger.log(
        `作业完成：${jobId}（${job.toolName}）` + describeMetrics(result.metrics),
        'JobRunner',
      );
      return true;
    } catch (e) {
      const message = (e as Error).message || '执行失败';
      this.logger.error(
        `作业失败：${jobId}（${job.toolName}）—— ${message}`,
        undefined,
        'JobRunner',
      );
      // 失败必须落库，否则作业会永远停在 running。
      // ⚠️ 但"置失败"本身也可能失败（DB 抖动/连接中断），所以这个 catch **必须留痕**：
      //    静默吞掉的话，作业就永久卡在 running —— 运维只能看到"这个任务一直在转圈"，
      //    而日志里没有任何线索（孤儿扫描要等很久才会把它捞回来）。
      await this.jobs.fail(jobId, message).catch((failErr: unknown) => {
        this.logger.error(
          `作业置为失败时又失败（将停在 running，等待孤儿扫描兜底）：${jobId} —— ${
            (failErr as Error)?.message ?? '未知错误'
          }`,
          undefined,
          'JobRunner',
        );
      });
      return false;
    }
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** 启动日志里描述队列形态（Mock 与真实队列的排障线索完全不同，必须写清楚） */
function describeQueue(name: string, cfg: AppConfig): string {
  if (name === 'mock-queue') return '进程内（MockQueue，未启用 Redis Stream）';
  return (
    `${name}（并发 ${cfg.queue.concurrency}，最多投递 ${cfg.queue.maxAttempts} 次，` +
    `认领阈值 ${cfg.queue.claimIdleMs}ms）`
  );
}

/** 把产出指标压成一行日志，便于在日志里直接看出「这次产出好不好」 */
function describeMetrics(m?: JobResultMetrics): string {
  if (!m) return '';
  const parts: string[] = [];
  if (m.kind === 'image' || m.kind === 'media' || m.kind === 'pdf') {
    const size = describeSize(m);
    if (size) parts.push(size);
  }
  if (m.kind === 'media') parts.push(...describeMedia(m));
  if (m.kind === 'content') parts.push(...describeContent(m));
  return parts.length ? ` ｜ ${parts.join(' ')}` : '';
}

function describeMedia(m: Extract<JobResultMetrics, { kind: 'media' }>): string[] {
  const out: string[] = [];
  if (m.durationSec !== undefined) out.push(`${m.durationSec.toFixed(1)}s`);
  if (m.encoder) out.push(`编码器=${m.encoder}`);
  return out;
}

function describeContent(m: Extract<JobResultMetrics, { kind: 'content' }>): string[] {
  const out: string[] = [];
  if (m.chars !== undefined) out.push(`${m.chars} 字`);
  if (m.pages !== undefined) out.push(`${m.pages} 页`);
  if (m.layoutKinds !== undefined) out.push(`${m.layoutKinds} 种版式`);
  return out;
}
