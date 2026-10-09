/**
 * 内容安全（M4-05）—— 独立类型文件（拆分理由见 `doc-convert.types.ts`）。
 */

export interface ModerationResult {
  pass: boolean;
  /** 命中标签，如 politics / porn / abuse */
  labels?: string[];
  /** 建议动作 */
  action?: 'pass' | 'review' | 'reject';
  reason?: string;
}

/**
 * 送审上下文。
 *
 * 微信内容安全接口（`msgSecCheck` / `mediaCheckAsync`）有几项**必填**信息
 * 无法从正文本身推导，必须在调用时带上：
 *   · `openid`  —— v2 版本的必填字段，官方用它做用户维度的风控与申诉溯源；
 *   · `mediaUrl` —— 图片走的是**异步**接口，它只收公网可访问的 URL，不收二进制。
 *
 * ⚠️ 图片这条限制值得单独记住：`checkImage(buffer)` 拿到的字节**发不出去**，
 * 必须先经文件模块转成 URL。所以实现方在本字段缺失时必须显式报错，
 * 不能"返回 pass 假装审过了"。
 */
export interface ModerationRequest {
  scene?: string;
  /** 提交内容的用户 openid（微信 v2 必填） */
  openid?: string;
  /** 昵称 / 标题：官方建议一并提交，能显著提高命中率 */
  nickname?: string;
  title?: string;
  /** 图片的公网可访问 URL（mediaCheckAsync 必填） */
  mediaUrl?: string;
}

export interface ModerationProvider {
  readonly name: string;
  checkText(text: string, req?: ModerationRequest): Promise<ModerationResult>;
  checkImage(buffer: Buffer, req?: ModerationRequest): Promise<ModerationResult>;
}
