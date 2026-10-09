import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BizException, ErrorCode } from '@qz/core';

import type { AppConfig } from '../../common/config/configuration';
import { AppLogger } from '../../common/logger/logger.service';

/** code2Session 响应 */
interface Code2SessionResult {
  openid?: string;
  unionid?: string;
  session_key?: string;
  errcode?: number;
  errmsg?: string;
}

export interface WechatIdentity {
  openid: string;
  unionid?: string;
}

/**
 * 测试夹具 code 的前缀（`verify:*` 脚本靠它换 token，见 `scripts/dev/dev-login.mjs`）。
 *
 * 微信真实 code 是 32 位字母数字串、不含冒号，所以带这个前缀的 code **只可能**来自脚本。
 * 两侧各有一份字面量（TS 与 mjs 无法共用模块），由 `wechat.service.spec.ts` 做漂移守卫。
 */
export const DEV_LOGIN_CODE_PREFIX = 'qz-dev:';

/**
 * 微信服务（任务清单 M0-16）
 *
 * ## 三条身份来源，判据各不相同
 *
 * | 通道 | 条件 | 算不算降级 |
 * |---|---|---|
 * | 真实 `code2Session` | 配了 appid + secret 且 `WECHAT_DEV_LOGIN=false` | 否 |
 * | 开发模式（伪 openid） | `WECHAT_DEV_LOGIN=true` **或** 没配 secret | **是**，进 `X-Degradations` |
 * | 测试夹具 | code 以 `qz-dev:` 开头且非生产 | 否（真实登录仍在工作） |
 *
 * 开发模式用的是确定性的伪 openid（`dev_` + code 的哈希），保证本地可登录、可重复登录同一账号。
 * 这是**显式的开发期降级**。
 *
 * ⚠️ 标记机制在**别处**，别以为改这里就够了：
 * `MockMarkerMiddleware` 会把 `wechat-login` 写进 `X-Provider: mock` / `X-Degradations`，
 * `/health` 的 `degradations` 也会列出它（两处共用 `collectDegradations()`，口径一致）。
 * 之所以不在本服务里直接设响应头：这里拿不到 `Response` 对象，
 * 而且"哪些能力在降级"应当由**一个地方**统一计算，否则迟早出现两处口径不一致。
 *
 * ## 未配置时的可见性
 *
 * 启动时打一条 warn（而不是每次登录都打）—— 每次登录都打会把日志刷满，
 * 反而让人忽略它；启动一次则不可能看不到。
 */
@Injectable()
export class WechatService implements OnModuleInit {
  constructor(
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
  ) {}

  private get cfg(): AppConfig['wechat'] {
    return this.config.get<AppConfig>('app')!.wechat;
  }

  /** 是否配置了真实微信凭证 */
  get isConfigured(): boolean {
    return !!(this.cfg.appid && this.cfg.secret);
  }

  /**
   * 本次登录是否走开发模式的伪 openid。
   *
   * 与 `isConfigured` **刻意分开**：误开 `WECHAT_DEV_LOGIN` 时即使配了真 Secret 也走 dev，
   * 没配 Secret 则**一定**走 dev。`WECHAT_DEV_LOGIN` 在生产环境已被 `buildWechat` 强制关掉。
   *
   * ⚠️ 它和下面的夹具通道不是一回事：这里开着 = **登录整体是假的**，必须记进 degradations；
   * 本地正常形态是这里 false（真实登录）+ 下面那条窄通道供脚本取 token。
   */
  get useDevLogin(): boolean {
    return this.cfg.devLogin || !this.isConfigured;
  }

  /**
   * 本次 code 是否是脚本用的测试夹具（仅非生产、且带 `qz-dev:` 前缀）。
   *
   * 与 `useDevLogin` 的区别很关键：devLogin 是**整体降级**（任何 code 都给伪身份，
   * 登录这件事本身是假的，必须记进 degradations）；夹具通道只在真实登录已接通时
   * 放行一小撮 unmistakable 的测试 code，真实用户走的仍是真 `code2Session`，
   * 所以**不算降级**、不进 `X-Degradations`。
   */
  get fixtureLoginEnabled(): boolean {
    return this.cfg.fixtureLogin;
  }

  isFixtureCode(code: string): boolean {
    return this.fixtureLoginEnabled && code.startsWith(DEV_LOGIN_CODE_PREFIX);
  }

  /**
   * 启动自检：把"登录正在用伪 openid"这件事喊出来。
   *
   * 为什么必须是启动日志而不是登录时的 warn：登录是高频路径，
   * 每次都打会淹没在噪音里；而这件事一旦被忽略，
   * 后果是"上线后换上真 AppSecret，所有用户账号对不上"。
   */
  onModuleInit(): void {
    if (this.useDevLogin) {
      const prefix = this.isConfigured
        ? 'WECHAT_DEV_LOGIN=true：已配置真实 AppSecret，但登录仍走开发模式（伪 openid）'
        : '未配置 WECHAT_SECRET：登录走开发模式，openid 是按 code 哈希出来的**伪值**';
      this.logger.warn(
        `${prefix}，不是真实微信身份。响应会带 X-Provider: mock（红线 10），` +
          '/health 的 degradations 也会列出。' +
          '真机联调与上线前必须关闭该开关并填入真实 AppSecret（微信公众平台 → 开发管理 → 开发设置）。',
        'Wechat',
      );
      return;
    }
    // 真实登录已接通：只报一条信息，说明脚本用的夹具通道在开着。
    if (this.fixtureLoginEnabled) {
      this.logger.log(
        `真实微信登录已接通；测试夹具通道开启（仅 ${DEV_LOGIN_CODE_PREFIX}* 这类 code 走伪 openid，` +
          '供 verify:* 脚本取 token；小程序真实 code 不受影响，生产会关闭）',
        'Wechat',
      );
    }
  }

  /** code 换取 openid / unionid */
  async code2Session(code: string): Promise<WechatIdentity> {
    if (this.useDevLogin || this.isFixtureCode(code)) {
      return { openid: `dev_${stableHash(code)}` };
    }

    const url = new URL(this.cfg.code2SessionUrl);
    url.searchParams.set('appid', this.cfg.appid);
    url.searchParams.set('secret', this.cfg.secret);
    url.searchParams.set('js_code', code);
    url.searchParams.set('grant_type', 'authorization_code');

    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const data = (await res.json()) as Code2SessionResult;

    if (data.errcode || !data.openid) {
      throw new BizException(
        ErrorCode.Unauthorized,
        { errcode: data.errcode, errmsg: data.errmsg },
        WX_LOGIN_HINTS[data.errcode ?? 0] ?? `微信登录失败：${data.errmsg ?? '未知错误'}`,
      );
    }

    return { openid: data.openid, unionid: data.unionid };
  }
}

/**
 * 微信登录 errcode → 用户能照着做的下一步。
 *
 * 真实登录接通后，微信的原始 `errmsg`（`invalid code, rid: 6a…`）会顺着
 * `微信登录失败：…` 一路弹到用户脸上 —— 那是给排查用的字符串，不是提示。
 * 原始值仍完整留在 `BizException.detail` 里，日志和 `/health` 都能看到。
 */
const WX_LOGIN_HINTS: Record<number, string> = {
  [-1]: '微信服务繁忙，请稍后重试',
  40001: '微信登录配置有误，请联系客服',
  40029: '登录凭证已失效，请重新点一次登录',
  40164: '服务器地址未加入微信白名单，请联系客服',
  45011: '操作太频繁了，请稍后再试',
};

/** 稳定哈希：同一 code 永远得到同一 openid，便于本地反复登录同一账号 */
function stableHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
