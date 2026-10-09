import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AdminPermission } from '@qz/core';

import { authApi } from '../lib/api';
import { onUnauthorized } from '../lib/http';
import { clearTokens, getToken, setTokens } from '../lib/storage';
import type { AdminProfile } from '../lib/types';

/**
 * 身份与权限上下文。
 *
 * ## 权限只信后端
 *
 * `can()` 读的是 `/admin/auth/me` 返回的 `permissions` 数组，
 * **不在前端用 `ADMIN_ROLE_PERMISSIONS` 自己推导**。
 *
 * 看起来重复（前端明明有矩阵可直接算），但两者语义不同：
 *   · 矩阵是**配置**：角色"应该"有哪些权限；
 *   · `permissions` 是**裁定**：后端此刻"允许"这个账号做什么。
 * 前端自己推导会在"后端改了矩阵但前端包还没发版"时出现
 * 界面显示按钮、点了 403 —— 而按后端裁定渲染，界面与后端永远同步。
 *
 * ⚠️ 无论如何，**前端隐藏菜单只是体验，不是安全边界**：
 * 真正的边界是后端 `@RequirePermission()`。所以每个写操作页面在拿到
 * 403 时仍要正确展示错误（本层的 `can` 挡不住直接调接口）。
 */
export interface AuthState {
  /** 当前管理员资料；`null` = 未登录（或恢复身份失败） */
  profile: AdminProfile | null;
  /** 首次进入时的身份恢复中：此时不能判定"未登录"，否则刷新页面会闪一下登录页 */
  initializing: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (permission: AdminPermission) => boolean;
  hasAny: (permissions: readonly AdminPermission[]) => boolean;
}

export const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<AdminProfile | null>(null);
  const [initializing, setInitializing] = useState(true);
  const navigate = useNavigate();

  // 刷新页面后恢复身份（sessionStorage 里有 token 才试）
  useEffect(() => {
    let alive = true;
    if (!getToken()) {
      setInitializing(false);
      return;
    }
    authApi
      .me()
      .then((p) => {
        if (alive) setProfile(p);
      })
      .catch(() => {
        // token 过期 / 被禁用：静默清理，由路由守卫送去看登录页
        if (alive) {
          clearTokens();
          setProfile(null);
        }
      })
      .finally(() => {
        if (alive) setInitializing(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 任意请求返回 401 时统一登出（避免每个页面各写一遍）
  useEffect(() => {
    onUnauthorized(() => {
      setProfile(null);
      navigate('/login', { replace: true });
    });
    return () => onUnauthorized(null);
  }, [navigate]);

  const login = useCallback(async (username: string, password: string) => {
    const result = await authApi.login(username, password);
    setTokens(result.accessToken, result.refreshToken);
    setProfile(result.admin);
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // 后端只记审计日志，不做 token 吊销；这一步失败不该阻断本地登出
    }
    clearTokens();
    setProfile(null);
    navigate('/login', { replace: true });
  }, [navigate]);

  const value = useMemo<AuthState>(
    () => ({
      profile,
      initializing,
      login,
      logout,
      can: (permission) => profile?.permissions.includes(permission) ?? false,
      hasAny: (permissions) => permissions.some((p) => profile?.permissions.includes(p) ?? false),
    }),
    [profile, initializing, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
