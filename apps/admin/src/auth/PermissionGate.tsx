import type { ReactNode } from 'react';
import type { AdminPermission } from '@qz/core';

import { useAuth } from './useAuth';

interface Props {
  /** 需要的权限点，**任一满足即可**（与后端 `@RequirePermission` 的语义一致） */
  permission: AdminPermission | readonly AdminPermission[];
  children: ReactNode;
  /** 无权限时的替代内容（默认什么都不渲染） */
  fallback?: ReactNode;
}

/**
 * 按权限决定是否渲染。
 *
 * ⚠️ 这**不是**安全边界，只是"别让用户点一个必然 403 的按钮"。
 * 后端每个写接口都独立声明了权限点，藏起来的按钮挡不住直接调接口。
 *
 * 数组语义是"任一满足"（any-of），**不是"全部满足"** ——
 * 必须与后端 `assertPermissions` 保持一致，否则会出现
 * "后端放行、前端藏了按钮"这种最难被发现的不一致。
 */
export function PermissionGate({ permission, children, fallback = null }: Props) {
  const { hasAny } = useAuth();
  const list = Array.isArray(permission) ? permission : [permission];
  return hasAny(list) ? <>{children}</> : <>{fallback}</>;
}
