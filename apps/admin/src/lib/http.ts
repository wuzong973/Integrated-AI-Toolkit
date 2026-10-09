import { HttpClient, SdkError } from '@qz/sdk';

import { clearTokens, getToken } from './storage';

/**
 * 后台的 HTTP 客户端（复用 `@qz/sdk`，与小程序端同一契约）。
 *
 * ## baseUrl 留空 = 走相对路径
 *
 * dev 由 Vite proxy 转发（见 `vite.config.ts`），生产由网关反代。
 * 前端任何地方都不出现后端地址，换环境不需要改代码、不需要重新构建。
 *
 * ## 401 不刷新，直接登出
 *
 * 小程序端有 `/auth/refresh` 可以用 refreshToken 续期；**后台没有这个接口**
 * （`admin-auth.controller.ts` 只有 login / me / logout）。所以这里不注册
 * `refreshToken` 钩子 —— 配一个永远返回 undefined 的钩子只会让人误以为
 * "已经处理了续期"。token 过期就让用户重新登录，行为可预期。
 *
 * 为避免"每个页面各自处理一次 401"，这里用模块级回调把信号广播给
 * `AuthProvider`，由它统一登出并跳登录页。
 */

/** token 失效时由 AuthProvider 注册的回调（避免 http 层依赖 React） */
type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

export function onUnauthorized(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

/** 后端在"未登录 / token 失效"时用的错误码 */
const AUTH_ERROR_CODES = new Set([40101, 40102, 40103]);

function isAuthError(err: SdkError): boolean {
  return AUTH_ERROR_CODES.has(err.code);
}

/**
 * 全局实例。
 *
 * `onError` 里做登出广播，**同时保留错误继续向上抛** —— 页面需要拿到
 * 原始错误来展示"这一屏加载失败"，而不是被静默吞掉后显示空列表
 * （空列表会被误读成"确实没有数据"）。
 */
export const http = new HttpClient({
  baseUrl: '',
  client: 'admin',
  version: '0.1.0',
  timeoutMs: 20_000,
  getToken,
  onError: (err) => {
    if (isAuthError(err)) {
      clearTokens();
      unauthorizedHandler?.();
    }
  },
});

/** 演示模式角标的数据源（红线 10：Mock 必须可见） */
export function isDemoMode(): boolean {
  return http.demoMode;
}

export { SdkError };
