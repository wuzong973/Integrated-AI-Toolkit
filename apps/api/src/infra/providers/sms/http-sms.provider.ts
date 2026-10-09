import { BizException, CHINA_MOBILE_PATTERN, ErrorCode, type SmsProvider } from '@qz/core';

import type { AppConfig } from '../../../common/config/configuration';
import type { AppLogger } from '../../../common/logger/logger.service';

/**
 * 短信 Provider —— **与厂商无关的 HTTP 网关适配器**。
 *
 * ## 为什么是网关而不是直接对接阿里云 / 腾讯云
 *
 * 短信服务商**尚未选型**（这一点在任务清单里就是待决策项）。在选型确定之前写一个
 * 带厂商签名的实现是典型的"看起来完成了、其实没法验证" ——
 * 阿里云 RPC 签名、腾讯云 TC3-HMAC-SHA256 各有一套百分号编码与大小写规则，
 * 没有真实凭证就只能靠猜，而签名错了的表现是"接口返回签名错误"，
 * 排查成本很高。
 *
 * 所以这里只做两件确定的事：
 *   1. 定义清楚**一次成功发送需要哪些输入**（手机号、模板、模板参数）；
 *   2. 把请求形状做成**可配置**的（字段名映射），任何讲 HTTP 的网关都能接。
 *
 * 选型定了之后，新增一个 `AliyunSmsProvider` / `TencentSmsProvider`
 * 实现同一个 `SmsProvider` 接口即可，业务代码一行不用改
 * —— 这正是 Provider 模式存在的意义。
 *
 * ## 手机号必须校验，且**不能进日志**
 *
 * 手机号是本项目里最敏感的个人信息之一：
 * 非法格式（长度不对、含区号）在网关侧会返回"参数错误"，
 * 在本地拦下来的提示要清楚得多；而日志里必须脱敏，
 * 否则一条 `[mock-sms] 验证码短信 138xxx: {"code":"1234"}` 就把
 * "手机号 + 验证码"这一对完整凭证写进了日志文件。
 */
export class HttpSmsProvider implements SmsProvider {
  readonly name = 'http-sms';

  constructor(
    private readonly cfg: AppConfig['sms'],
    private readonly logger: AppLogger,
  ) {}

  async send(phone: string, templateCode: string, params: Record<string, string>): Promise<void> {
    if (!this.cfg.enabled) {
      throw new BizException(
        ErrorCode.SmsUnavailable,
        { provider: this.name },
        '短信服务未配置，请设置 SMS_GATEWAY_URL 后再试',
      );
    }
    if (!isChinaMobile(phone)) {
      throw new BizException(
        ErrorCode.ParamInvalid,
        { provider: this.name },
        '手机号格式不正确（需为 11 位中国大陆手机号）',
      );
    }
    if (!templateCode.trim()) {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '短信模板编号不能为空');
    }

    const body = {
      [this.cfg.fields.phone]: phone,
      [this.cfg.fields.template]: templateCode,
      [this.cfg.fields.params]: params,
    };

    const res = await this.post(body);
    this.logger.log(
      `短信已提交：template=${templateCode} phone=${maskPhone(phone)}`,
      'HttpSmsProvider',
    );

    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      throw new BizException(
        ErrorCode.SmsUnavailable,
        { provider: this.name, status: res.status, body: text },
        '短信发送失败，请稍后重试',
      );
    }
  }

  private async post(body: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cfg.gatewayToken) {
      headers.Authorization = `Bearer ${this.cfg.gatewayToken}`;
    }

    try {
      return await fetch(this.cfg.gatewayUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (e) {
      // 超时与"连不上"分开说：前者要重试、后者要去检查网关地址
      const timeout = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';
      throw new BizException(
        ErrorCode.SmsUnavailable,
        { provider: this.name, timeout },
        timeout ? '短信网关响应超时，请稍后重试' : '无法连接短信网关，请联系管理员',
      );
    }
  }
}

/**
 * 中国大陆手机号判定。
 *
 * 规则本体在 `@qz/core` 的 `CHINA_MOBILE_PATTERN`（前后端共用：小程序表单按同一口径先拦一次）。
 * 这里只做转发 —— 曾经这里是另一份同义正则，号段一变就会两处不一致。
 */
export function isChinaMobile(phone: string): boolean {
  return CHINA_MOBILE_PATTERN.test(phone.trim());
}

/** 脱敏：保留前 3 后 4。排障时够用，泄露时不足以还原 */
export function maskPhone(phone: string): string {
  const text = phone.trim();
  return text.length < 7 ? '***' : `${text.slice(0, 3)}****${text.slice(-4)}`;
}
