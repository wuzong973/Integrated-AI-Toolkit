import { NavLink } from 'react-router-dom';

import { useAuth } from '../auth/useAuth';
import { NAV_GROUPS } from '../navigation';

/**
 * 侧栏。
 *
 * 菜单项按**当前账号的实际权限**过滤（`hasAny`，任一满足）。
 * 权限来源是后端 `/admin/auth/me` 的裁定，不是前端拿矩阵自己算
 * （理由见 `auth/AuthContext.tsx`）。
 */
export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const { hasAny } = useAuth();

  return (
    <aside className="qz-sidebar">
      <div className="qz-sidebar__brand">
        <div className="qz-sidebar__logo">青智</div>
        <div className="qz-sidebar__title">管理后台</div>
      </div>
      <nav className="qz-sidebar__nav">
        {NAV_GROUPS.map((group) => {
          const visible = group.items.filter((item) =>
            hasAny(Array.isArray(item.permission) ? item.permission : [item.permission]),
          );
          // 整组都无权限时连分组标题一起隐藏，避免出现"空标题"
          if (!visible.length) return null;
          return (
            <div key={group.label}>
              <div className="qz-sidebar__group">{group.label}</div>
              {visible.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => `qz-nav-item${isActive ? ' is-active' : ''}`}
                  title={collapsed ? item.label : undefined}
                >
                  <span className="qz-nav-item__icon" aria-hidden>
                    {item.icon}
                  </span>
                  <span className="qz-nav-item__text">{item.label}</span>
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
