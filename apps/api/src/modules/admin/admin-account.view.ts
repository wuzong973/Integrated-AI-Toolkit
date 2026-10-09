import {
  ADMIN_ROLE_LABELS,
  AdminRole,
  BizException,
  ErrorCode,
  isAdminRole,
  permissionsOfRoles,
  type AdminPermission,
} from '@qz/core';
import type { Prisma } from '@prisma/client';

import type { AdminAccountItem } from './admin-account.types';

/**
 * 管理员账号的**读取形状**（select / 映射 / 收窄）
 *
 * 从 `admin-account.service.ts` 拆出来的原因：那个文件已经到了单文件 300 行红线，
 * 而这里的东西是"怎么把一行数据变成接口响应"，与"增删改的业务规则"
 * 本来就是两件事，分开后各自都更短。
 *
 * ⚠️ `ITEM_SELECT` 里**没有 `passwordHash`** —— 这不是省事，是防线：
 * select 里没有的列，就不可能在任何一个响应里被漏出去。
 * 想加字段时请先想清楚它该不该给前端看。
 */
export const ITEM_SELECT = {
  id: true,
  userId: true,
  username: true,
  displayName: true,
  adminRole: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  user: { select: { nickname: true, phone: true } },
} as const;

export type AdminAccountRow = Prisma.AdminAccountGetPayload<{ select: typeof ITEM_SELECT }>;

/** 行 → 列表项 */
export function toAccountItem(row: AdminAccountRow): AdminAccountItem {
  const adminRole = isAdminRole(row.adminRole) ? row.adminRole : AdminRole.Auditor;
  return {
    id: row.id,
    userId: row.userId,
    username: row.username,
    displayName: row.displayName,
    adminRole,
    adminRoleLabel: ADMIN_ROLE_LABELS[adminRole],
    status: row.status,
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    nickname: row.user.nickname,
    phone: row.user.phone,
  };
}

/**
 * 角色收窄。
 *
 * `admin_role` 是无约束 VarChar，库里可能存着本代码不认识的值（改名 / 手改数据 / 回滚）。
 * 收窄失败时**拒绝**而不是退回默认角色 —— 退默认值的写法一旦默认成 `super_admin`，
 * 就是"数据脏了反而权限变大"。
 */
export function requireAdminRole(raw: string): AdminRole {
  if (!isAdminRole(raw)) {
    throw new BizException(ErrorCode.ParamInvalid, { adminRole: raw }, '管理员角色取值非法');
  }
  return raw;
}

/** 该角色展开后的权限点 */
export function permissionsOfRole(role: AdminRole): AdminPermission[] {
  return permissionsOfRoles([role]);
}
