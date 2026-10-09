import { NavLink } from 'react-router-dom';

import { useAuth } from '../auth/useAuth';
import { isDemoMode } from '../lib/http';
import { NAV_GROUPS } from '../navigation';

/** 当前路径 → 面包屑（从导航声明推导，避免再维护一份标题表） */
export function useBreadcrumb(pathname: string): { group: string; label: string } | null {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (pathname === item.to || pathname.startsWith(`${item.to}/`)) {
        return { group: group.label, label: item.label };
      }
    }
  }
  return null;
}

/**
 * 顶栏：折叠按钮 + 面包屑 + 演示角标 + 当前账号。
 *
 * **演示模式角标**（红线 10）：后端在命中 Mock Provider 时会带回
 * `X-Provider: mock`，SDK 把它记在 `demoMode` 上。这里必须让它可见 ——
 * 否则"看着像真功能、实际是假数据"会在验收时被当成已完成。
 */
export function Topbar({
  collapsed,
  onToggle,
  breadcrumb,
}: {
  collapsed: boolean;
  onToggle: () => void;
  breadcrumb: { group: string; label: string } | null;
}) {
  const { profile, logout } = useAuth();

  return (
    <header className="qz-topbar">
      <div className="qz-topbar__left">
        <button className="qz-btn qz-btn--ghost" onClick={onToggle} aria-label="折叠侧栏">
          {collapsed ? '»' : '«'}
        </button>
        <nav className="qz-breadcrumb">
          {breadcrumb ? (
            <>
              <span>{breadcrumb.group}</span>
              <span className="qz-breadcrumb__sep">/</span>
              <span className="qz-breadcrumb__current">{breadcrumb.label}</span>
            </>
          ) : (
            <span className="qz-breadcrumb__current">青智校园 · 管理后台</span>
          )}
        </nav>
      </div>

      <div className="qz-topbar__right">
        {isDemoMode() ? (
          <span className="qz-demo-flag" title="后端命中了 Mock Provider，本次结果不是真实产出">
            ● 演示模式
          </span>
        ) : null}
        <NavLink to="/account" className="qz-row" style={{ color: 'inherit' }}>
          <span style={{ fontWeight: 500 }}>{profile?.displayName ?? '未登录'}</span>
          <span className="qz-tag qz-tag--brand">{profile?.adminRoleLabel ?? '—'}</span>
        </NavLink>
        <button className="qz-btn qz-btn--sm" onClick={() => void logout()}>
          退出
        </button>
      </div>
    </header>
  );
}
