import { useContext } from 'react';

import { AuthContext, type AuthState } from './AuthContext';

/**
 * 取身份上下文。
 *
 * 未包裹 `AuthProvider` 时**直接抛错**而不是返回一个空对象：
 * 返回空对象会让 `can()` 恒为 false，表现为"菜单全都消失"，
 * 排查方向会被引到权限矩阵上，而真实原因只是漏了 Provider。
 */
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 <AuthProvider> 内使用');
  return ctx;
}
