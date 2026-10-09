import { http } from '../http';
import type { AdminVerificationItem, AdminVerificationQuery, ListResult } from '../types';

import { flattenParams } from './params';

/**
 * 内容审核。
 *
 * 列表默认**不带 status**（后端 status 不传时返回全部）——
 * 后台排查"这条当时为什么通过"必须能看到历史。界面上再给状态页签，
 * 而不是把默认值写死成 pending。
 */
export const contentApi = {
  verifications: (query: AdminVerificationQuery) =>
    http.get<ListResult<AdminVerificationItem>>(
      '/admin/content/verifications',
      flattenParams(query),
    ),

  /**
   * 审核通过 / 拒绝。
   *
   * 通过是有**副作用**的（授予接单角色、写回真实姓名与技能画像），
   * 由后端 `ProviderService.review()` 统一执行。对未定义审核流程的
   * 认证类型，后端会明确报错而不是半实现 —— 界面把该错误原样展示即可。
   */
  review: (id: string, approved: boolean, reason?: string) =>
    http.post<AdminVerificationItem>(`/admin/content/verifications/${id}/review`, {
      approved,
      reason,
    }),
};
