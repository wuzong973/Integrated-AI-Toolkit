import type { AppLogger } from '../../../common/logger/logger.service';

/**
 * 微信 `access_token` 的获取与缓存。
 *
 * ## 三个必须处理的坑（都不报错，只是"偶尔抽风"）
 *
 * 1. **有调用频率上限**：`/cgi-bin/token` 每天调用次数有限，且**并发调用会互相顶掉** ——
 *    新拿到的 token 会让上一个立即失效。所以这里必须做单飞（single-flight）：
 *    并发请求共享同一次刷新，而不是各刷各的。
 *
 * 2. **有效期 7200 秒，但要提前刷新**：踩在边界上会遇到"刚拿到就过期"。
 *    这里留 `refreshAheadSec`（默认 5 分钟）的余量。
 *
 * 3. **`stable_token` 与 `token` 的区别**：用 `stable_token`。
 *    它是官方为"多个实例共用一套凭证"设计的，不会因为并发调用互相顶掉；
 *    老接口 `/cgi-bin/token` 在同样场景下会反复失效，症状是"审核偶发失败"，
 *    极难定位。两者返回结构一致，换过来没有额外成本。
 */

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  errcode?: number;
  errmsg?: string;
}

export class WechatAccessToken {
  private token = '';
  /** 到期时间（毫秒时间戳），已扣掉提前刷新窗口 */
  private expiresAt = 0;
  /** 正在进行中的刷新，用于单飞 */
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly cfg: {
      appid: string;
      secret: string;
      /** stable_token 端点 */
      url: string;
      refreshAheadSec: number;
      timeoutMs: number;
    },
    private readonly logger: AppLogger,
  ) {}

  /** 取一个当前可用的 token（必要时刷新） */
  async get(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt) return this.token;
    return this.refresh();
  }

  /**
   * 强制刷新。单飞：并发调用共享同一个 Promise。
   *
   * 不做单飞的后果很具体：10 个并发的审核请求会打 10 次 token 接口，
   * 一旦触发频率限制，这 10 条内容全部审核失败 —— 表现为"高峰期发布成功率骤降"。
   */
  refresh(): Promise<string> {
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** token 被上游判为失效（40001/42001）时调用：丢掉缓存并重取一次 */
  async renew(): Promise<string> {
    this.token = '';
    this.expiresAt = 0;
    return this.refresh();
  }

  private async fetchToken(): Promise<string> {
    const body = {
      grant_type: 'client_credential',
      appid: this.cfg.appid,
      secret: this.cfg.secret,
      force_refresh: false,
    };

    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });

    const json = (await res.json()) as TokenResponse;
    if (!json.access_token) {
      // 这里**不吞异常**：拿不到 token 意味着所有内容都审不了。
      // 调用方需要据此决定 fail-closed（拦住内容），而不是放行。
      throw new Error(
        `获取微信 access_token 失败：errcode=${json.errcode ?? '?'} errmsg=${json.errmsg ?? '无'}`,
      );
    }

    const ttlSec = json.expires_in ?? 7200;
    this.token = json.access_token;
    this.expiresAt = Date.now() + Math.max(60, ttlSec - this.cfg.refreshAheadSec) * 1000;

    this.logger.log(`微信 access_token 已刷新，有效期 ${ttlSec}s`, 'WechatAccessToken');
    return this.token;
  }
}
