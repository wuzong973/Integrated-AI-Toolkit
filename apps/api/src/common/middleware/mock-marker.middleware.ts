import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import type { Providers } from '@qz/core';
import { summarizeMocks } from '@qz/core';

import type { AppConfig } from '../config/configuration';
import { collectDegradations } from '../utils/degradations';
import { PROVIDERS } from '../../infra/providers/providers.module';

/**
 * Mock 标记中间件（任务清单 M0-08，红线 10）
 *
 * 作用：只要本次请求**可能产出演示数据**，就打 `X-Provider: mock`，
 *       前端据此显示"演示模式"角标。
 *
 * ⚠️ 标记面 = `summarizeMocks().flags`（会影响响应真实性的 Mock）
 *          **∪** `routeScopedMockNames()`（本路由真的会走到的"整期未接入"能力）
 *          **∪** `degradations`（服务层降级）。
 * 只看第一项会漏掉"微信登录未配 AppSecret → 伪 openid"这类降级 ——
 * 它不在 `Providers` 聚合里，却同样是在用假数据冒充功能。
 *
 * ## 为什么不再用 `anyMockProvider()` 做判定（排查报告 P1-8）
 *
 * `pay` / `notify` 是**整期未接入**的常量级 Mock（M5-07 正式支付、M3-19 订阅消息未开工），
 * 于是 `anyMockProvider()` **恒为 true** → 每个响应都带角标 → 连真实 LLM 生成的
 * PPT 也被标成"演示模式"。角标一旦恒亮就不再传递信息，甚至把真的说成假的。
 *
 * 现在拆成两条通道：
 *   · 真会走到未接入能力的**那几条路由**（`pay` 的 prepay / refund / 回调）由
 *     `routeScopedMockNames()` 按路由打角标 —— 该标的照标，不靠"全局恒亮"实现；
 *   · 其余请求不再被牵连，而"哪些能力未接入"改为 `X-Provider-Not-Integrated`
 *     每个响应都如实告知，并在 `/health` 的 `mockProviders` 里持续可见。
 */
@Injectable()
export class MockMarkerMiddleware implements NestMiddleware {
  constructor(
    @Inject(PROVIDERS) private readonly providers: Providers,
    private readonly config: ConfigService,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const { flags, notIntegrated } = summarizeMocks(this.providers);

    // 全局 Mock（影响本次响应真实性）+ 本路由专属的"未接入能力"
    const mockNames = [...flags, ...routeScopedMockNames(req.originalUrl)];
    const degraded = this.degradations();
    const hasMock = mockNames.length > 0 || degraded.length > 0;

    res.setHeader('X-Provider-Mode', hasMock ? 'mock-present' : 'real');
    if (hasMock) {
      res.setHeader('X-Provider', 'mock');
      // 两个头**刻意分开**：`X-Mock-Providers` 只放 Provider 名（历史语义，别混入服务名），
      // 服务层降级放 `X-Degradations`，各自可被独立解析。
      if (mockNames.length) res.setHeader('X-Mock-Providers', mockNames.join(','));
      if (degraded.length) res.setHeader('X-Degradations', degraded.join(','));
    }

    // 与角标**刻意分开**：整期未接入的能力在每个响应上都可见，
    // 但它不代表"你这次看到的数据是假的"，所以不点亮角标。
    if (notIntegrated.length) {
      res.setHeader('X-Provider-Not-Integrated', notIntegrated.join(','));
    }
    next();
  }

  /** 服务层降级点名称（供响应头与 /health 共用同一份判定） */
  private degradations(): string[] {
    const wechat = this.config.get<AppConfig>('app')?.wechat;
    return collectDegradations({
      wechatSecretConfigured: !!wechat?.secret,
      wechatDevLogin: !!wechat?.devLogin,
    }).map((d) => d.name);
  }
}

/**
 * 会真正调用 `mock-pay` 的路由（M5-07 未开工；`OrderPayService` 的三处调用点）。
 *
 * 为什么按路由判定而不是全局：角标的语义是"**这一次**的响应里有没有假数据"，
 * 而"支付没接"只对这三条路径成立。全局标记会把这条信息变成一个常量。
 *
 * ⚠️ 用 `originalUrl` 而不是 `path`：中间件挂在 `*` 上，此刻尚未经过路由匹配，
 *    只有 `originalUrl` 是完整的（含 `/api/v1` 全局前缀）。
 */
const PAY_ROUTES: readonly RegExp[] = [
  // POST /orders/:id/pay
  /\/orders\/[^/?]+\/pay(?:\?|$)/,
  // POST /orders/pay/notify（网关回调）
  /\/orders\/pay\/notify(?:\?|$)/,
  // POST /orders/:id/refund
  /\/orders\/[^/?]+\/refund(?:\?|$)/,
];

/** 本路由会走到的"整期未接入"能力 */
function routeScopedMockNames(url: string): string[] {
  return PAY_ROUTES.some((re) => re.test(url)) ? ['mock-pay'] : [];
}
