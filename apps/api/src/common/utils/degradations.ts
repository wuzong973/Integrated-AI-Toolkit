/**
 * 收集"**非 Provider 形态**"的降级点（红线 10 的补充）。
 *
 * ## 为什么需要单独一类
 *
 * `anyMockProvider()` 只遍历 `Providers` 聚合里的 16 个 Provider
 * （llm / storage / ocr / …），但有些降级发生在**服务**层，不在那个聚合里。
 * 典型的就是微信登录：未配置 `WECHAT_SECRET` 时，
 * `WechatService.code2Session` 会返回**伪 openid**（`dev_<code 的哈希>`），
 * 登录照样"成功"，客户端拿到一个正常 token。
 *
 * 这类降级一旦不被标记，就是"假数据冒充功能"，而且现象极隐蔽 ——
 * 用户能登录、能看到"自己的"数据，只是那些数据属于一个不存在的微信号。
 * 更糟的是它**不会报错**，只会在某天换成真 AppSecret 后"账号全部消失"。
 *
 * ## 与 `mockProviders` 的关系
 *
 * 两者**互补**，合并后才是完整的降级面：
 * - `mockProviders`：Provider 装配层（有 `name` 以 `mock-` 开头的实现）；
 * - 本函数：服务层（配置缺失导致的降级路径）。
 *
 * 抽成纯函数是为了能单测 —— 这段逻辑的 bug 形态是"该标记的没标记"，
 * 而那正是红线 10 要防的事，必须有用例锁住。
 */
export interface Degradation {
  /** 降级点名称，会出现在 `X-Mock-Providers` 与 `/health` 里 */
  name: string;
  /** 为什么算降级、会造成什么后果（给人看的，不是给机器解析的） */
  reason: string;
}

/** 本函数需要的配置快照（只取判定要用的字段，便于单测直接构造） */
export interface DegradationInput {
  /** 是否配置了真实微信 AppSecret */
  wechatSecretConfigured: boolean;
  /**
   * 是否**强制**走开发模式的伪 openid（`WECHAT_DEV_LOGIN`）。
   *
   * ⚠️ 为 true 时，即使配了真 Secret，登录**仍然在用伪身份** —— 一样要标记，
   * 否则就漏了一处"假数据冒充功能"（上线前忘了关开关就全完了）。
   */
  wechatDevLogin: boolean;
}

export function collectDegradations(input: DegradationInput): Degradation[] {
  const out: Degradation[] = [];

  if (input.wechatDevLogin || !input.wechatSecretConfigured) {
    out.push({ name: 'wechat-login', reason: wechatReason(input) });
  }

  return out;
}

/**
 * 微信降级的说明文案。
 *
 * "配了真 Secret 却被强制走 dev"与"压根没配 Secret"是两种**不同的错误**，
 * 前者更容易被遗忘（一切看起来都配好了），所以要分开说清楚。
 */
function wechatReason(input: DegradationInput): string {
  if (input.wechatDevLogin && input.wechatSecretConfigured) {
    return (
      'WECHAT_DEV_LOGIN=true：已配置真实 AppSecret，但登录仍走开发模式，' +
      'openid 是伪值（本开关仅供本地自测与验证脚本，上线前必须关闭）'
    );
  }
  return (
    '未配置 WECHAT_SECRET：登录走开发模式，openid 是按 code 哈希出来的伪值，' +
    '不是真实微信身份（换真 AppSecret 后这些账号会对不上）'
  );
}
