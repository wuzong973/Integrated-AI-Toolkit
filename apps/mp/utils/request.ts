/**
 * 请求层（任务清单 M0-19）
 *
 * 职责：
 *  ① token 注入与自动刷新（401 → refresh → 重放原请求）
 *  ② 幂等键（写接口自动带 Idempotency-Key，文档 9.4）
 *  ③ 错误码 → 用户文案映射（复用 @qz/core 的 ERROR_MESSAGES 语义）
 *  ④ traceId 透传与回显
 *  ⑤ Mock 标记识别（红线 10：显示"演示模式"角标）
 *  ⑥ 统一 loading 管理
 *  ⑦ 环境配置校验（占位域名快速失败，见 ENV_CONFIG_PROBLEMS）
 */
import { API_BASE, API_PREFIX, APP_VERSION, envConfigProblems, IS_DEV } from './env';

/** 统一响应体（与后端一致，文档 9.1） */
export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
  traceId: string;
  detail?: Record<string, unknown>;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  data?: Record<string, unknown>;
  /** 是否显示 loading（默认 true） */
  loading?: boolean;
  /** 是否自动跳登录（默认 true） */
  autoLogin?: boolean;
  /** 是否携带 token（默认 true） */
  auth?: boolean;
  /** 自定义超时（毫秒） */
  timeout?: number;
}

const TOKEN_KEY = 'qz_access_token';
const REFRESH_KEY = 'qz_refresh_token';
const USER_KEY = 'qz_user';
const DEVICE_KEY = 'qz_device_id';

/**
 * HTTP 成功判定：接受整个 2xx 区间。
 *
 * 单独抽成函数是为了让这条约定有一个明确的落点 —— 曾经这里写死 `=== 200`，
 * 导致后端 `@Post()` 默认返回的 201 全部被当成失败（详见 docs/dev/ERROR-TRIAGE.md 第 1.5 节）。
 * 纯函数、无 wx 依赖，可直接单测。
 */
export function isHttpSuccess(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

/** 是否处于"演示模式"（由最近一次响应头 X-Provider 决定） */
let demoMode = true;
export function isDemoMode(): boolean {
  return demoMode;
}

/**
 * NestJS 内置异常的框架原话（例：`Cannot POST /api/v1/station/tasks`）。
 *
 * 后端 `normalizeHttpMessage` 已经拦了一道，这里是**兜底的第二道** ——
 * 旧版本后端、网关或反向代理仍可能把框架原话透出来，而那串英文
 * 会被 `toastError` 原样弹给用户（实测 2026-09-18：驿站发布页点「发布」
 * 就看到 `Cannot POST /api/v1/station/tasks`）。
 *
 * 纯函数、无 wx 依赖，可直接单测。
 */
const FRAMEWORK_ROUTE_MESSAGE = /^Cannot\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//i;

/** 归一化错误文案：框架原话换成用户文案，空文案给默认值 */
export function sanitizeErrorMessage(raw?: string): string {
  const msg = (raw ?? '').trim();
  if (FRAMEWORK_ROUTE_MESSAGE.test(msg)) return '该功能尚未开放，敬请期待';
  return msg || '请求失败';
}

/**
 * 网络层失败（`wx.request` 的 `fail` 回调）的文案。
 *
 * ⚠️ **开发环境必须把目标地址打出来。**
 *
 * 2026-09-20 实测：`endpoints.ts` 的 `LOCAL_API_BASE` 是个**过期 IP**
 * （换 Wi-Fi 后本机从 `192.168.11.x` 变成 `192.168.31.x`），于是所有请求
 * `ERR_CONNECTION_TIMED_OUT`；而后端其实**一直正常**监听 `0.0.0.0:3000`。
 * 界面当时只弹「网络开小差了，请检查网络后重试」——
 * 这句话把排查方向直接带去了"网络不好 / 后端挂了"，**唯独没人去看地址配置**。
 *
 * 换成「连不上 192.168.11.32:3000」之后，一眼就能对上 `endpoints.ts` 里那一行。
 *
 * 线上（`trial` / `release`）保持通用文案：那时地址是对的，
 * 失败确实多半是网络问题，把域名弹给用户没有意义。
 *
 * 纯函数、无 wx 依赖，可直接单测。
 */
export function networkFailMessage(base: string, isDev: boolean): string {
  if (!isDev) return '网络开小差了，请检查网络后重试';
  const host = /^[a-z]+:\/\/([^/]+)/i.exec(String(base ?? '').trim())?.[1] ?? base;
  return `连不上 ${host}`;
}

/**
 * 环境配置的**硬故障**（排查报告 P0-3）。
 *
 * 地址仍是占位域名（`example.com`）时，请求**必然**失败，且与网络状况无关。
 * 这种情况必须"快速失败 + 说清原因"，而不是让 `wx.request` 走一遍 DNS 解析失败后
 * 弹出"网络开小差了，请检查网络后重试" —— 那会把一个配置错误伪装成网络抖动，
 * 排查成本极高（开发者会去查网络、查后端，就是不查地址配置）。
 *
 * 模块加载时求值一次即可：地址是编译期常量，运行期不会变。
 */
const ENV_CONFIG_PROBLEMS = envConfigProblems();

/** 更新演示模式标记，并同步到 App.globalData，避免各页面各自判定（红线 10） */
function markDemoMode(value: boolean): void {
  if (demoMode === value) return;
  demoMode = value;
  getApp<IAppOption>()?.setDemoMode?.(value);
}

export function getToken(): string {
  return wx.getStorageSync(TOKEN_KEY) || '';
}
export function getRefreshToken(): string {
  return wx.getStorageSync(REFRESH_KEY) || '';
}
export function getUser<T = unknown>(): T | null {
  const v = wx.getStorageSync(USER_KEY);
  return v || null;
}
export function setSession(payload: {
  accessToken: string;
  refreshToken: string;
  user?: unknown;
}): void {
  wx.setStorageSync(TOKEN_KEY, payload.accessToken);
  wx.setStorageSync(REFRESH_KEY, payload.refreshToken);
  if (payload.user) wx.setStorageSync(USER_KEY, payload.user);
}
export function clearSession(): void {
  wx.removeStorageSync(TOKEN_KEY);
  wx.removeStorageSync(REFRESH_KEY);
  wx.removeStorageSync(USER_KEY);
}

/** 设备标识（用于反刷单统计，文档 M3-16） */
export function deviceId(): string {
  let id = wx.getStorageSync(DEVICE_KEY);
  if (!id) {
    id = `dev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    wx.setStorageSync(DEVICE_KEY, id);
  }
  return id;
}

/** 生成幂等键 */
function uuid(): string {
  return `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

let refreshPromise: Promise<boolean> | null = null;

/**
 * 刷新 token（并发去重：多个请求同时 401 只刷新一次）
 */
async function refreshToken(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const rt = getRefreshToken();
    if (!rt) return false;

    try {
      const res = await rawRequest<{ accessToken: string; refreshToken: string; user: unknown }>({
        path: '/auth/refresh',
        method: 'POST',
        data: { refreshToken: rt },
        auth: false,
        loading: false,
        autoLogin: false,
      });
      setSession(res);
      return true;
    } catch {
      clearSession();
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

interface RawOptions {
  path: string;
  method?: string;
  data?: Record<string, unknown>;
  auth?: boolean;
  loading?: boolean;
  autoLogin?: boolean;
  timeout?: number;
  idempotencyKey?: string;
}

/** 组装请求头（token / 版本 / 设备标识 / 幂等键） */
function buildHeaders(opts: RawOptions, method: string): Record<string, string> {
  const header: Record<string, string> = {
    'content-type': 'application/json',
    'X-Client': 'mp',
    'X-Version': APP_VERSION,
    'X-Device-Id': deviceId(),
  };

  if (opts.auth !== false) {
    const token = getToken();
    if (token) header.Authorization = `Bearer ${token}`;
  }

  // 写接口自动带幂等键（文档 9.4）
  if (method !== 'GET') header['Idempotency-Key'] = opts.idempotencyKey ?? uuid();

  return header;
}

/**
 * 配置级硬故障：**先失败，不发请求**（见 ENV_CONFIG_PROBLEMS 注释）。
 * 返回 true 表示已 reject，调用方应立即返回。
 */
function rejectIfEnvMisconfigured(reject: (e: unknown) => void): boolean {
  if (!ENV_CONFIG_PROBLEMS.length) return false;
  reject(
    Object.assign(new Error(ENV_CONFIG_PROBLEMS[0]), {
      code: -2,
      configError: true,
      detail: { problems: ENV_CONFIG_PROBLEMS },
    }),
  );
  return true;
}

/**
 * 加载浮层的引用计数（纯函数，便于单测）。
 *
 * ⚠️ 微信的 `showLoading` / `hideLoading` 操作的是**同一个全局浮层**，不是可嵌套的计数器。
 * 两个请求同时带 `loading` 时，**先完成的那个 `hideLoading()` 会把浮层关掉** ——
 * 后一个请求还在飞，界面却已经"转完了"；等它也完成再调 `hideLoading()`，
 * 命中的是"当前没有正在显示的 loading"，开发者工具于是报
 * `showLoading 与 hideLoading 必须配对使用`。
 *
 * 所以自己记一层深度：只在 0→1 时真 show、1→0 时真 hide，中间全部忽略。
 *
 * @param depth 当前深度
 * @param action 本次动作
 * @returns 新的深度，以及**这次是否真的要操作浮层**
 */
export function stepLoading(
  depth: number,
  action: 'show' | 'hide',
): { depth: number; effect: 'show' | 'hide' | 'none' } {
  if (action === 'show') {
    return depth === 0 ? { depth: 1, effect: 'show' } : { depth: depth + 1, effect: 'none' };
  }
  // 防御：深度已归零还收到 hide（页面卸载时系统会自己收掉浮层）——
  // 直接返回，别把"本来就没有浮层"变成一条误导性的 SDK 警告
  if (depth <= 0) return { depth: 0, effect: 'none' };
  const next = depth - 1;
  return next === 0 ? { depth: 0, effect: 'hide' } : { depth: next, effect: 'none' };
}

/** 当前正在带 loading 的请求数 */
let loadingDepth = 0;

function beginLoading(): void {
  const step = stepLoading(loadingDepth, 'show');
  loadingDepth = step.depth;
  if (step.effect === 'show') wx.showLoading({ title: '加载中', mask: true });
}

function endLoading(): void {
  const step = stepLoading(loadingDepth, 'hide');
  loadingDepth = step.depth;
  if (step.effect === 'hide') wx.hideLoading();
}

/** 底层请求（不含刷新逻辑，避免递归） */
function rawRequest<T>(opts: RawOptions): Promise<T> {
  const { path, method = 'GET', data, loading = false, timeout = 30000 } = opts;

  return new Promise<T>((resolve, reject) => {
    if (rejectIfEnvMisconfigured(reject)) return;

    const header = buildHeaders(opts, method);
    if (loading) beginLoading();

    wx.request({
      url: `${API_BASE}${API_PREFIX}${path}`,
      method: method as never,
      data,
      header,
      timeout,
      success: (res) => {
        // Mock 标记识别（红线 10）
        const provider = res.header?.['X-Provider'] || res.header?.['x-provider'];
        markDemoMode(provider === 'mock');

        const body = res.data as ApiResponse<T>;

        // 成功判定：HTTP 2xx + 业务码 0。
        // ⚠️ 必须接受整个 2xx 区间，不能写死 200 —— NestJS 对 @Post() 默认返回 201 Created，
        //    写死 200 会把「登录」等所有 POST 的成功响应误判为失败，
        //    而且错误文案会取到成功响应里的 message（"ok"），排查时极具误导性。
        if (isHttpSuccess(res.statusCode) && body && body.code === 0) {
          resolve(body.data);
          return;
        }

        // 40101/40102/40103 → 登录失效
        const code = body?.code ?? res.statusCode;
        reject(
          Object.assign(new Error(sanitizeErrorMessage(body?.message)), {
            code,
            detail: body?.detail,
            traceId: body?.traceId,
            statusCode: res.statusCode,
          }),
        );
      },
      fail: (err) => {
        // 开发环境把"往哪儿发失败了"写进控制台 —— 换 Wi-Fi 后 IP 过期是最高频原因，
        // 而它的现象（全部请求超时）看起来完全像"后端挂了"。
        if (IS_DEV) {
          console.warn(
            `[request] ${method} ${path} 网络层失败，目标是 ${API_BASE}${API_PREFIX}${path}\n` +
              '  开发环境最常见的原因是 apps/mp/config/endpoints.ts 的 LOCAL_API_BASE 过期' +
              '（换 Wi-Fi 后本机 IP 变了）。\n' +
              '  在项目根目录跑 `npm run check:api-base` 可自动比对本机网卡地址并给出正确的值。',
            err,
          );
        }
        reject(
          Object.assign(new Error(networkFailMessage(API_BASE, IS_DEV)), { code: -1, raw: err }),
        );
      },
      complete: () => {
        if (loading) endLoading();
      },
    });
  });
}

/**
 * 对外统一请求方法：自动处理 401 刷新与重放
 */
export async function request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const { loading = true, autoLogin = true } = options;

  try {
    return await rawRequest<T>({ path, ...options, loading });
  } catch (err) {
    const e = err as { code?: number; message?: string };

    // token 失效 → 尝试刷新一次并重放
    const isAuthError = e.code === 40101 || e.code === 40102 || e.code === 40103;
    if (isAuthError && options.auth !== false) {
      const ok = await refreshToken();
      if (ok) {
        return await rawRequest<T>({ path, ...options, loading: false });
      }
      clearSession();
      if (autoLogin) toLogin();
    }

    throw err;
  }
}

/** 跳登录页（带 redirect，登录后回跳） */
export function toLogin(): void {
  const pages = getCurrentPages();
  const current = pages[pages.length - 1];
  const redirect = current ? `/${current.route}` : '/pages/home/index';
  wx.navigateTo({ url: `/pages/common/login?redirect=${encodeURIComponent(redirect)}` });
}

/** 便捷方法 */
export const http = {
  /** GET 请求：params 会拼成 query string（与后端 9.1 的分页/筛选约定一致） */
  get: <T = unknown>(
    path: string,
    options?: Omit<RequestOptions, 'method'> & { params?: Record<string, unknown> },
  ) => {
    const { params, ...rest } = options ?? {};
    return request<T>(appendQuery(path, params), { ...rest, method: 'GET' });
  },
  post: <T = unknown>(
    path: string,
    data?: Record<string, unknown>,
    options?: Omit<RequestOptions, 'method' | 'data'>,
  ) => request<T>(path, { ...options, method: 'POST', data }),
  put: <T = unknown>(
    path: string,
    data?: Record<string, unknown>,
    options?: Omit<RequestOptions, 'method' | 'data'>,
  ) => request<T>(path, { ...options, method: 'PUT', data }),
  del: <T = unknown>(path: string, options?: Omit<RequestOptions, 'method' | 'data'>) =>
    request<T>(path, { ...options, method: 'DELETE' }),
};

/** 统一的错误提示（文案原则：说清发生了什么 + 下一步能做什么） */
export function toastError(err: unknown): void {
  const e = err as { message?: string; code?: number };
  wx.showToast({ title: e?.message || '操作失败，请稍后重试', icon: 'none', duration: 2500 });
}

/** 把参数拼成 query string（自动跳过 undefined/null/空字符串） */
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
