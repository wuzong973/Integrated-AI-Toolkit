import { Injectable } from '@nestjs/common';

import { AppLogger } from '../../common/logger/logger.service';

import { RedisService } from './redis.service';
import type { RateLimitResult } from './redis.types';

/**
 * 业务配额限流（任务清单 M0-11）
 *
 * 与 HTTP 限流的区别：
 *   · `ThrottlerGuard`（app.module.ts）按客户端 IP 限的是"接口调用频率"，防刷；
 *   · 本服务按**业务主体**限的是"配额"，例如"某用户今天最多调 20 次抠图"。
 * 两者并存，各管一层。
 *
 * 算法：固定窗口计数（INCR + EXPIRE）。
 * 已知取舍：窗口边界上最多可能放过 2 倍配额（如 60s 窗口在 59s 与 61s 各打满一次）。
 * 对"每日工具配额"这类场景完全够用；若将来需要严格平滑，换成令牌桶（Lua 实现）。
 *
 * 降级：Redis 不可用时**放行**并打 warn —— 配额是成本控制手段，
 * 不该因为它不可用就把正常用户挡在门外（成本超支可在告警后人工处理）。
 */
@Injectable()
export class RateLimiterService {
  constructor(
    private readonly redis: RedisService,
    private readonly logger: AppLogger,
  ) {}

  /**
   * 消耗一次配额。
   * @param key    业务维度键，如 `quota:tool:remove_background:user:<id>:20260917`
   * @param limit  窗口内允许次数
   * @param windowSec 窗口长度（秒）
   */
  async consume(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
    const client = this.redis.raw;
    if (!client) {
      this.logger.warn(`Redis 不可用，配额 ${key} 降级放行`, 'RateLimit');
      return degraded(limit);
    }

    try {
      const count = await client.incr(key);
      // 首次计数时设置过期，保证窗口会自动重置
      if (count === 1) await client.expire(key, windowSec);
      const ttl = await client.pttl(key);
      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        resetInMs: ttl > 0 ? ttl : windowSec * 1000,
        degraded: false,
      };
    } catch (e) {
      this.logger.warn(`配额计数失败（${key}）：${(e as Error).message}，降级放行`, 'RateLimit');
      return degraded(limit);
    }
  }

  /** 只查询不消耗（用于展示"今日剩余次数"） */
  async peek(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
    const client = this.redis.raw;
    if (!client) return degraded(limit);

    try {
      const raw = await client.get(key);
      const used = raw === null ? 0 : Number(raw);
      const ttl = await client.pttl(key);
      return {
        allowed: used < limit,
        remaining: Math.max(0, limit - used),
        resetInMs: ttl > 0 ? ttl : windowSec * 1000,
        degraded: false,
      };
    } catch (e) {
      this.logger.warn(`配额查询失败（${key}）：${(e as Error).message}`, 'RateLimit');
      return degraded(limit);
    }
  }

  /** 手动重置配额（后台运维用） */
  async reset(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

function degraded(limit: number): RateLimitResult {
  return { allowed: true, remaining: limit, resetInMs: 0, degraded: true };
}
