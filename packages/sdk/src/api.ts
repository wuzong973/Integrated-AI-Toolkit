import type { HttpClient } from './client';

/** 健康检查响应 */
export interface HealthInfo {
  status: string;
  version: string;
  env: string;
  providerMode: string;
  dependencies: { database: string };
  mockProviders: string[];
  time: string;
}

export interface MeInfo {
  id: string;
  nickname: string | null;
  avatar: string | null;
  roles: string[];
  isStudentVerified: boolean;
  isProvider: boolean;
  creditScore: number;
  points: number;
  balance: number;
  completedOrders: number;
}

/**
 * 按域组织的 API（与后端 9.2 接口清单一一对应）
 * 后续里程碑按需扩展；当前覆盖 M0 已实现的接口。
 */
export function createApi(http: HttpClient) {
  return {
    health: {
      check: () => http.get<HealthInfo>('/health'),
    },
    auth: {
      me: () => http.get<MeInfo>('/auth/me'),
      logout: () => http.post<void>('/auth/logout'),
    },
    user: {
      me: () => http.get<MeInfo>('/user/me'),
      update: (data: Record<string, unknown>) => http.put<MeInfo>('/user/me', data),
      roles: () => http.get<{ role: string; scope: string; status: string }[]>('/user/roles'),
      credit: () => http.get<{ score: number; logs: unknown[] }>('/user/credit'),
      points: () => http.get<{ points: number; logs: unknown[] }>('/user/points'),
      wallet: () => http.get<Record<string, unknown>>('/user/wallet'),
    },
    toolbox: {
      categories: () => http.get<unknown[]>('/tools/categories'),
      list: (params?: Record<string, unknown>) => http.get<unknown[]>('/tools', params),
      invoke: (name: string, params: Record<string, unknown>) =>
        http.post<{ jobId: string }>(`/tools/${name}/invoke`, { params, async: true }),
      job: (jobId: string) => http.get<Record<string, unknown>>(`/jobs/${jobId}`),
    },
    station: {
      tasks: (params?: Record<string, unknown>) =>
        http.get<{ list: unknown[]; total: number }>('/station/tasks', params),
      task: (id: string) => http.get<Record<string, unknown>>(`/station/tasks/${id}`),
      publish: (data: Record<string, unknown>) =>
        http.post<Record<string, unknown>>('/station/tasks', data),
    },
    order: {
      list: (params?: Record<string, unknown>) =>
        http.get<{ list: unknown[]; total: number }>('/orders', params),
      detail: (id: string) => http.get<Record<string, unknown>>(`/orders/${id}`),
    },
  };
}

export type QzApi = ReturnType<typeof createApi>;
