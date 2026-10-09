import { hostname } from 'node:os';

import type { QueueJob, QueueProvider, QueueStatus } from '@qz/core';

import type { AppLogger } from '../../../common/logger/logger.service';
import type { RedisService } from '../../redis/redis.service';

import { DEAD_SUFFIX, PAYLOAD_FIELD, type QueueMessageBody } from './queue-message';
import { RedisStreamConsumer } from './redis-stream-consumer';

/** 装配参数 */
export interface RedisStreamQueueOptions {
  /** 流名前缀；队列 `tool.job` 的流名为 `${streamPrefix}:tool.job` */
  streamPrefix: string;
  /** 消费组名。同一组内的 Worker 竞争消费；换组名等于换一批互不相干的消费者 */
  group: string;
  /** 消费者名；默认 `主机名-pid`，便于在 XPENDING 里认出是哪台机器卡住了 */
  consumer?: string;
  /** 单队列并发数 */
  concurrency: number;
  /** 最大投递次数，超过进死信队列 */
  maxAttempts: number;
  /** 认领空闲阈值（毫秒）：超过该时长未确认视为消费者已失联 */
  claimIdleMs: number;
  /** XREADGROUP 阻塞毫秒数（同时决定循环的让步粒度） */
  pollBlockMs: number;
  /** 认领（XAUTOCLAIM）扫描间隔（毫秒） */
  claimIntervalMs: number;
}

/**
 * Redis Stream 队列（任务清单 M1-04）
 *
 * 本类只做**生产者侧与队列管理**：
 *   · 把消息 XADD 进流（或延迟投递）；
 *   · 按队列名管理消费者实例（`RedisStreamConsumer`，消费侧逻辑全在那里）；
 *   · 汇报队列状态给 /health。
 *
 * ## 降级：Redis 不可用时回退进程内执行，但绝不静默
 *
 * 判据沿用 M0-11 定的那条：**降级后是否会静默丢数据**。
 * 这里会丢消息本身（进程重启后待确认列表里的待办就没了），所以补了两道防线：
 *   ① 打 warn + 在 /health 的 `queue.degraded` 里暴露，让运维看得见；
 *   ② 作业侧另有"queued 超时重投"扫描（`JobRunnerService.recoverOrphanQueued`），
 *      消息丢了也能从数据库把作业捞回来。
 * 因此降级是"功能不中断 + 状态可见 + 数据可补偿"，而不是掩盖失败。
 */
export class RedisStreamQueueProvider implements QueueProvider {
  readonly name = 'redis-stream-queue';

  private readonly consumers = new Map<string, RedisStreamConsumer>();
  /**
   * 待触发的延迟消息定时器。
   *
   * 必须持有引用才能 `close()` 时清掉 —— 否则进程已经关停了，
   * 这些定时器还会各自 `enqueue()` 一票消息（`unref()` 只保证不阻塞退出，
   * 不保证不执行）。
   */
  private readonly delayTimers = new Set<NodeJS.Timeout>();
  private readonly consumerName: string;
  private readonly opts: RedisStreamQueueOptions;
  /** 是否处于降级（有消息落到进程内执行） */
  private degraded = false;
  private closed = false;

  constructor(
    private readonly redis: RedisService,
    private readonly logger: AppLogger,
    opts: Partial<RedisStreamQueueOptions> = {},
  ) {
    this.opts = {
      streamPrefix: opts.streamPrefix ?? 'qz:queue',
      group: opts.group ?? 'workers',
      consumer: opts.consumer,
      concurrency: opts.concurrency ?? 2,
      maxAttempts: opts.maxAttempts ?? 3,
      claimIdleMs: opts.claimIdleMs ?? 60_000,
      pollBlockMs: opts.pollBlockMs ?? 1_000,
      claimIntervalMs: opts.claimIntervalMs ?? 30_000,
    };
    // 消费者名带主机名与 pid：XPENDING 里能直接看出是哪台机器的哪个进程卡住了
    this.consumerName = opts.consumer ?? `${hostname()}-${process.pid}`;
  }

  /** 消费者名（暴露给日志与排查） */
  get consumerId(): string {
    return this.consumerName;
  }

  /** 投递一条消息；Redis 不可用时回退进程内执行 */
  async enqueue<T>(
    name: string,
    payload: T,
    opts?: { delayMs?: number; maxAttempts?: number },
  ): Promise<string> {
    const consumer = this.ensureConsumer(name);
    const body: QueueMessageBody = {
      name,
      payload,
      maxAttempts: opts?.maxAttempts ?? this.opts.maxAttempts,
      attempts: 0,
      enqueuedAt: Date.now(),
    };

    // 延迟消息：Redis Stream 没有原生延迟投递，这里由本进程定时器补。
    // 局限必须写明：进程崩溃会丢延迟消息 —— 需要强可靠的定时场景请走
    // DelayQueueService（ZSET 持久化，不可用时 fail-fast）。
    // 除了写在注释里，还必须**在日志里可见**（红线 9/10）：否则运维只看到
    // "某个延迟重投没发生"，却不知道它走的是不可靠通道。
    if (opts?.delayMs && opts.delayMs > 0) {
      this.logger.warn(
        `延迟消息由进程内定时器投递（不持久，进程重启即丢）：${name} +${opts.delayMs}ms`,
        'Queue',
      );
      const timer = setTimeout(() => {
        this.delayTimers.delete(timer);
        // 关闭过程中不再投递：否则 shutdown 之后还会有消息被塞进队列
        if (this.closed) return;
        void this.enqueue(name, payload, { ...opts, delayMs: 0 });
      }, opts.delayMs);
      timer.unref?.();
      this.delayTimers.add(timer);
      return `delayed_${Date.now()}`;
    }

    if (this.redis.available) {
      try {
        await this.redis.ensureGroup(consumer.stream, this.opts.group);
        return await this.redis.xadd(consumer.stream, '*', PAYLOAD_FIELD, JSON.stringify(body));
      } catch (e) {
        this.markDegraded((e as Error).message);
      }
    } else {
      this.markDegraded('Redis 不可用');
    }

    consumer.runLocally(body);
    return `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /** 注册消费者，并为该队列启动消费循环 */
  process<T>(
    name: string,
    handler: (job: QueueJob<T>) => Promise<void>,
    opts?: { concurrency?: number },
  ): void {
    const consumer = this.ensureConsumer(name);
    consumer.addHandler(handler as (job: QueueJob<unknown>) => Promise<void>);
    if (opts?.concurrency && opts.concurrency > 0) consumer.setConcurrency(opts.concurrency);
    consumer.start();
  }

  /**
   * 队列积压量：流长度（含已投递未确认的，口径与"待处理"一致）。
   * Redis 不可用时返回 -1，与"真的为空"区分。
   */
  async depth(name: string): Promise<number> {
    if (!this.redis.available) return -1;
    const stream = this.consumers.get(name)?.stream ?? this.streamOf(name);
    return this.streamLength(stream);
  }

  /** 读流长度；读不到返回 -1（与"真的为空"区分） */
  private async streamLength(stream: string): Promise<number> {
    try {
      return await this.redis.xlen(stream);
    } catch {
      return -1;
    }
  }

  /** 队列运行状态（供 /health 使用） */
  async status(): Promise<QueueStatus> {
    const pending: Record<string, number> = {};
    let deadLettered = 0;

    for (const name of this.consumers.keys()) {
      pending[name] = await this.depth(name);
      // 死信数**从 Redis 读**而不是记在内存里：
      // 内存计数一重启就归零，而"有多少消息卡进死信"恰恰是重启后才最需要知道的。
      const dead = await this.streamLength(`${this.streamOf(name)}${DEAD_SUFFIX}`);
      deadLettered += dead;
    }

    return {
      driver: this.name,
      /**
       * 降级判定 = 粘性标记 **或** 当前 Redis 不可用。
       *
       * ⚠️ 不能只信粘性标记。`markDegraded` 只在 `enqueue()` 里触发，
       * 于是"Redis 挂了但启动后还没投递过作业"时 `degraded` 恒为 `false` ——
       * 实测过这个假象：`redis: "down"`、`pending: {"tool.job": -1}`（读不到），
       * 却同时报 `degraded: false`。监控会据此判定队列健康。
       *
       * 两个条件是**互补**的：
       * - 粘性标记覆盖"曾经失败过"（哪怕 Redis 后来恢复了，也说明发生过丢消息风险）；
       * - 实时可用性覆盖"现在就是坏的"（粘性标记还没来得及置位）。
       */
      degraded: this.degraded || !this.redis.available,
      pending,
      // 有一条死信流读不到时整体标为 -1，避免把"读不全"误报成"很少"
      deadLettered: deadLettered < 0 ? -1 : deadLettered,
    };
  }

  /** 优雅停机：停止消费循环（在途消息不打断，交由下次认领重投） */
  async close(): Promise<void> {
    this.closed = true;
    for (const consumer of this.consumers.values()) consumer.stop();
    this.consumers.clear();
    // 连同未触发的延迟消息一起收掉：这些定时器只是"本进程的临时补丁"，
    // 关停后再各自 enqueue 一批消息，等于在无人消费的队列里堆垃圾
    for (const timer of this.delayTimers) clearTimeout(timer);
    this.delayTimers.clear();
  }

  // ---------- 内部 ----------

  /** 取（或建）某队列的消费者 */
  private ensureConsumer(name: string): RedisStreamConsumer {
    let consumer = this.consumers.get(name);
    if (!consumer) {
      consumer = new RedisStreamConsumer(this.redis, this.logger, {
        group: this.opts.group,
        consumer: this.consumerName,
        stream: this.streamOf(name),
        concurrency: this.opts.concurrency,
        maxAttempts: this.opts.maxAttempts,
        claimIdleMs: this.opts.claimIdleMs,
        pollBlockMs: this.opts.pollBlockMs,
        claimIntervalMs: this.opts.claimIntervalMs,
      });
      this.consumers.set(name, consumer);
    }
    return consumer;
  }

  /** 队列名 → 流名。用 `:` 分隔，与 Redis 常规命名一致，`SCAN qz:queue:*` 可枚举 */
  private streamOf(name: string): string {
    return `${this.opts.streamPrefix}:${name}`;
  }

  private markDegraded(reason: string): void {
    if (this.degraded || this.closed) return;
    this.degraded = true;
    this.logger.warn(
      `队列降级为进程内执行（${reason}）。消息不会进 Redis Stream，` +
        `多实例部署下退化为单机队列；作业侧仍由「queued 超时重投」兜底。`,
      'Queue',
    );
  }
}
