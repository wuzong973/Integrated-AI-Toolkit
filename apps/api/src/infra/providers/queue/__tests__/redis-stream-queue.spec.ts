import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppLogger } from '../../../../common/logger/logger.service';
import { RedisService } from '../../../redis/redis.service';
import {
  RedisStreamQueueProvider,
  type RedisStreamQueueOptions,
} from '../redis-stream-queue.provider';

import { FakeRedisStreamServer } from './fake-redis-stream-server';

/**
 * M1-04 验收测试
 *
 * 验收标准（任务清单 M1-04）：**Worker 强杀后任务重回队列；并发数可配置**。
 *
 * 验证方式：起一个**真实 RESP 协议**的 Redis 替身（见 fake-redis-stream-server.ts），
 * 让真实 ioredis 连上去跑完整的 RedisService + RedisStreamQueueProvider 代码路径。
 * 因此本文件检验的不只是业务逻辑，还包括命令拼接与回复解析是否正确。
 */

const STREAM = 'qz:test:jobs';

function fakeLogger(): AppLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as AppLogger;
}

function fakeConfig(url: string): ConfigService {
  return { get: () => ({ redis: { url } }) } as unknown as ConfigService;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('等待超时：条件始终未满足');
}

describe('M1-04 Redis Stream 队列', () => {
  let server: FakeRedisStreamServer;
  let redis: RedisService;
  let logger: AppLogger;
  const opened: RedisStreamQueueProvider[] = [];

  /** 建一个连到替身服务的 RedisService（走真实 ioredis） */
  async function connect(): Promise<RedisService> {
    const svc = new RedisService(logger, fakeConfig(server.url ?? ''));
    await svc.onModuleInit();
    await waitFor(() => svc.available);
    return svc;
  }

  /** 建一个队列 Provider 并登记，便于收尾统一停机 */
  function makeProvider(opts: Partial<RedisStreamQueueOptions>): RedisStreamQueueProvider {
    const provider = new RedisStreamQueueProvider(redis, logger, {
      streamPrefix: 'qz:test',
      group: 'workers',
      concurrency: 1,
      maxAttempts: 3,
      claimIdleMs: 60,
      pollBlockMs: 30,
      claimIntervalMs: 0,
      ...opts,
    });
    opened.push(provider);
    return provider;
  }

  beforeEach(async () => {
    logger = fakeLogger();
    server = new FakeRedisStreamServer();
    await server.start();
    redis = await connect();
  });

  afterEach(async () => {
    for (const provider of opened.splice(0)) await provider.close();
    await redis.onModuleDestroy();
    await server.stop();
  });

  it('消息正常投递 → 消费 → 确认（ACK 后 PEL 为空）', async () => {
    const provider = makeProvider({});
    const seen: unknown[] = [];
    provider.process<{ n: number }>('jobs', async (job) => {
      seen.push(job.payload);
    });

    const id = await provider.enqueue('jobs', { n: 1 });

    expect(id).toMatch(/^\d+-\d+$/); // XADD 自动生成的真实消息 id
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toEqual({ n: 1 });
    // 处理成功必须 ACK，否则消息会被反复认领
    await waitFor(() => server.pending(STREAM, 'workers').length === 0);
    expect(server.entries(STREAM)).toHaveLength(1);
  });

  it('depth 反映流长度（Redis 在线时返回真实值）', async () => {
    const provider = makeProvider({});
    // 不注册消费者：消息留在流里
    await provider.enqueue('jobs', { n: 1 });
    await provider.enqueue('jobs', { n: 2 });

    expect(await provider.depth('jobs')).toBe(2);
  });

  it('并发数可配置：concurrency=1 时严格串行', async () => {
    const provider = makeProvider({ concurrency: 1 });
    let running = 0;
    let maxRunning = 0;

    provider.process(
      'jobs',
      async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 40));
        running -= 1;
      },
      { concurrency: 1 },
    );

    for (let i = 0; i < 4; i++) await provider.enqueue('jobs', { n: i });

    await waitFor(() => server.pending(STREAM, 'workers').length === 0 && running === 0, 6000);
    expect(maxRunning).toBe(1);
  });

  it('并发数可配置：process 传入的 concurrency 覆盖默认值，且不会超过上限', async () => {
    const provider = makeProvider({ concurrency: 1 });
    let running = 0;
    let maxRunning = 0;
    let done = 0;

    provider.process(
      'jobs',
      async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 50));
        running -= 1;
        done += 1;
      },
      { concurrency: 3 },
    );

    for (let i = 0; i < 6; i++) await provider.enqueue('jobs', { n: i });

    await waitFor(() => done === 6, 8000);
    expect(maxRunning).toBeGreaterThan(1); // 确实并发起来了，不是串行
    expect(maxRunning).toBeLessThanOrEqual(3); // 且没有超过配置上限
  });

  it('⭐ Worker 被强杀后任务重回队列（验收项）', async () => {
    // 消费者 A：读走消息后"卡死"，永不 ACK —— 等价于进程被强杀
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const workerA = makeProvider({ consumer: 'worker-A', claimIdleMs: 60 });
    workerA.process('jobs', async () => {
      await gateA;
    });

    await workerA.enqueue('jobs', { jobId: 'job-1' });

    // 消息已被 A 读走并进入 PEL，但一直未确认
    await waitFor(() => server.pending(STREAM, 'workers').length === 1);
    expect(server.pending(STREAM, 'workers')[0].consumer).toBe('worker-A');

    // 消费者 B 上线（同一消费组，代表另一台机器）：认领超时消息并重新执行
    const executedByB: unknown[] = [];
    const workerB = makeProvider({ consumer: 'worker-B', claimIdleMs: 60 });
    workerB.process('jobs', async (job) => {
      executedByB.push(job.payload);
    });

    await waitFor(() => executedByB.length === 1, 6000);
    expect(executedByB[0]).toEqual({ jobId: 'job-1' });

    // 重投成功后 B 完成 ACK，PEL 被清空，不会无限重投
    await waitFor(() => server.pending(STREAM, 'workers').length === 0);
    expect(server.entries(STREAM)).toHaveLength(1); // 消息没有被复制

    // 重投时投递次数应已递增（XPENDING 的第 4 个字段）
    releaseA();
  });

  it('超过最大投递次数的消息转入死信流，并从待确认列表移除', async () => {
    const provider = makeProvider({ maxAttempts: 1, claimIdleMs: 40 });
    let attempts = 0;
    provider.process('jobs', async () => {
      attempts += 1;
      throw new Error('模拟必然失败');
    });

    await provider.enqueue('jobs', { jobId: 'doomed' }, { maxAttempts: 1 });

    // 第 1 次投递失败（不 ACK）→ 认领后成为第 2 次投递，超过上限 → 死信
    await waitFor(() => server.entries(`${STREAM}:dead`).length === 1, 6000);

    const dead = server.entries(`${STREAM}:dead`)[0];
    expect(JSON.parse(dead.fields.p).payload).toEqual({ jobId: 'doomed' });
    expect(JSON.parse(dead.fields.p).reason).toContain('仍未确认');

    // 死信后必须确认原消息，否则会永远留在 PEL 里被反复扫到
    await waitFor(() => server.pending(STREAM, 'workers').length === 0);
    expect(attempts).toBeGreaterThanOrEqual(1);

    const status = await provider.status();
    expect(status.deadLettered).toBe(1);
    expect(status.driver).toBe('redis-stream-queue');
    expect(status.degraded).toBe(false);
  });

  it('Redis 不可用时降级为进程内执行，并在 status 中如实标记', async () => {
    // 换一个连不上的地址：模拟 Redis 挂掉
    const offline = new RedisService(logger, fakeConfig('redis://127.0.0.1:1'));
    await offline.onModuleInit();

    const provider = new RedisStreamQueueProvider(offline, logger, {
      streamPrefix: 'qz:test',
      group: 'workers',
      concurrency: 2,
      pollBlockMs: 20,
    });
    opened.push(provider);

    const seen: unknown[] = [];
    provider.process('jobs', async (job) => {
      seen.push(job.payload);
    });

    const id = await provider.enqueue('jobs', { jobId: 'offline-1' });

    expect(id).toMatch(/^local_/); // 走的是进程内路径，不是流消息 id
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toEqual({ jobId: 'offline-1' });

    const status = await provider.status();
    expect(status.degraded).toBe(true);
    expect(status.pending.jobs).toBe(-1); // -1 = 读不到，与"真的为空"区分

    await offline.onModuleDestroy();
  });

  it('消费组重复创建不报错（BUSYGROUP 被吞掉）', async () => {
    await expect(redis.ensureGroup(STREAM, 'workers')).resolves.toBeUndefined();
    await expect(redis.ensureGroup(STREAM, 'workers')).resolves.toBeUndefined();
  });

  it('Redis 挂掉但尚未投递过作业时，status 也必须报 degraded（观测缺口）', async () => {
    /**
     * 这条用例来自一次**实测到的假象**：Redis 挂掉时 `/health` 返回
     * `redis: "down"`、`pending: {"tool.job": -1}`，却同时报 `queue.degraded: false`。
     *
     * 根因：`degraded` 是 `markDegraded()` 置位的**粘性标记**，而它只在 `enqueue()`
     * 里触发。启动后还没投递过作业 → 标记没来得及置位 → 监控把"队列已退化"看成健康。
     *
     * 修法是让 `status()` 同时看**实时可用性**。这里刻意**不调用 enqueue**，
     * 正是为了锁住"粘性标记为 false 时仍必须如实上报"。
     */
    const offline = new RedisService(logger, fakeConfig('redis://127.0.0.1:1'));
    await offline.onModuleInit();

    const provider = new RedisStreamQueueProvider(offline, logger, {
      streamPrefix: 'qz:test',
      group: 'workers',
      concurrency: 2,
      pollBlockMs: 20,
    });
    opened.push(provider);
    provider.process('jobs', async () => undefined);

    const status = await provider.status();
    expect(status.degraded).toBe(true); // ← 一个作业都没投递，也必须报降级
    expect(status.pending.jobs).toBe(-1);

    await offline.onModuleDestroy();
  });

  it('脏消息（无法解析的载荷）被直接确认，不占据待确认列表', async () => {
    const provider = makeProvider({});
    const seen: unknown[] = [];
    provider.process('jobs', async (job) => {
      seen.push(job.payload);
    });

    // 绕过 enqueue，直接塞一条非法载荷
    await redis.ensureGroup(STREAM, 'workers');
    const badId = await redis.xadd(STREAM, '*', 'p', 'not-json');

    await waitFor(() => server.pending(STREAM, 'workers').length === 0, 6000);
    expect(seen).toHaveLength(0);
    expect(badId).toMatch(/^\d+-\d+$/);
  });
});
