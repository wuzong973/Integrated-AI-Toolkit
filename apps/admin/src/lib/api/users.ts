import { http } from '../http';
import type {
  AdminUserDetail,
  AdminUserItem,
  AdminUserListQuery,
  AdminUserUpdateBody,
  ListResult,
} from '../types';

import { flattenParams } from './params';

/**
 * 用户管理。
 *
 * ⚠️ **没有 create / delete**：用户身份来自微信 openid，后台造不出真实用户；
 * 而删除用户会顺着外键级联清掉订单、作业、钱包 —— 那是数据事故，不是"清理"。
 * 后台能做的只有"改状态（封禁/解封）"与"改角色"。
 */
export const usersApi = {
  list: (query: AdminUserListQuery) =>
    http.get<ListResult<AdminUserItem>>('/admin/users', flattenParams(query)),
  detail: (id: string) => http.get<AdminUserDetail>(`/admin/users/${id}`),
  update: (id: string, body: AdminUserUpdateBody) =>
    http.put<AdminUserDetail>(`/admin/users/${id}`, body),
};
