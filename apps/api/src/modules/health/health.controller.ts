import { Controller, Get, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Providers, QueueStatus } from '@qz/core';

import type { AppConfig } from '../../common/config/configuration';
import { Public } from '../../common/decorators';
import { collectDegradations, type Degradation } from '../../common/utils/degradations';
import { PROVIDERS } from '../../infra/providers/providers.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { JobEventsService } from '../job/job-events.service';
import { JobProgressGateway } from '../job/job-progress.gateway';

/**
 * 健康检查（任务清单 M0-15）
 * 返回服务状态、版本、Provider 模式与各依赖可用性。
 *
 * 豁免限流：健康检查是监控/编排系统的基础设施流量（docker healthcheck、探针、CI 冒烟），
 * 被限流会造成"服务不健康"的误报；且它是无副作用的只读接口，没有刷的必要。
 * 保留它的意义在于：即便业务接口被限流，健康检查仍能如实反映服务状态。
 */
@SkipThrottle()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly progress: JobProgressGateway,
    private readonly jobEvents: JobEventsService,
    @Inject(PROVIDERS) private readonly providers: Providers,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: '健康检查' })
  async check() {
    const app = this.config.get<AppConfig>('app')!;
    const [dbOk, redisOk] = await Promise.all([this.prisma.ping(), this.redis.ping()]);
    const queue = await this.queueStatus();

    const mockProviders = Object.values(this.providers)
      .filter((p) => (p as { name?: string })?.name?.startsWith('mock-'))
      .map((p) => (p as { name: string }).name);

    /**
     * 服务层降级点（红线 10 的补充）。
     *
     * 与 `mockProviders` 互补：那个只看 Provider 装配层，看不到"微信登录未配 AppSecret
     * → 返回伪 openid"这类降级。两者合并才是完整的降级面，
     * 且与 `MockMarkerMiddleware` 用的是**同一份判定函数**，不会出现两处口径不一致。
     */
    const degradations = collectDegradations({
      wechatSecretConfigured: !!app.wechat.secret,
      wechatDevLogin: app.wechat.devLogin,
    });

    return {
      /**
       * 顶层状态（三态，M0-11 判据）。
       *
       * ⚠️ 这里**不能**恒为 'ok' —— 曾经如此，导致 Redis 挂掉、队列降级为进程内执行时
       * `/health` 仍报 'ok'，监控/告警完全漏报（见排查报告 P0-2）。
       * 口径：
       * - `down`     —— 数据库不可用。API 的核心数据功能已不可用，属硬故障。
       * - `degraded` —— 能提供数据功能，但有依赖在降级运行（Redis 缺失 / 队列退化为进程内）。
       * - `ok`       —— 全部依赖正常。
       *
       * HTTP 状态码**刻意保持 200**：本接口是"状态报告"而非"准入闸门"。
       * 返回 503 会让 `scripts/dev/smoke.mjs` 等以 2xx 为判据的冒烟脚本在降级环境下
       * 直接判失败，从而掩盖"降级仍可用"这一事实；调用方应当读 `status` 字段而非状态码。
       */
      status: resolveHealthStatus({
        dbOk,
        redisOk,
        queueDegraded: queue.degraded,
        degradationCount: degradations.length,
      }),
      /** 降级原因清单（空数组 = 无降级）；供运维一眼定位，避免只看到一个 degraded 猜原因 */
      degradedReasons: buildDegradedReasons({ dbOk, redisOk, queueDegraded: queue.degraded, degradations }),
      version: app.version,
      env: app.env,
      providerMode: app.providerMode,
      dependencies: {
        database: dbOk ? 'up' : 'down',
        ...(dbOk ? {} : { databaseError: this.prisma.status.lastError }),
        // Redis 是可选依赖：不可用时缓存/锁/限流降级、延迟队列不可用，
        // 但 API 仍可提供数据功能，故不影响"能否提供服务"，只影响顶层 status 的档位。
        redis: redisOk ? 'up' : 'down',
        ...(redisOk ? {} : { redisError: this.redis.status.lastError }),
      },
      /**
       * 队列状态（M1-04）。
       * Redis 不可用时队列会**降级为进程内执行**：功能不中断，但分布式语义消失、
       * 且进程重启会丢队列里的待办（由 queued 重投扫描兜底）。
       * 这种"能用但不对"的状态必须让运维看得见，所以单独暴露而不是藏在 mockProviders 里。
       */
      queue,
      /**
       * 实时通道状态（M1-05）。
       * WebSocket 只是"更快"，不是权威来源 —— 权威始终是 HTTP 接口。
       * 因此连接数为 0 不算异常，只是说明当前没人订阅推送。
       */
      realtime: {
        path: '/ws',
        connections: this.progress.connectionCount,
        subscribers: this.jobEvents.subscriberCount,
      },
      mockProviders,
      /** 服务层降级点（非 Provider 形态）。空数组 = 无此类降级 */
      degradations,
      time: new Date().toISOString(),
    };
  }

  /**
   * 队列状态；Provider 未实现 status() 时给出最小信息。
   *
   * 注意：`status()` 是**可选**能力（`QueueProvider.status?`），未实现的 Provider 走
   * 第 102 行分支，此时 `degraded` 一律按 **true** 计 —— 因为"读不到队列状态"
   * 与"队列健康"是两件事，宁可误报降级（运维去看一眼）也不能漏报（静默丢任务）。
   */
  private async queueStatus(): Promise<QueueHealth> {
    const queue = this.providers.queue;
    if (!queue.status) return { driver: queue.name, degraded: true, pending: {} };
    try {
      return await queue.status();
    } catch (e) {
      return { driver: queue.name, degraded: true, pending: {}, error: (e as Error).message };
    }
  }
}

/**
 * 队列状态 + 读取失败原因。
 * 不复用 `QueueStatus` 直接返回，是因为读 `status()` 失败时也要给出 `degraded: true`
 * （见 `queueStatus()` 注释），此时 `pending` 只能给空对象。
 */
export interface QueueHealth extends QueueStatus {
  error?: string;
}

/**
 * 顶层状态三态判定（M0-11）。
 * - 数据库挂 → `down`（硬故障，核心数据功能已中断）
 * - Redis 挂 / 队列降级 / **有服务层降级** → `degraded`（能提供数据功能，但依赖在降级运行）
 * - 否则 → `ok`
 *
 * ⚠️ `degradationCount` 曾经**没被算进来**，于是出现过这种自相矛盾的响应：
 * `status: 'ok'` + `degradedReasons: []` + `degradations: [wechat-login]`。
 * 那正是 P0-2 要根治的"该报 degraded 时报了 ok" —— 微信登录在返回**伪 openid**，
 * 而监控看到的却是绿灯。降级面只要非空，顶层就不允许是 `ok`。
 */
export function resolveHealthStatus(input: {
  dbOk: boolean;
  redisOk: boolean;
  queueDegraded: boolean;
  degradationCount: number;
}): 'ok' | 'degraded' | 'down' {
  if (!input.dbOk) return 'down';
  if (!input.redisOk || input.queueDegraded || input.degradationCount > 0) return 'degraded';
  return 'ok';
}

/**
 * 汇总降级原因。抽成纯函数是为了能单测（见 health-status.spec.ts）——
 * 这段逻辑的 bug 形态是"该报 degraded 时报了 ok"，正是监控漏报的成因。
 *
 * `degradations` 逐条平铺而不合并成一句，是为了让运维一眼看出**有几个降级点**，
 * 而不是看到一句"存在服务层降级"再去猜是哪一个。
 */
export function buildDegradedReasons(input: {
  dbOk: boolean;
  redisOk: boolean;
  queueDegraded: boolean;
  degradations: readonly Degradation[];
}): string[] {
  const reasons: string[] = [];
  if (!input.dbOk) reasons.push('数据库不可用：核心数据功能已中断');
  if (!input.redisOk) reasons.push('Redis 不可用：缓存/锁/限流降级，延迟队列不可用');
  if (input.queueDegraded) {
    reasons.push('作业队列降级为进程内执行：无跨进程并发控制，进程重启会丢队列待办');
  }
  for (const d of input.degradations) reasons.push(`服务层降级「${d.name}」：${d.reason}`);
  return reasons;
}
