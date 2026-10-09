/** 统一响应体（与后端 9.1 一致） */
export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
  traceId: string;
  detail?: Record<string, unknown>;
}

/** 分页响应（与后端 9.1 一致） */
export interface PageResult<T> {
  list: T[];
  total: number;
  page: number;
  size: number;
}

export interface SdkOptions {
  baseUrl: string;
  apiPrefix?: string;
  /** 取 token（H5 从 localStorage，后台从 store） */
  getToken?: () => string | undefined;
  /** token 失效时刷新（返回新 token，失败返回 undefined） */
  refreshToken?: () => Promise<string | undefined>;
  /** 端标识，会写入 X-Client */
  client?: 'h5' | 'admin' | 'mp';
  version?: string;
  /** 请求超时（毫秒） */
  timeoutMs?: number;
  /** 统一错误处理钩子 */
  onError?: (err: SdkError) => void;
}

export class SdkError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly traceId?: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SdkError';
  }
}
