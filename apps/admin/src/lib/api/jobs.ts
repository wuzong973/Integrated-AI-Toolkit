import { http } from '../http';
import type {
  AdminJobDetail,
  AdminJobItem,
  AdminJobListQuery,
  AdminToolItem,
  ListResult,
} from '../types';

import { flattenParams } from './params';

/** 工具与作业监控 */
export const jobsApi = {
  tools: () => http.get<AdminToolItem[]>('/admin/tools'),

  /**
   * 工具上下线。
   *
   * 只接受 `active` / `planned`：后台"下线"的语义是"先藏起来"，
   * 不发明第三种状态（取值必须与 `seed.ts`、`check:tools` 的既有约定一致）。
   */
  setToolStatus: (name: string, status: 'active' | 'planned') =>
    http.put<AdminToolItem>(`/admin/tools/${encodeURIComponent(name)}/status`, { status }),

  list: (query: AdminJobListQuery) =>
    http.get<ListResult<AdminJobItem>>('/admin/tools/jobs', flattenParams(query)),

  detail: (id: string) => http.get<AdminJobDetail>(`/admin/tools/jobs/${id}`),

  /**
   * 重跑。
   *
   * ⚠️ 计费落在**作业所属用户**身上（后端会把 userId 换成作业的 owner 再走
   * `JobRetryService.retry`）。管理员只是替他按了按钮 —— 界面上必须讲清
   * "会重新扣他的积分"，否则运营会以为重跑是免费的。
   */
  retry: (id: string) => http.post<AdminJobDetail>(`/admin/tools/jobs/${id}/retry`),

  /** 取消（终态作业会被状态机拒绝，错误原样展示） */
  cancel: (id: string) => http.post<AdminJobDetail>(`/admin/tools/jobs/${id}/cancel`),
};
