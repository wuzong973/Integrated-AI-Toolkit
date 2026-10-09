import { Injectable } from '@nestjs/common';

import { AppLogger } from '../../common/logger/logger.service';

import { RedisService } from './redis.service';

/** 释放锁的 Lua：比较 token 再删，避免删掉别人的锁 */
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

/** withLock 的返回：acquired=false 表示没抢到锁，此时不会执行 fn */
export interface LockOutcome<T> {
  acquired: boolean;
  result?: T;
  /** 是否因 Redis 不可用而降级放行（此时 acquired=true 但没有任何保护） */
  degraded: boolean;
}

/**
 * 分布式锁（任务清单 M0-11）
 *
 * 使用 SET key token NX PX ttl 抢锁，释放用 Lua 做"比较再删除"，
 * 避免 A 的锁超时后 B 抢到、A 却把 B 的锁删掉这类经典问题。
 *
 * 降级：Redis 不可用时**放行**（fail-open）并打 warn。
 * 理由：M0-11 明确要求"Redis 断连时降级不阻塞主流程"。
 * 代价是这段时间失去并发保护，因此**调用方必须保证业务本身幂等**——
 * 锁是性能与体验优化，不是正确性的唯一防线（数据库唯一约束才是）。
 */
@Injectable()
export class DistributedLockService {
  constructor(
    private readonly redis: RedisService,
    private readonly logger: AppLogger,
  ) {}

  /** 抢锁：成功返回 token，失败返回 null */
  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const client = this.redis.raw;
    if (!client) return null;
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const res = await client.set(key, token, 'NX', 'PX', ttlMs);
      return res === 'OK' ? token : null;
    } catch (e) {
      this.logger.warn(`获取锁失败（${key}）：${(e as Error).message}`, 'Lock');
      return null;
    }
  }

  /** 释放锁：只有 token 匹配才删，避免误删他人锁 */
  async release(key: string, token: string): Promise<void> {
    const client = this.redis.raw;
    if (!client) return;
    try {
      await client.eval(RELEASE_SCRIPT, 1, key, token);
    } catch (e) {
      this.logger.warn(`释放锁失败（${key}）：${(e as Error).message}`, 'Lock');
    }
  }

  /**
   * 抢到锁则执行 fn 并自动释放；没抢到直接返回 acquired=false。
   * Redis 不可用时降级放行（degraded=true）。
   */
  async withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<LockOutcome<T>> {
    const client = this.redis.raw;

    if (!client) {
      this.logger.warn(`Redis 不可用，锁 ${key} 降级放行（无并发保护）`, 'Lock');
      return { acquired: true, degraded: true, result: await fn() };
    }

    const token = await this.acquire(key, ttlMs);
    if (token === null) return { acquired: false, degraded: false };

    try {
      return { acquired: true, degraded: false, result: await fn() };
    } finally {
      await this.release(key, token);
    }
  }
}
