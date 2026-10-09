import { describe, expect, it, vi } from 'vitest';

import type { AppLogger } from '../../../common/logger/logger.service';
import { DelayQueueService } from '../delay-queue.service';
import { DistributedLockService } from '../distributed-lock.service';
import { RateLimiterService } from '../rate-limiter.service';
import { RedisService } from '../redis.service';
import type { RedisLike } from '../redis.types';

/**
 * 内存版假 Redis（仅实现 RedisLike 用到的命令）。
 * 目的是让 M0-11 的锁与限流可以在**不起真实 Redis** 的前提下单测。
 */
class FakeRedis implements RedisLike {
  store = new Map<string, string>();
  zsets = new Map<string, Map<string, number>>();
  /** 记录 eval 调用，便于断言"释放锁确实走了 Lua 比较再删" */
  evalCalls: { script: string; args: (string | number)[] }[] = [];
  failNext = false;

  private guard(): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('connection lost');
    }
  }

  async get(key: string): Promise<string | null> {
    this.guard();
    return this.store.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    _mode: 'NX',
    _ttlMode: 'PX',
    _ttl: number,
  ): Promise<string | null> {
    this.guard();
    if (this.store.has(key)) return null; // NX 语义：已存在则不覆盖
    this.store.set(key, value);
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    this.guard();
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }

  async incr(key: string): Promise<number> {
    this.guard();
    const next = Number(this.store.get(key) ?? '0') + 1;
    this.store.set(key, String(next));
    return next;
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    this.guard();
    return 1;
  }

  async pttl(_key: string): Promise<number> {
    this.guard();
    return 60_000;
  }

  /** 按脚本特征分派，模拟本项目用到的三段 Lua */
  async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    this.guard();
    this.evalCalls.push({ script, args });

    if (script.includes("redis.call('get', KEYS[1])")) {
      const [key, token] = args as [string, string];
      if (this.store.get(key) === token) {
        this.store.delete(key);
        return 1;
      }
      return 0;
    }
    if (script.includes('zrangebyscore')) {
      const [key, now, limit] = args as [string, number, number];
      const z = this.zsets.get(key);
      if (!z) return [];
      const due = [...z.entries()].filter(([, s]) => s <= Number(now)).slice(0, Number(limit));
      for (const [m] of due) z.delete(m);
      return due.map(([m]) => m);
    }
    if (script.includes('zcard')) {
      return this.zsets.get(String(args[0]))?.size ?? 0;
    }
    return null;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    this.guard();
    const z = this.zsets.get(key) ?? new Map<string, number>();
    z.set(member, score);
    this.zsets.set(key, z);
    return 1;
  }

  async zrangebyscore(): Promise<string[]> {
    return [];
  }

  async zrem(): Promise<number> {
    return 0;
  }

  async ping(): Promise<string> {
    this.guard();
    return 'PONG';
  }
}

const logger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  verbose: vi.fn(),
} as unknown as AppLogger;

function redisWith(client: FakeRedis | null): RedisService {
  return {
    raw: client,
    available: client !== null,
    status: { available: client !== null, lastError: null },
  } as unknown as RedisService;
}

// ============================================================
// 分布式锁
// ============================================================
describe('DistributedLockService（M0-11 分布式锁）', () => {
  it('抢到锁时执行任务并自动释放', async () => {
    const client = new FakeRedis();
    const lock = new DistributedLockService(redisWith(client), logger);

    const out = await lock.withLock('lock:order:1', 5000, async () => 'done');

    expect(out.acquired).toBe(true);
    expect(out.degraded).toBe(false);
    expect(out.result).toBe('done');
    // 任务结束后锁必须被释放
    expect(client.store.has('lock:order:1')).toBe(false);
  });

  it('锁被占用时不执行任务（acquired=false）', async () => {
    const client = new FakeRedis();
    client.store.set('lock:order:1', 'someone-else'); // 模拟他人持锁
    const lock = new DistributedLockService(redisWith(client), logger);
    const fn = vi.fn(async () => 'should-not-run');

    const out = await lock.withLock('lock:order:1', 5000, fn);

    expect(out.acquired).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('释放锁走 Lua 比较再删，不会误删他人的锁', async () => {
    const client = new FakeRedis();
    const lock = new DistributedLockService(redisWith(client), logger);
    await lock.acquire('lock:order:2', 5000);

    // 模拟锁已超时并被他人抢占
    client.store.set('lock:order:2', 'other-token');
    await lock.release('lock:order:2', 'my-token');

    // 他人的锁必须还在
    expect(client.store.get('lock:order:2')).toBe('other-token');
  });

  it('任务抛错时锁仍会被释放（finally）', async () => {
    const client = new FakeRedis();
    const lock = new DistributedLockService(redisWith(client), logger);

    await expect(
      lock.withLock('lock:order:3', 5000, async () => {
        throw new Error('业务失败');
      }),
    ).rejects.toThrow('业务失败');

    expect(client.store.has('lock:order:3')).toBe(false);
  });

  it('Redis 不可用时降级放行（fail-open，不阻塞主流程）', async () => {
    const lock = new DistributedLockService(redisWith(null), logger);
    const fn = vi.fn(async () => 'ran-without-lock');

    const out = await lock.withLock('lock:order:4', 5000, fn);

    expect(out.acquired).toBe(true);
    expect(out.degraded).toBe(true); // 明确标记"无并发保护"
    expect(out.result).toBe('ran-without-lock');
    expect(fn).toHaveBeenCalledOnce();
  });
});

// ============================================================
// 配额限流
// ============================================================
describe('RateLimiterService（M0-11 限流）', () => {
  it('额度内放行，并正确返回剩余次数', async () => {
    const client = new FakeRedis();
    const limiter = new RateLimiterService(redisWith(client), logger);

    const r1 = await limiter.consume('quota:tool:ocr:user:1', 3, 60);
    const r2 = await limiter.consume('quota:tool:ocr:user:1', 3, 60);

    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);
    expect(r1.degraded).toBe(false);
  });

  it('超过额度后拒绝，remaining 归零', async () => {
    const client = new FakeRedis();
    const limiter = new RateLimiterService(redisWith(client), logger);

    for (let i = 0; i < 3; i++) await limiter.consume('k', 3, 60);
    const over = await limiter.consume('k', 3, 60);

    expect(over.allowed).toBe(false);
    expect(over.remaining).toBe(0);
  });

  it('首次计数时设置过期，保证窗口能自动重置', async () => {
    const client = new FakeRedis();
    const expire = vi.spyOn(client, 'expire');
    const limiter = new RateLimiterService(redisWith(client), logger);

    await limiter.consume('k', 3, 60); // 第 1 次 → 设过期
    await limiter.consume('k', 3, 60); // 第 2 次 → 不重复设

    expect(expire).toHaveBeenCalledTimes(1);
    expect(expire).toHaveBeenCalledWith('k', 60);
  });

  it('peek 只查询不消耗额度', async () => {
    const client = new FakeRedis();
    const limiter = new RateLimiterService(redisWith(client), logger);

    await limiter.consume('k', 5, 60);
    const p1 = await limiter.peek('k', 5, 60);
    const p2 = await limiter.peek('k', 5, 60);

    expect(p1.remaining).toBe(4);
    expect(p2.remaining).toBe(4); // 没有被 peek 消耗
  });

  it('Redis 不可用时降级放行，不把正常用户挡在门外', async () => {
    const limiter = new RateLimiterService(redisWith(null), logger);

    const r = await limiter.consume('k', 1, 60);

    expect(r.allowed).toBe(true);
    expect(r.degraded).toBe(true);
  });

  it('计数过程中连接中断也不抛错（降级）', async () => {
    const client = new FakeRedis();
    const limiter = new RateLimiterService(redisWith(client), logger);
    client.failNext = true;

    const r = await limiter.consume('k', 3, 60);

    expect(r.allowed).toBe(true);
    expect(r.degraded).toBe(true);
  });
});

// ============================================================
// 延迟队列
// ============================================================
describe('DelayQueueService（M0-11 延迟队列）', () => {
  it('到期任务可被取出，未到期的不取', async () => {
    const client = new FakeRedis();
    const q = new DelayQueueService(redisWith(client), logger);

    await q.enqueue('delay:test', { orderId: 'A' }, 0); // 立即到期
    await q.enqueue('delay:test', { orderId: 'B' }, 3_600_000); // 1 小时后

    const items = await q.poll('delay:test', 10);

    expect(items).toHaveLength(1);
    expect(JSON.parse(items[0].payload)).toEqual({ orderId: 'A' });
  });

  it('取出后任务即被移除，不会被重复消费', async () => {
    const client = new FakeRedis();
    const q = new DelayQueueService(redisWith(client), logger);
    await q.enqueue('delay:test', { n: 1 }, 0);

    await q.poll('delay:test', 10);
    const second = await q.poll('delay:test', 10);

    expect(second).toHaveLength(0);
  });

  it('相同载荷在同一毫秒入队不会被去重', async () => {
    const client = new FakeRedis();
    const q = new DelayQueueService(redisWith(client), logger);

    await q.enqueue('delay:test', { same: true }, 0);
    await q.enqueue('delay:test', { same: true }, 0);

    expect(await q.size('delay:test')).toBe(2);
  });

  it('Redis 不可用时入队抛错（延迟任务不可静默丢弃）', async () => {
    const q = new DelayQueueService(redisWith(null), logger);
    await expect(q.enqueue('delay:test', {}, 1000)).rejects.toThrow(/Redis 不可用/);
  });

  it('Redis 不可用时 size 返回 -1，与"真的为空"区分', async () => {
    const q = new DelayQueueService(redisWith(null), logger);
    expect(await q.size('delay:test')).toBe(-1);
  });
});
