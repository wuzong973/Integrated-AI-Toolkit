import { Global, Module } from '@nestjs/common';

import { DelayQueueService } from './delay-queue.service';
import { DistributedLockService } from './distributed-lock.service';
import { RateLimiterService } from './rate-limiter.service';
import { RedisService } from './redis.service';

/**
 * Redis 基础设施（任务清单 M0-11）
 *
 * 全局模块：业务模块直接注入 `RedisService` / `DistributedLockService` /
 * `RateLimiterService` / `DelayQueueService`，无需各自 import。
 *
 * 能力边界（各自独立的降级策略见各服务注释）：
 *   RedisService       连接、健康、JSON 缓存
 *   DistributedLockService  分布式锁（fail-open）
 *   RateLimiterService      业务配额限流（fail-open）
 *   DelayQueueService       延迟队列（fail-fast，不丢任务）
 */
@Global()
@Module({
  providers: [RedisService, DistributedLockService, RateLimiterService, DelayQueueService],
  exports: [RedisService, DistributedLockService, RateLimiterService, DelayQueueService],
})
export class RedisModule {}
