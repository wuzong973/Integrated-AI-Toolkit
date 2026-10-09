import { http } from '../http';
import type {
  AdminAccountCreateBody,
  AdminAccountDetail,
  AdminAccountItem,
  AdminAccountListQuery,
  AdminAccountUpdateBody,
  ListResult,
} from '../types';

import { flattenParams } from './params';

/** 管理员账号与权限 */
export const adminsApi = {
  list: (query: AdminAccountListQuery) =>
    http.get<ListResult<AdminAccountItem>>('/admin/admins', flattenParams(query)),
  detail: (id: string) => http.get<AdminAccountDetail>(`/admin/admins/${id}`),
  create: (body: AdminAccountCreateBody) => http.post<AdminAccountDetail>('/admin/admins', body),
  update: (id: string, body: AdminAccountUpdateBody) =>
    http.put<AdminAccountDetail>(`/admin/admins/${id}`, body),
  /**
   * 删除后台账号。
   *
   * 只删 `admin_account` 与 `Role.Admin`，**保留 User 本体** ——
   * 他仍是个普通学生，只是不再是管理员。这与"删除用户"是两件事。
   */
  remove: (id: string) => http.del<{ ok: boolean }>(`/admin/admins/${id}`),
  resetPassword: (id: string, newPassword: string) =>
    http.post<{ ok: boolean }>(`/admin/admins/${id}/reset-password`, { newPassword }),

  /**
   * 修改**自己**的密码（需提供当前密码）。
   *
   * 与 `resetPassword` 是两件事：那个是超管改别人（只需新密码），
   * 这个是本人改自己（必须验旧密码）。
   */
  changeOwnPassword: (oldPassword: string, newPassword: string) =>
    http.post<{ ok: boolean }>('/admin/admins/me/password', { oldPassword, newPassword }),
};
