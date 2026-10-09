import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import { Sidebar } from './Sidebar';
import { Topbar, useBreadcrumb } from './Topbar';

/**
 * 后台骨架。
 *
 * 折叠状态放在这里（而不是侧栏内部）：顶栏的按钮要控制它，
 * 两者是兄弟节点，状态必须提到最近的共同父级。
 *
 * 折叠状态**不持久化**：后台是"打开就干活、干完就关"的场景，
 * 记住折叠会让下次进来看到的是一个边界不明的空侧栏。
 */
export function AdminLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const { pathname } = useLocation();
  const breadcrumb = useBreadcrumb(pathname);

  return (
    <div className={collapsed ? 'qz-shell is-collapsed' : 'qz-shell'}>
      <Sidebar collapsed={collapsed} />
      <div className="qz-main">
        <Topbar
          collapsed={collapsed}
          onToggle={() => setCollapsed((v) => !v)}
          breadcrumb={breadcrumb}
        />
        <main className="qz-content">
          <div className="qz-content__inner">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
