import { describe, expect, it } from 'vitest';

import { collectDegradations } from '../degradations';

/**
 * 锁死"服务层降级点"的收集（红线 10）。
 *
 * 这段逻辑的 bug 形态是**该标记的没标记** —— 而"假数据冒充功能"正是红线 10 要防的事。
 * 具体场景：未配 `WECHAT_SECRET` 时登录会返回伪 openid（`dev_<哈希>`），
 * 登录照样成功、客户端拿到正常 token，界面上却没有任何"演示模式"提示。
 * 这类问题不会报错，只会在某天换上真 AppSecret 后"账号全部消失"。
 *
 * 注意 `Providers` 聚合里**没有** wechat（它是服务不是 Provider），
 * 所以 `anyMockProvider()` 永远看不到这个降级 —— 这就是本函数存在的理由。
 */
describe('collectDegradations —— 服务层降级必须被标记', () => {
  it('未配微信 AppSecret → 必须报出 wechat-login', () => {
    const d = collectDegradations({ wechatSecretConfigured: false, wechatDevLogin: false });
    expect(d).toHaveLength(1);
    expect(d[0].name).toBe('wechat-login');
    // 原因要说清后果，不能只写"未配置"
    expect(d[0].reason).toContain('WECHAT_SECRET');
    expect(d[0].reason).toContain('伪值');
  });

  it('配了 AppSecret → 不报降级（不能把正常配置误报成降级）', () => {
    expect(
      collectDegradations({ wechatSecretConfigured: true, wechatDevLogin: false }),
    ).toEqual([]);
  });

  it('配了 AppSecret 但 WECHAT_DEV_LOGIN=true → 仍要报（登录仍在用伪 openid）', () => {
    // ⚠️ 这条最容易被漏：配置看起来"全都配好了"，实际上登录还是假的。
    const d = collectDegradations({ wechatSecretConfigured: true, wechatDevLogin: true });
    expect(d).toHaveLength(1);
    expect(d[0].name).toBe('wechat-login');
    // 文案必须点明"是开关导致的"，否则看起来像"没配 Secret"，排查会走错方向
    expect(d[0].reason).toContain('WECHAT_DEV_LOGIN');
  });

  it('name 是稳定的机器可读标识（会被写进 X-Degradations 响应头）', () => {
    const name = collectDegradations({
      wechatSecretConfigured: false,
      wechatDevLogin: false,
    })[0].name;
    // 不能含逗号 —— 响应头是用逗号拼接的，含逗号会把一个降级点拆成两个
    expect(name).not.toContain(',');
    expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});
