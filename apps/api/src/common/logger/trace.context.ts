import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * traceId 上下文（任务清单 M0-06）
 * 用 AsyncLocalStorage 把 traceId 贯穿整个请求生命周期，
 * 这样任何深度的服务/Provider 都能取到同一个 traceId，无需层层传参。
 */
export interface TraceStore {
  traceId: string;
  userId?: string;
  startedAt: number;
}

export const traceStorage = new AsyncLocalStorage<TraceStore>();

/** 取当前 traceId（无上下文时返回占位符） */
export function currentTraceId(): string {
  return traceStorage.getStore()?.traceId ?? '-';
}

/** 取当前登录用户 id */
export function currentUserId(): string | undefined {
  return traceStorage.getStore()?.userId;
}

/** 在指定上下文中执行 */
export function runWithTrace<T>(store: TraceStore, fn: () => T): T {
  return traceStorage.run(store, fn);
}
