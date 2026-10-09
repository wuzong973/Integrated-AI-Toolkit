import type { AdminPermission, AdminRole } from '@qz/core';

/**
 * 管理员账号的对外形状。
 *
 * 单独成文件是为了打断 `service ↔ view` 的循环 import：
 * service 需要 view 的映射函数，view 需要这里的类型。
 * 类型放中间，两边都只依赖它。
 */

/** 后台列表里的一行管理员（**绝不含 passwordHash**） */
export interface AdminAccountItem {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  adminRole: AdminRole;
  adminRoleLabel: string;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  /** 关联用户信息，便于确认"这个后台账号对应哪个学生" */
  nickname: string | null;
  phone: string | null;
}

export interface AdminAccountDetail extends AdminAccountItem {
  permissions: AdminPermission[];
}
