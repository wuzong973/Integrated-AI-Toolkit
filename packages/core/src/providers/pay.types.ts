/**
 * 支付 Provider（文档 6.12 担保交易）
 *
 * 单独成文件的原因与 `pdf.types.ts` / `doc-convert.types.ts` 相同：
 * 主 `types.ts` 已贴近 300 行红线，按能力域拆分是项目既定做法。
 *
 * ## 真实替换点在哪
 *
 * 当前 `pay` 解析为 `MockPayProvider`（无微信支付商户资质）。
 * 接入真实微信支付时，实现本接口的 `WechatPayProvider` 即可 ——
 * `OrderPayService` 只依赖这个接口，一行都不用改（红线 9）。
 */

/** 统一下单入参 */
export interface PrepayInput {
  orderNo: string;
  amountCents: number;
  description: string;
  openid: string;
}

/** 统一下单结果 —— 即小程序 `wx.requestPayment` 所需参数 */
export interface PrepayResult {
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA' | 'MD5';
  paySign: string;
}

/** 支付网关回调（**验签通过后**解析出来的结果） */
export interface PayCallbackPayload {
  orderNo: string;
  /** 网关侧流水号 */
  payNo: string;
  /** 实付金额（**分**）—— 必须与订单金额核对，防"改价"攻击 */
  amountCents: number;
  /** 网关侧判定的支付结果 */
  success: boolean;
  /** 原始报文（落库留档，对账 / 仲裁用） */
  raw: Record<string, unknown>;
}

export interface PayProvider {
  readonly name: string;
  prepay(input: PrepayInput): Promise<PrepayResult>;
  /** 退款 */
  refund(orderNo: string, amountCents: number, reason: string): Promise<{ refundId: string }>;
  /** 校验回调签名（严禁跳过，文档 6.12.1） */
  verifyCallback(headers: Record<string, string>, rawBody: string): boolean;
  /**
   * 解析回调报文 —— **必须在 `verifyCallback` 通过之后调用**。
   *
   * 为什么单独一个方法、而不是塞进 `verifyCallback`：
   * 真实微信支付的回调是 AES-GCM 加密的，"验签"与"解密解析"是两件事。
   * 合成一个布尔返回值会让**验签失败**（可能是攻击）和**报文格式不认识**
   * （可能只是网关升级了版本）混成同一个 `false`，排障时根本分不清。
   */
  parseCallback(rawBody: string): PayCallbackPayload;
}
