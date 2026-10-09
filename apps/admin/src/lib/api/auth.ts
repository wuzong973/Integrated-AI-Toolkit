import { http } from '../http';
import type { AdminLoginResult, AdminProfile } from '../types';

/** 登录 / 身份 */
export const authApi = {
  login: (username: string, password: string) =>
    http.post<AdminLoginResult>('/admin/auth/login', { username, password }),

  /** 刷新页面后恢复菜单与权限用（权限以后端返回的为准，不本地推导） */
  me: () => http.get<AdminProfile>('/admin/auth/me'),

  /**
   * 登出。
   *
   * 后端只记一条审计日志，**不做 token 吊销**（JWT 无状态，服务端没有黑名单）。
   * 真正的"退出"发生在客户端：清掉 sessionStorage 里的 token。
   * 因此这个接口失败不应阻断前端登出流程。
   */
  logout: () => http.post<void>('/admin/auth/logout'),
};
