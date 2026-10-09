import { SdkError, type ApiResponse, type SdkOptions } from './types';

/**
 * 跨端 HTTP 客户端（H5 / 管理后台使用）
 *
 * 与小程序端 `apps/mp/utils/request.ts` 保持一致的契约：
 *  ① 统一响应体解包  ② token 注入与 401 刷新重放  ③ 写接口自动幂等键
 *  ④ traceId 透传    ⑤ Mock 标记识别（X-Provider: mock）
 *
 * 纪律：业务代码只调用 client.get/post，不直接使用 fetch。
 */
export class HttpClient {
  private readonly base: string;
  private readonly opts: SdkOptions & {
    apiPrefix: string;
    client: string;
    version: string;
    timeoutMs: number;
  };

  /** 是否演示模式（最近一次响应决定，供 UI 显示角标） */
  demoMode = true;

  constructor(options: SdkOptions) {
    this.opts = {
      apiPrefix: '/api/v1',
      client: 'h5',
      version: '0.1.0',
      timeoutMs: 30_000,
      ...options,
    };
    this.base = options.baseUrl.replace(/\/$/, '') + this.opts.apiPrefix;
  }

  get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    return this.request<T>('GET', appendQuery(path, params));
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  del<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  private buildHeaders(method: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'X-Client': this.opts.client,
      'X-Version': this.opts.version,
    };
    const token = this.opts.getToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    // 写接口自动带幂等键（文档 9.4）
    if (method !== 'GET') headers['Idempotency-Key'] = randomKey();
    return headers;
  }

  /** 发送一次请求，返回原始响应与解析后的响应体 */
  private async send(
    method: string,
    path: string,
    body: unknown,
  ): Promise<{ ok: boolean; status: number; payload: ApiResponse<unknown> | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await fetch(this.base + path, {
        method,
        headers: this.buildHeaders(method),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      // Mock 标记识别（红线 10）
      this.demoMode = res.headers.get('X-Provider') === 'mock';
      const payload = (await res.json().catch(() => null)) as ApiResponse<unknown> | null;
      return { ok: res.ok, status: res.status, payload };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 判断是否为需要刷新 token 的错误码 */
  private static isAuthError(code: number): boolean {
    return code === 40101 || code === 40102 || code === 40103;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<T> {
    const result = await this.trySend(method, path, body);
    if (result.ok && result.payload?.code === 0) return result.payload.data as T;

    const code = result.payload?.code ?? result.status;

    // 401 → 刷新一次并重放
    if (HttpClient.isAuthError(code) && !retried && this.opts.refreshToken) {
      const next = await this.opts.refreshToken();
      if (next) return this.request<T>(method, path, body, true);
    }

    throw this.buildError(result);
  }

  /** 发送请求并把网络层异常统一转换为 SdkError */
  private async trySend(
    method: string,
    path: string,
    body: unknown,
  ): Promise<{ ok: boolean; status: number; payload: ApiResponse<unknown> | null }> {
    try {
      return await this.send(method, path, body);
    } catch (e) {
      const err = new SdkError((e as Error).message || '网络异常', -1);
      this.opts.onError?.(err);
      throw err;
    }
  }

  /** 由响应构造 SdkError 并触发 onError 钩子 */
  private buildError(result: { status: number; payload: ApiResponse<unknown> | null }): SdkError {
    const { status, payload } = result;
    const err = new SdkError(
      payload?.message ?? `请求失败（HTTP ${status}）`,
      payload?.code ?? status,
      payload?.traceId,
      payload?.detail,
    );
    this.opts.onError?.(err);
    return err;
  }
}

/** 拼接 query（跳过空值） */
export function appendQuery(path: string, params?: Record<string, unknown>): string {
  if (!params) return path;
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  if (!pairs.length) return path;
  return path.includes('?') ? `${path}&${pairs.join('&')}` : `${path}?${pairs.join('&')}`;
}

function randomKey(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `idem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
