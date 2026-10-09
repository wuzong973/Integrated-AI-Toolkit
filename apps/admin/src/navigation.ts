import { AdminPermission } from '@qz/core';

/**
 * 后台导航（侧栏菜单与路由权限的**唯一**声明处）。
 *
 * ## 为什么菜单与权限写在一起
 *
 * 分两处维护（一个 `router.tsx` 写路径、一个 `Sidebar.tsx` 写菜单）时，
 * 加一个页面要改两处，必然出现"菜单里有、路由没注册"（点了 404）
 * 或"路由有、菜单没入口"（页面成了孤岛）。这里声明一次，两边都读它。
 *
 * ## 权限点的语义是"任一满足"（any-of）
 *
 * 与后端 `@RequirePermission` 一致（见 `packages/core/src/admin/permissions.ts`）。
 * 写成"全部满足"会造成"后端放行、前端藏了入口"——用户明明有权限却找不到页面，
 * 且没有任何报错。这是最难被发现的一类不一致。
 */
export interface NavItem {
  to: string;
  label: string;
  /** 侧栏图标（用字符，避免为后台再引一套图标依赖） */
  icon: string;
  permission: AdminPermission | readonly AdminPermission[];
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: '概览',
    items: [
      {
        to: '/dashboard',
        label: '数据看板',
        icon: '📊',
        permission: AdminPermission.DashboardView,
      },
      { to: '/audit', label: '操作日志', icon: '📜', permission: AdminPermission.AuditView },
    ],
  },
  {
    label: '用户',
    items: [{ to: '/users', label: '用户管理', icon: '👥', permission: AdminPermission.UserView }],
  },
  {
    label: '管理员与权限',
    items: [
      { to: '/admins', label: '管理员账号', icon: '🛡️', permission: AdminPermission.AdminView },
      {
        to: '/roles',
        label: '角色权限矩阵',
        icon: '🔑',
        permission: AdminPermission.RoleManage,
      },
    ],
  },
  {
    label: '内容',
    items: [
      {
        to: '/content',
        label: '认证审核',
        icon: '📝',
        permission: AdminPermission.ContentView,
      },
    ],
  },
  {
    label: '工具与作业',
    items: [
      { to: '/tools', label: '工具管理', icon: '🧰', permission: AdminPermission.ToolView },
      { to: '/jobs', label: '作业监控', icon: '⚙️', permission: AdminPermission.JobView },
    ],
  },
  {
    label: '交易',
    items: [
      {
        to: '/orders',
        label: '订单与纠纷',
        icon: '⚖️',
        permission: AdminPermission.OrderView,
      },
    ],
  },
];
