/**
 * 生成 `verify:*` 脚本用的登录 code（测试夹具）。
 *
 * ## 为什么需要
 *
 * 这些脚本都要先拿一个 accessToken，做法是拿一个**假 code** 调 `POST /auth/login`。
 * 后端只在「开发模式」下才接受假 code，而开发模式一开，**小程序的登录也一起变假了** ——
 * 于是「想让脚本跑」和「想验真实微信登录」在同一个 `.env` 里打架
 * （`WECHAT_DEV_LOGIN` 就是这个开关，2026-09-19 实测过：填了真 Secret 后脚本全停在
 * `❌ 登录（HTTP 401）`，因为请求真的打到微信、被回 `40029 invalid code`）。
 *
 * 现在后端改用**前缀**认夹具（`WechatService.isFixtureCode`）：
 * 只有以 `qz-dev:` 开头、且服务端非生产的 code 才走伪 openid，
 * 其余 code 一律真换。所以 `.env` 可以安心保持 `WECHAT_DEV_LOGIN=false`，
 * 脚本与本文件一起改用夹具 code 即可，两边不再互斥。
 *
 * 每次取 token 都用新的时间戳 → 新的伪 openid → **新的用户**，
 * 所以余额 / 配额一类断言不受上一轮运行干扰（各脚本原本就依赖这一点）。
 *
 * ## 用法
 *
 *   import { devLoginCode } from './dev-login.mjs';
 *   const r = await call('POST', '/auth/login', { body: { code: devLoginCode('billing-probe') } });
 *
 * ⚠️ 前缀与后端 `DEV_LOGIN_CODE_PREFIX` 是同一份规则的两份实现（TS 与 mjs 无法共用模块），
 *    由 `apps/api/src/modules/auth/__tests__/wechat.service.spec.ts` 做漂移守卫。
 */
export const DEV_LOGIN_CODE_PREFIX = 'qz-dev:';

/** @param tag 便于在数据库 / 日志里认出是哪个脚本，如 `billing-probe` */
export function devLoginCode(tag) {
  return `${DEV_LOGIN_CODE_PREFIX}${tag}-${Date.now()}`;
}
