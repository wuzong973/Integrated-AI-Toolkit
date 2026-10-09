/**
 * 平台公开配置（`GET /config/public`）
 *
 * 为什么单独抽一个"公开配置"契约而不是散在各接口里：
 *   客户端要在**不登录**的情况下就能知道当前平台处于什么模式
 *   （例如计费关闭时把"5 积分"显示成"限时免费"）。
 *   把这信息塞进 /health 是语义错位，塞进每个业务接口又会重复且容易不一致。
 *
 * 纪律：**这个契约里只能放"给所有用户看也无害"的内容**。
 * 密钥、开关细节、内部阈值一律走 `/admin/config`（需管理员）。
 */

/** 计费模式（由 `billing.enabled` 派生，仅用于客户端可读性） */
export type BillingMode = 'free' | 'points';

/** 免费期的默认文案；服务端下发同一份，避免各端各写一句 */
export const BILLING_FREE_NOTICE = '限时免费开放中';

export interface PublicConfig {
  /** 服务端版本号（客户端可据此提示"有新版本"） */
  version: string;
  billing: {
    /** 是否启用积分计费。`false` = 免费开放（前期默认） */
    enabled: boolean;
    /** 由 `enabled` 派生：'free' | 'points'。客户端少写一次三元判断 */
    mode: BillingMode;
    /** 价格位置的展示文案：免费时是"限时免费开放中"，计费时为空串 */
    notice: string;
  };
}

/** 由开关派生整段计费配置（服务端与客户端共用同一套派生规则，避免两边判断不一致） */
export function buildBillingPublicConfig(enabled: boolean): PublicConfig['billing'] {
  return {
    enabled,
    mode: enabled ? 'points' : 'free',
    notice: enabled ? '' : BILLING_FREE_NOTICE,
  };
}
