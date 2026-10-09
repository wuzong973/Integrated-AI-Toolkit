import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import type { AppConfig } from '../../common/config/configuration';
import { AppLogger } from '../../common/logger/logger.service';

import type {
  RedisLike,
  XAutoClaimParams,
  XAutoClaimResult,
  XPendingParams,
  XPendingEntry,
  XReadGroupParams,
  XReadGroupReply,
} from './redis.types';

/**
 * ioredis 的 Stream 命令句柄。
 *
 * 只声明本项目实际用到的 7 个命令。位置参数与 ioredis 一致（Redis 原生协议顺序），
 * 选项对象 ↔ 位置参数的翻译在 RedisService 里完成，业务层看不到这一层。
 */
interface RedisStreamCommands {
  xadd(key: string, id: string, field: string, value: string): Promise<string | null>;
  xlen(key: string): Promise<number>;
  xgroup(
    subcommand: 'CREATE',
    key: string,
    group: string,
    id: string,
    mkstream: 'MKSTREAM',
  ): Promise<unknown>;
  xreadgroup(
    ...args: ['GROUP', string, string, 'COUNT', number, 'BLOCK', number, 'STREAMS', string, string]
  ): Promise<XReadGroupReply | null>;
  xack(key: string, group: string, ...ids: string[]): Promise<number>;
  xautoclaim(
    key: string,
    group: string,
    consumer: string,
    minIdleMs: number,
    start: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<unknown[]>;
  xpending(
    key: string,
    group: string,
    start: string,
    end: string,
    count: number,
  ): Promise<[id: string, consumer: string, idleMs: number, deliveryCount: number][]>;
}

/**
 * Redis 封装（任务清单 M0-11）
 *
 * 职责：连接与健康状态管理、JSON 缓存读写，并作为锁 / 限流 / 延迟队列的底座。
 *
 * 降级纪律（M0-11 验收要求"Redis 断连时降级不阻塞主流程"）：
 *   · 缓存读   → 返回 null（当作未命中）
 *   · 缓存写删 → 记录告警后跳过
 *   · 锁 / 限流 → 放行（fail-open），打 warn，由调用方按需补偿
 *   · 延迟队列 → 抛错（丢任务比让调用方感知失败更糟）
 * 这条分界的判据是：**降级后是否会静默丢数据**。缓存丢了能重算，锁和限流松一点只是
 * 短暂失去保护；而延迟队列的任务丢了就是真的丢了，必须让调用方知道。
 *
 * 连接策略：lazyConnect + 有限重试 + 关闭离线队列。
 * 关闭离线队列是关键 —— 否则 Redis 不可用时命令会在内存里排队，
 * 表现为"调用一直挂住"而不是"快速失败降级"。
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: Redis | null = null;
  /** 阻塞式读取专用连接（懒建，见 blockingClient 的说明） */
  private blocking: Redis | null = null;
  private ready = false;
  private lastError: string | null = null;
  /** 是否曾经断过（用于区分"首次连接成功"与"断线恢复"，两者日志口径不同） */
  private everDown = false;
  /** 上次告警时间（日志限流用） */
  private lastWarnAt = 0;

  constructor(
    private readonly logger: AppLogger,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const url = this.config.get<AppConfig>('app')?.redis.url;
    if (!url) {
      this.logger.warn('未配置 REDIS_URL，缓存 / 锁 / 限流 / 延迟队列将以降级模式运行', 'Redis');
      return;
    }
    this.connect(url);
  }

  async onModuleDestroy(): Promise<void> {
    // 先关阻塞读连接：它可能正卡在 BLOCK 上，必须先断开才不会拖住停机
    if (this.blocking) {
      const blocking = this.blocking;
      this.blocking = null;
      await blocking.disconnect();
    }
    if (!this.client) return;
    await this.client.quit().catch(() => undefined);
    this.client = null;
    this.ready = false;
    this.logger.log('Redis 连接已关闭', 'Redis');
  }

  /** 连接状态（供 /health 与降级判断使用） */
  get available(): boolean {
    return this.ready && this.client !== null;
  }

  get status(): { available: boolean; lastError: string | null } {
    return { available: this.available, lastError: this.lastError };
  }

  /** 底层客户端；Redis 不可用时返回 null，调用方必须处理 null 分支 */
  get raw(): RedisLike | null {
    return this.client as unknown as RedisLike | null;
  }

  /** 健康检查：真实 ping 一次，并刷新状态 */
  async ping(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.ping();
      this.ready = true;
      this.lastError = null;
      return true;
    } catch (e) {
      this.markDown(e as Error);
      return false;
    }
  }

  /** 读缓存；未命中、值损坏、Redis 不可用统一返回 null */
  async getJson<T>(key: string): Promise<T | null> {
    const client = this.client;
    if (!this.ready || !client) return null;
    try {
      const raw = await client.get(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (e) {
      this.markDown(e as Error);
      return null;
    }
  }

  /** 写缓存；ttlSec 省略表示不过期。失败不抛错 */
  async setJson(key: string, value: unknown, ttlSec?: number): Promise<boolean> {
    const client = this.client;
    if (!this.ready || !client) return false;
    try {
      const payload = JSON.stringify(value);
      if (ttlSec && ttlSec > 0) {
        await client.set(key, payload, 'EX', ttlSec);
      } else {
        await client.set(key, payload);
      }
      return true;
    } catch (e) {
      this.markDown(e as Error);
      return false;
    }
  }

  /** 删缓存（支持批量）；失败不抛错 */
  async del(...keys: string[]): Promise<void> {
    const client = this.client;
    if (!this.ready || !client || keys.length === 0) return;
    try {
      await client.del(...keys);
    } catch (e) {
      this.markDown(e as Error);
    }
  }

  // ---------- Stream 命令（M1-04 队列 Worker） ----------
  // 这些方法**不吞异常**：队列无法降级（消息丢了就是真丢了），
  // Redis 不可用时必须让调用方感知，由调用方决定回退策略。

  /** XADD：追加一条消息，返回消息 id */
  async xadd(stream: string, id: string, field: string, value: string): Promise<string> {
    const cmd = this.streamCommands('XADD');
    const res = await cmd.xadd(stream, id, field, value);
    if (!res) throw new Error(`XADD ${stream} 未返回消息 id`);
    return res;
  }

  /** XLEN：流长度 */
  async xlen(stream: string): Promise<number> {
    return this.streamCommands('XLEN').xlen(stream);
  }

  /**
   * 幂等创建消费组。
   * BUSYGROUP 表示组已存在 —— 这是**正常路径**（多 Worker 同时启动），静默吞掉。
   * `MKSTREAM` 保证流不存在时一并创建，避免首次投递与建组之间的竞态。
   */
  async ensureGroup(stream: string, group: string): Promise<void> {
    const cmd = this.streamCommands('XGROUP');
    try {
      await cmd.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
    } catch (e) {
      if (isBusyGroup(e)) return;
      throw e;
    }
  }

  /** XREADGROUP：读新消息（id='>'）或重读自己未确认的消息（具体 id） */
  async xreadGroup(params: XReadGroupParams): Promise<XReadGroupReply | null> {
    const cmd = await this.blockingClient();
    // 专用连接尚未就绪时返回 null（等同于"暂时没消息"），调用方下一轮重试
    if (!cmd) return null;

    const reply = await cmd.xreadgroup(
      'GROUP',
      params.group,
      params.consumer,
      'COUNT',
      params.count,
      'BLOCK',
      params.blockMs,
      'STREAMS',
      params.stream,
      params.id,
    );
    // 阻塞超时无消息时 ioredis 返回 null
    return reply ?? null;
  }

  /** XACK：确认消息。返回成功确认条数 */
  async xack(stream: string, group: string, ...ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return this.streamCommands('XACK').xack(stream, group, ...ids);
  }

  /** XAUTOCLAIM：认领超时未确认的消息（崩溃 Worker 的恢复手段） */
  async xautoclaim(params: XAutoClaimParams): Promise<XAutoClaimResult> {
    const cmd = this.streamCommands('XAUTOCLAIM');
    const raw = await cmd.xautoclaim(
      params.stream,
      params.group,
      params.consumer,
      params.minIdleMs,
      params.start,
      'COUNT',
      params.count,
    );
    return parseAutoClaimReply(raw);
  }

  /** XPENDING：待确认明细（含投递次数，用于死信判定） */
  async xpendingDetail(params: XPendingParams): Promise<XPendingEntry[]> {
    const cmd = this.streamCommands('XPENDING');
    const rows = await cmd.xpending(
      params.stream,
      params.group,
      params.start,
      params.end,
      params.count,
    );
    return (rows ?? []).map(([id, consumer, idleMs, deliveryCount]) => ({
      id,
      consumer,
      idleMs: Number(idleMs),
      deliveryCount: Number(deliveryCount),
    }));
  }

  // ---------- 内部 ----------

  /**
   * 取 Stream 命令句柄。
   *
   * 为什么不把 ioredis 的重载签名写进 RedisLike：见 redis.types.ts 的说明。
   * 这里做**唯一一处**类型断言，把 ioredis 的位置参数形式适配成选项对象形式，
   * 业务层因此只依赖 RedisLike，单测可注入假实现。
   */
  private streamCommands(op: string): RedisStreamCommands {
    const client = this.client;
    if (!this.ready || !client) {
      throw new Error(`Redis 不可用，无法执行 ${op}`);
    }
    return client as unknown as RedisStreamCommands;
  }

  /**
   * 取**阻塞读专用**连接（懒建）。
   *
   * ## 为什么必须独占一条连接
   *
   * `XREADGROUP ... BLOCK n` 会把整条连接占住 n 毫秒：这期间该连接上后续命令
   * 只能在服务端排队。若与缓存 / 分布式锁 / 限流共用一条连接，一次 BLOCK 2 秒
   * 就会把它们全部拖慢；若与 `enqueue` 共用，用户点"生成 PPT"的接口会莫名多等 2 秒。
   * 这两件事都不报错，只是"变慢"，属于最难查的一类性能问题 —— 所以这里是硬隔离。
   *
   * 用 `duplicate()` 而不是新建实例：继承同一份连接参数（含 retryStrategy、
   * 关闭离线队列等），避免两条连接的行为不一致。
   */
  private async blockingClient(): Promise<RedisStreamCommands | null> {
    if (!this.ready || !this.client) return null;

    if (!this.blocking) {
      const dup = this.client.duplicate({ lazyConnect: true });
      // 必须挂 error 监听：否则连接出错会抛成 unhandled 'error' 事件让进程崩溃
      dup.on('error', (e: Error) => {
        this.logger.warn(`队列阻塞读连接异常：${e.message}`, 'Redis');
      });
      this.blocking = dup;
      await dup.connect().catch(() => undefined);
    }

    return this.blocking.status === 'ready'
      ? (this.blocking as unknown as RedisStreamCommands)
      : null;
  }

  private connect(url: string): void {
    try {
      const client = new Redis(url, {
        lazyConnect: true,
        // 关闭离线队列：不可用时快速失败，而不是把命令挂在内存里
        enableOfflineQueue: false,
        maxRetriesPerRequest: 2,
        // 退避重连，但**永不放弃**。
        // 早期版本在重试 5 次后返回 null 放弃连接，导致"Redis 比 API 晚启动"时
        // 队列会永久停在降级态，必须重启 API 才能恢复 —— 对队列是不可接受的。
        // 改为无上限退避（封顶 5s）+ 日志限流（见 markDown），既不刷屏也能自愈。
        retryStrategy: (times: number) => Math.min(200 * times, 5000),
      });

      client.on('ready', () => {
        const wasDown = !this.ready;
        this.ready = true;
        this.lastError = null;
        this.lastWarnAt = 0;
        this.logger.log(
          wasDown && this.everDown ? 'Redis 连接已恢复' : 'Redis 连接已建立',
          'Redis',
        );
      });
      client.on('error', (e: Error) => this.markDown(e));
      client.on('end', () => {
        this.ready = false;
      });

      this.client = client;
      // 主动连一次；失败只告警，不阻断 API 启动
      void client.connect().catch((e: Error) => {
        this.markDown(e);
        this.logger.warn(`Redis 连接失败，相关能力降级运行。原因：${e.message}`, 'Redis');
      });
    } catch (e) {
      this.markDown(e as Error);
      this.logger.warn(`Redis 初始化失败，相关能力降级运行。原因：${this.lastError}`, 'Redis');
    }
  }

  /**
   * 标记不可用。
   *
   * 日志限流：改为无限重连后，Redis 长期不可用会每几秒触发一次 error 事件；
   * 若每次都写日志，会把真正有价值的日志冲掉。这里 30 秒内只告警一次，
   * 且**状态字段每次都更新**（/health 仍能拿到最新原因）。
   */
  private markDown(e: Error): void {
    this.ready = false;
    this.everDown = true;
    this.lastError = e.message;

    const now = Date.now();
    if (now - this.lastWarnAt < WARN_THROTTLE_MS) return;
    this.lastWarnAt = now;
    this.logger.warn(`Redis 不可用，降级运行。原因：${e.message}`, 'Redis');
  }
}

/** 降级告警的最小间隔，避免无限重连把日志刷满 */
const WARN_THROTTLE_MS = 30_000;

/** BUSYGROUP：消费组已存在（多 Worker 同时建组时的正常竞态） */
function isBusyGroup(e: unknown): boolean {
  const msg = (e as Error)?.message ?? '';
  return msg.includes('BUSYGROUP');
}

/**
 * 解析 XAUTOCLAIM 的回复。
 *
 * 原生回复形状：`[nextCursor, [[id, [field, value, ...]], ...], [deletedId, ...]]`
 * 注意第 3 段在 Redis 6.2 可能缺失，需容错。
 */
function parseAutoClaimReply(raw: unknown[]): XAutoClaimResult {
  const [nextStart, entries, deleted] = raw as [
    string,
    [id: string, fields: string[]][] | null,
    string[] | null,
  ];

  return {
    nextStart: typeof nextStart === 'string' ? nextStart : '0-0',
    messages: (entries ?? []).map(([id, fields]) => ({ id, fields: toFieldMap(fields) })),
    deleted: deleted ?? [],
  };
}

/** 扁平数组 `[k1, v1, k2, v2]` → 对象 */
function toFieldMap(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    out[fields[i]] = fields[i + 1];
  }
  return out;
}
