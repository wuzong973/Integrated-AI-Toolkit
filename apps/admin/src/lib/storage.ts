/**
 * 凭证持久化。
 *
 * ## 为什么用 `sessionStorage` 而不是 `localStorage`
 *
 * 后台是高风险界面（能封号、能放款）。用 `localStorage` 意味着**关掉浏览器
 * 下次打开仍是登录态** —— 在共用电脑上，下一个人打开就是别人的管理员身份。
 * `sessionStorage` 随标签页关闭即失效，等价于"关页面就退出"。
 *
 * 代价是"刷新页面会保留、新开标签页要重新登录"。对后台这是合理的取舍。
 *
 * ## 为什么 key 带命名空间
 *
 * 5173 端口上常同时跑多个前端 demo，通用 key（`token`）会互相覆盖，
 * 表现为"登录成功但接口一直 401"。
 */

const NS = 'qz.admin';
const TOKEN_KEY = `${NS}.accessToken`;
const REFRESH_KEY = `${NS}.refreshToken`;

export function getToken(): string | undefined {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    // 隐私模式 / 禁用存储：退化为"每次请求无 token"，由 401 引导重新登录
    return undefined;
  }
}

export function getRefreshToken(): string | undefined {
  try {
    return sessionStorage.getItem(REFRESH_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function setTokens(accessToken: string, refreshToken?: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, accessToken);
    if (refreshToken) sessionStorage.setItem(REFRESH_KEY, refreshToken);
  } catch {
    // 存不进去也不抛：本次会话仍能靠内存里的 token 工作
  }
}

export function clearTokens(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(REFRESH_KEY);
  } catch {
    // 忽略
  }
}
