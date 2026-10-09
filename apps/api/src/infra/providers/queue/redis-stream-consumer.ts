import type { QueueJob } from '@qz/core';

import type { AppLogger } from '../../../common/logger/logger.service';
import type { RedisService } from '../../redis/redis.service';
import type { XStreamMessage } from '../../redis/redis.types';

import {
  DEAD_SUFFIX,
  PAYLOAD_FIELD,
  parseQueueMessage,
  sleep,
  toFieldMap,
  type QueueMessageBody,
} from './queue-message';

/** 降级（不走 Redis）时的让步间隔 */
const SLOT_WAIT_MS = 20;

/** 读取失败后的退避基数（指数增长，封顶 5s） */
const READ_ERROR_BACKOFF_MS = 200;

/** 读取失败退避上限 */
const MAX_BACKOFF_MS = 5_000;

/** 单次认领扫描的条数 */
const CLAIM_BATCH = 10;

/** 一条队列的消费参数 */
export interface ConsumerOptions {
  group: string;
  consumer: string;
  stream: string;
  concurrency: number;
  maxAttempts: number;
  claimIdleMs: number;
  pollBlockMs: number;
  claimIntervalMs: number;
}

/**
 * 单条队列的消费者（M1-04）
 *
 * ## 至少一次投递，靠消费组而非自研锁
 *
 * 消息读走后进入 PEL（待确认列表），只有 handler 成功才 XACK。
 * 进程被强杀时消息留在 PEL，空闲超过 `claimIdleMs` 后被其他 Worker 认领 ——
 * 这就是验收要求的"Worker 强杀后任务重回队列"。
 * **重复投递是设计前提，业务必须幂等**（作业侧已在进执行前查状态，终态直接跳过）。
 *
 * ## 并发控制
 *
 * 槽位由 `inFlight` 计数：只有还有空槽才继续读，读的条数不超过空槽数。
 * 因此慢任务不会把消息全吸进内存，且天然形成背压（消息留在流里而不是堆在进程里）。
 *
 * ## 死信而非无限重试
 *
 * 投递次数（XPENDING 的第 4 个字段）超过 `maxAttempts` 的消息转入 `${stream}:dead` 并 XACK。
 * 否则一条必然失败的消息会被永久反复认领，把 Worker 拖住。
 */
export class RedisStreamConsumer {
  private readonly handlers: ((job: QueueJob<unknown>) => Promise<void>)[] = [];
  private readonly options: ConsumerOptions;
  /** 已启动的消费循环 */
  private loop: Promise<void> | null = null;
  /** 惰性建组：只做一次，失败后置空以便重试 */
  private groupReady: Promise<void> | null = null;
  /** 上次认领扫描时间 */
  private lastClaimAt = 0;
  /** 连续读取失败次数（用于退避） */
  private readErrors = 0;
  /** 当前在途（已读取未执行完）的消息数 —— 并发控制的核心计数 */
  private inFlight = 0;
  private closed = false;

  constructor(
    private readonly redis: RedisService,
    private readonly logger: AppLogger,
    options: ConsumerOptions,
  ) {
    this.options = options;
  }

  get stream(): string {
    return this.options.stream;
  }

  /** 当前配置的并发数 */
  get concurrency(): number {
    return this.options.concurrency;
  }

  /** 覆盖并发数（来自 process() 的 opts） */
  setConcurrency(value: number): void {
    if (value > 0) this.options.concurrency = value;
  }

  addHandler(handler: (job: QueueJob<unknown>) => Promise<void>): void {
    this.handlers.push(handler);
  }

  /** 启动消费循环（幂等） */
  start(): void {
    if (this.loop) return;
    this.loop = this.run().catch((e: Error) => {
      this.logger.error(`消费循环异常退出（${this.stream}）：${e.message}`, undefined, 'Queue');
    });
  }

  stop(): void {
    this.closed = true;
  }

  /**
   * 降级路径：不走 Redis，直接把消息交给本进程的 handler。
   *
   * 不 await：保持与 MockQueue 一致的"入队即返回"语义，
   * 否则工具调用接口会被执行耗时拖住（用户提交后台任务却要等到跑完才拿到响应）。
   */
  runLocally(body: QueueMessageBody): void {
    void this.executeLocally(body);
  }

  // ---------- 消费循环 ----------

  private async run(): Promise<void> {
    while (!this.closed) {
      if (!this.redis.available) {
        // Redis 不可用时不空转读写；降级消息由 Provider 直接走 runLocally
        await sleep(this.options.pollBlockMs);
        continue;
      }

      const slots = this.options.concurrency - this.inFlight;
      if (slots <= 0) {
        await sleep(SLOT_WAIT_MS);
        continue;
      }

      try {
        await this.ensureGroup();
        const reply = await this.redis.xreadGroup({
          group: this.options.group,
          consumer: this.options.consumer,
          count: slots,
          blockMs: this.options.pollBlockMs,
          stream: this.stream,
          id: '>',
        });
        this.readErrors = 0;

        if (!reply || reply.length === 0 || reply[0][1].length === 0) {
          await this.reclaim();
          continue;
        }

        for (const [id, flat] of reply[0][1]) {
          await this.accept(id, toFieldMap(flat)[PAYLOAD_FIELD]);
        }
      } catch (e) {
        await this.backoff(e as Error);
      }
    }
  }

  /** 读取失败后指数退避，避免 Redis 抖动时的忙等 */
  private async backoff(e: Error): Promise<void> {
    this.readErrors += 1;
    const wait = Math.min(READ_ERROR_BACKOFF_MS * 2 ** (this.readErrors - 1), MAX_BACKOFF_MS);
    this.logger.warn(
      `队列读取失败（${this.stream}，第 ${this.readErrors} 次）：${e.message}，${wait}ms 后重试`,
      'Queue',
    );
    await sleep(wait);
  }

  /** 收到一条新消息：解析 → 分发；脏消息直接确认掉 */
  private async accept(id: string, raw: string | undefined): Promise<void> {
    const body = parseQueueMessage(raw);
    if (!body) {
      this.logger.warn(`队列消息无法解析，已丢弃：${this.stream} ${id}`, 'Queue');
      await this.redis.xack(this.stream, this.options.group, id).catch(() => undefined);
      return;
    }
    this.dispatch(id, body);
  }

  /**
   * 消费一条消息：成功才 XACK；失败保持不确认，交给认领机制重投。
   * 用 `void` 而非 `await` 是为了让循环立刻回到读取状态（并发由 inFlight 约束）。
   */
  private dispatch(id: string, body: QueueMessageBody): void {
    this.inFlight += 1;
    void this.deliver(body, id)
      .then(() => this.redis.xack(this.stream, this.options.group, id))
      .catch((e: Error) => {
        this.logger.warn(
          `消息处理失败，等待重投（${this.stream} ${id}，第 ${body.attempts + 1} 次）：${e.message}`,
          'Queue',
        );
      })
      .finally(() => {
        this.inFlight -= 1;
      });
  }

  /** 降级路径的执行（等空槽 → 执行 → 释放槽位） */
  private async executeLocally(body: QueueMessageBody): Promise<void> {
    while (!this.closed && this.inFlight >= this.options.concurrency) {
      await sleep(SLOT_WAIT_MS);
    }
    this.inFlight += 1;
    try {
      await this.deliver(body, null);
    } catch (e) {
      // 降级路径没有 PEL 可依赖，只能记录；
      // 作业侧的状态落库与超时扫描是这种情况下的最终防线
      this.logger.error(
        `进程内执行失败（${body.name}）：${(e as Error).message}`,
        undefined,
        'Queue',
      );
    } finally {
      this.inFlight -= 1;
    }
  }

  /** 依次执行该队列的所有 handler */
  private async deliver(body: QueueMessageBody, messageId: string | null): Promise<void> {
    const job: QueueJob<unknown> = {
      id: messageId ?? `local_${body.enqueuedAt}`,
      name: body.name,
      payload: body.payload,
      attempts: body.attempts,
      maxAttempts: body.maxAttempts,
    };
    for (const handler of this.handlers) {
      await handler(job);
    }
  }

  // ---------- 认领与死信 ----------

  /**
   * 认领扫描：把其他（已失联）消费者遗留的待确认消息收回来重投。
   * 仅在空闲时触发，且受 `claimIntervalMs` 节流。
   */
  private async reclaim(): Promise<void> {
    const now = Date.now();
    if (now - this.lastClaimAt < this.options.claimIntervalMs) return;
    this.lastClaimAt = now;

    let cursor = '0-0';
    do {
      const res = await this.redis.xautoclaim({
        stream: this.stream,
        group: this.options.group,
        consumer: this.options.consumer,
        minIdleMs: this.options.claimIdleMs,
        start: cursor,
        count: CLAIM_BATCH,
      });

      // 内容已不存在的条目必须 ACK 清理，否则会永远留在 PEL 里被反复扫到
      if (res.deleted.length > 0) {
        await this.redis.xack(this.stream, this.options.group, ...res.deleted);
      }
      for (const message of res.messages) {
        await this.resume(message);
      }
      cursor = res.nextStart;
    } while (cursor !== '0-0' && !this.closed);
  }

  /** 处理一条被认领回来的消息：超限则进死信，否则重投 */
  private async resume(message: XStreamMessage): Promise<void> {
    const body = parseQueueMessage(message.fields[PAYLOAD_FIELD]);
    if (!body) {
      await this.redis.xack(this.stream, this.options.group, message.id);
      return;
    }

    // 用 XPENDING 明细拿真实投递次数：认领本身已使计数 +1
    const pending = await this.redis.xpendingDetail({
      stream: this.stream,
      group: this.options.group,
      start: message.id,
      end: message.id,
      count: 1,
    });
    const deliveryCount = pending[0]?.deliveryCount ?? 1;
    const maxAttempts = body.maxAttempts || this.options.maxAttempts;

    if (deliveryCount > maxAttempts) {
      await this.deadLetter(message.id, body, deliveryCount, maxAttempts);
      return;
    }

    this.logger.warn(
      `认领超时消息并重投（${this.stream} ${message.id}，已投递 ${deliveryCount}/${maxAttempts} 次）`,
      'Queue',
    );
    this.dispatch(message.id, { ...body, attempts: deliveryCount });
  }

  /**
   * 转入死信流并确认原消息。
   *
   * 死信流不设消费组：它的用途是**留证待人工处理**，而不是继续自动重试。
   * 以后若要做自动重放，再单独建一个消费组即可。
   */
  private async deadLetter(
    id: string,
    body: QueueMessageBody,
    deliveryCount: number,
    maxAttempts: number,
  ): Promise<void> {
    const reason = `投递 ${deliveryCount} 次仍未确认（上限 ${maxAttempts}）`;
    try {
      await this.redis.xadd(
        `${this.stream}${DEAD_SUFFIX}`,
        '*',
        PAYLOAD_FIELD,
        JSON.stringify({ ...body, deliveryCount, maxAttempts, deadAt: Date.now(), reason }),
      );
      this.logger.error(
        `消息转入死信（${this.stream}${DEAD_SUFFIX} ${id}）：${reason}`,
        undefined,
        'Queue',
      );
    } finally {
      // 无论死信写入是否成功都要确认原消息：
      // 写入失败时消息会留在 PEL，下一轮认领会再次尝试死信，因此不会丢。
      await this.redis.xack(this.stream, this.options.group, id).catch(() => undefined);
    }
  }

  /** 惰性建组（幂等）；失败后置空以便下一轮重试 */
  private async ensureGroup(): Promise<void> {
    if (!this.groupReady) {
      this.groupReady = this.redis
        .ensureGroup(this.stream, this.options.group)
        .catch((e: Error) => {
          this.groupReady = null;
          throw e;
        });
    }
    await this.groupReady;
  }
}
