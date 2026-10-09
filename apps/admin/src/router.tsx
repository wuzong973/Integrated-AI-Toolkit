import { AdminPermission } from '@qz/core';
import { Navigate, Route, Routes } from 'react-router-dom';

import { RequireAuth, RequirePermission } from './auth/guards';
import { AdminLayout } from './layout/AdminLayout';
import { AccountPage } from './pages/AccountPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { AdminDetailPage } from './pages/admins/AdminDetailPage';
import { AdminListPage } from './pages/admins/AdminListPage';
import { RoleMatrixPage } from './pages/admins/RoleMatrixPage';
import { AuditLogPage } from './pages/audit/AuditLogPage';
import { ReviewQueuePage } from './pages/content/ReviewQueuePage';
import { DashboardPage } from './pages/DashboardPage';
import { JobDetailPage } from './pages/jobs/JobDetailPage';
import { JobListPage } from './pages/jobs/JobListPage';
import { OrderDetailPage } from './pages/orders/OrderDetailPage';
import { OrderListPage } from './pages/orders/OrderListPage';
import { ToolListPage } from './pages/tools/ToolListPage';
import { UserDetailPage } from './pages/users/UserDetailPage';
import { UserListPage } from './pages/users/UserListPage';

/**
 * 路由表。
 *
 * ## 两道守卫的分工
 *
 * `RequireAuth`（外层）负责"登录没有"；`RequirePermission`（每个页面）
 * 负责"这个角色能不能进"。**不能只用侧栏过滤菜单**：用户手敲 URL
 * 就能到任何页面，不拦的话他会看到一个因为接口 403 而全空的界面，
 * 比一句"你没有权限"更让人困惑。
 *
 * ## 权限点与 `navigation.ts` 的菜单项必须一致
 *
 * 两边不一致的典型后果是"菜单里有、点进去说没权限"。改菜单时
 * 必须同步改这里 —— 这是本文件与 `navigation.ts` 唯一需要人工对齐的地方。
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        element={
          <RequireAuth>
            <AdminLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />

        <Route
          path="/dashboard"
          element={
            <RequirePermission permission={AdminPermission.DashboardView}>
              <DashboardPage />
            </RequirePermission>
          }
        />

        <Route
          path="/users"
          element={
            <RequirePermission permission={AdminPermission.UserView}>
              <UserListPage />
            </RequirePermission>
          }
        />
        <Route
          path="/users/:id"
          element={
            <RequirePermission permission={AdminPermission.UserView}>
              <UserDetailPage />
            </RequirePermission>
          }
        />

        <Route
          path="/admins"
          element={
            <RequirePermission permission={AdminPermission.AdminView}>
              <AdminListPage />
            </RequirePermission>
          }
        />
        <Route
          path="/admins/:id"
          element={
            <RequirePermission permission={AdminPermission.AdminView}>
              <AdminDetailPage />
            </RequirePermission>
          }
        />
        <Route
          path="/roles"
          element={
            <RequirePermission permission={AdminPermission.RoleManage}>
              <RoleMatrixPage />
            </RequirePermission>
          }
        />

        <Route
          path="/content"
          element={
            <RequirePermission permission={AdminPermission.ContentView}>
              <ReviewQueuePage />
            </RequirePermission>
          }
        />

        <Route
          path="/tools"
          element={
            <RequirePermission permission={AdminPermission.ToolView}>
              <ToolListPage />
            </RequirePermission>
          }
        />
        <Route
          path="/jobs"
          element={
            <RequirePermission permission={AdminPermission.JobView}>
              <JobListPage />
            </RequirePermission>
          }
        />
        <Route
          path="/jobs/:id"
          element={
            <RequirePermission permission={AdminPermission.JobView}>
              <JobDetailPage />
            </RequirePermission>
          }
        />

        <Route
          path="/orders"
          element={
            <RequirePermission permission={AdminPermission.OrderView}>
              <OrderListPage />
            </RequirePermission>
          }
        />
        <Route
          path="/orders/:id"
          element={
            <RequirePermission permission={AdminPermission.OrderView}>
              <OrderDetailPage />
            </RequirePermission>
          }
        />

        <Route
          path="/audit"
          element={
            <RequirePermission permission={AdminPermission.AuditView}>
              <AuditLogPage />
            </RequirePermission>
          }
        />

        {/* 我的账号：任何在职管理员都可访问，故不挂权限点 */}
        <Route path="/account" element={<AccountPage />} />

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
