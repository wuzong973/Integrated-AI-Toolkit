import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { AdminPermission } from '@qz/core';

import { useAuth } from './useAuth';

/**
 * 未登录拦截。
 *
 * ## 为什么必须等 `initializing` 结束
 *
 * 刷新页面时 `profile` 初始为 `null`，而 `/admin/auth/me` 还没回来。
 * 若此时直接判定"未登录"跳走，已登录用户每次刷新都会被弹回登录页
 * —— 而且登录后又被送回，看起来像"登录状态存不住"。
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { profile, initializing } = useAuth();
  const location = useLocation();

  if (initializing) {
    return (
      <div className="qz-loading" style={{ height: '100vh' }}>
        <span className="qz-spinner" />
        正在恢复登录状态…
      </div>
    );
  }
  if (!profile) {
    // 带上来源路径：登录成功后直接回到原来那一页，而不是一律跳看板
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

/**
 * 路由级权限拦截。
 *
 * 无权限时**渲染提示页而不是重定向到看板**：重定向会让人以为"点了没反应"
 * （URL 变了但看着像还在原地），而明确说"你没有这个权限"才是可自助排查的。
 */
export function RequirePermission({
  permission,
  children,
}: {
  permission: AdminPermission | readonly AdminPermission[];
  children: ReactNode;
}) {
  const { hasAny, profile } = useAuth();
  const list = Array.isArray(permission) ? permission : [permission];

  if (hasAny(list)) return <>{children}</>;

  return (
    <div className="qz-card qz-mt-4">
      <div className="qz-card__body">
        <div className="qz-empty">
          <div className="qz-empty__icon">🔒</div>
          <div className="qz-empty__title">当前角色没有访问该页面的权限</div>
          <div className="qz-empty__desc">
            你的角色是「{profile?.adminRoleLabel ?? '未知'}」。如确需访问，
            请联系超级管理员调整角色。
          </div>
        </div>
      </div>
    </div>
  );
}
