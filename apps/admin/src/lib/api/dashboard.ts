import { http } from '../http';
import type { AdminAuditItem, AdminAuditQuery, AdminDashboardStats, ListResult } from '../types';

import { flattenParams } from './params';

/** 数据看板 */
export const dashboardApi = {
  stats: () => http.get<AdminDashboardStats>('/admin/dashboard/stats'),
};

/** 操作日志（敏感：只给审核员与财务，见后端权限矩阵） */
export const auditApi = {
  list: (query: AdminAuditQuery) =>
    http.get<ListResult<AdminAuditItem>>('/admin/audit', flattenParams(query)),
};
