/**
 * 运行环境配置（任务清单 M0-19）
 *
 * 设计约束（踩过的坑，改前必读）：
 *  ① 环境**自动推导**，不靠人手改常量。曾经这里是 `const ENV = 'develop'` 硬编码，
 *     切体验版/正式版要改源码，漏改就会把开发地址发上线。
 *     现在读 `wx.getAccountInfoSync().miniProgram.envVersion`（基础库 2.2.2+）。
 *  ② 地址数据全部在 `config/endpoints.ts`，本文件只做**选择 + 校验**。
 *  ③ 占位域名（RFC 2606 的 `example.com`）**必须报错**，不能静默变成"网络开小差了" ——
 *     那会把一个配置错误伪装成网络抖动，是排查成本最高的一类假象。
 */
import {
  API_BASE_STORAGE_KEY,
  LOCAL_ADMIN_CONSOLE,
  LOCAL_API_BASE,
  RELEASE_ADMIN_CONSOLE,
  RELEASE_API_BASE,
  TRIAL_ADMIN_CONSOLE,
  TRIAL_API_BASE,
} from '../config/endpoints';

/** 环境名（与微信 `envVersion` 取值一致） */
export type EnvName = 'develop' | 'trial' | 'release';

/** 推导失败时的兜底环境 */
const FALLBACK_ENV: EnvName = 'develop';

const BASE_URL: Record<EnvName, string> = {
  develop: LOCAL_API_BASE,
  trial: TRIAL_API_BASE,
  release: RELEASE_API_BASE,
};

/**
 * RFC 2606 保留的占位域名后缀 —— 它们**永远解析不到真实服务**。
 * 用 `.example.com` / `.example.org` / `.example.net` 以及 `.invalid` / `.test` 都算占位。
 */
const PLACEHOLDER_HOST = /(^|\.)(example\.(com|org|net)|invalid|test)$/i;

/** 判断基址是否仍为占位域名（纯函数，可单测） */
export function isPlaceholderBase(url: string): boolean {
  try {
    // 小程序环境没有 URL 构造器，用正则取 host
    const m = /^[a-z]+:\/\/([^/:?#]+)/i.exec(url.trim());
    if (!m) return true; // 连 host 都取不到，按不可用处理
    return PLACEHOLDER_HOST.test(m[1]);
  } catch {
    return true;
  }
}

/**
 * 自动推导当前环境。
 *
 * 读不到时（基础库过低 / 非小程序宿主 / 单测里 stub 的 wx 没实现该方法）一律回落
 * `develop`：那是**带调试信息与本地 storage 逃生门**的一套配置，误判成 release 会把两者丢掉。
 */
function resolveEnvName(): EnvName {
  try {
    if (typeof wx === 'undefined') return FALLBACK_ENV;
    const v = wx.getAccountInfoSync?.().miniProgram?.envVersion;
    if (v === 'develop' || v === 'trial' || v === 'release') return v;
  } catch {
    // 基础库过低或调用时机不对，走兜底
  }
  return FALLBACK_ENV;
}

export const ENV_NAME: EnvName = resolveEnvName();

/**
 * 覆盖值是否可用（纯函数，可单测）。
 *
 * 要同时满足两条：**看起来像基址**（`http(s)://host[:port]`，无路径以外的怪东西）
 * 且**不是占位域名**。任何一条不满足就当没配 —— storage 里一个手抖的脏值
 * 不该把整个开发环境弄成"连不上"，那种故障比"没生效"难查得多。
 */
export function isUsableOverrideBase(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  const v = url.trim();
  if (!/^https?:\/\/[^/:\s]+(:\d+)?(\/?$|\/)/i.test(v)) return false;
  return !isPlaceholderBase(v);
}

/**
 * 读本地覆盖基址 —— **仅 `develop` 生效**。
 *
 * 体验版 / 正式版永不读取：否则线上包会被某个本地存储劫持到内网地址，
 * 而现象是"线上全挂、开发者工具全好"，排查方向会完全跑偏。
 */
function resolveApiBaseOverride(): string | null {
  if (ENV_NAME !== 'develop') return null;
  try {
    if (typeof wx === 'undefined') return null;
    const raw = wx.getStorageSync?.(API_BASE_STORAGE_KEY);
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const v = raw.trim();
    if (!isUsableOverrideBase(v)) {
      console.warn(`[env] 本地覆盖值「${v}」不合法（需 http(s):// 且非占位域名），已忽略`);
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

/** 本地覆盖基址（null = 未覆盖，用的是 `config/endpoints.ts` 的编译期常量） */
export const API_BASE_OVERRIDE: string | null = resolveApiBaseOverride();

export const API_BASE: string = API_BASE_OVERRIDE ?? BASE_URL[ENV_NAME];

/** 当前基址是否来自本地 storage 覆盖（仅开发期可能出现） */
export const API_BASE_IS_LOCAL_OVERRIDE = API_BASE_OVERRIDE !== null;
export const API_PREFIX = '/api/v1';
export const APP_VERSION = '0.1.0';

/** 是否为开发环境（用于显示调试信息） */
export const IS_DEV = ENV_NAME === 'develop';

/** 当前基址是否仍为占位域名（`trial` / `release` 未配置真实域名时为 true） */
export const API_BASE_IS_PLACEHOLDER = isPlaceholderBase(API_BASE);

const ADMIN_CONSOLE: Record<EnvName, string> = {
  develop: LOCAL_ADMIN_CONSOLE,
  trial: TRIAL_ADMIN_CONSOLE,
  release: RELEASE_ADMIN_CONSOLE,
};

/**
 * 管理后台（`apps/admin`）地址 —— 「我的」页的管理员入口用。
 *
 * 与 `API_BASE` 是**两套地址**：后台是独立的 web 应用，不同源。
 * ⚠️ 这里**刻意不读** `API_BASE_STORAGE_KEY` 的本地覆盖：那个逃生门是给
 * "换 Wi-Fi 后后端 IP 变了"用的，后台地址与它无关，跟着改只会让人困惑。
 */
export const ADMIN_CONSOLE_URL: string = ADMIN_CONSOLE[ENV_NAME];

/** 管理后台地址是否仍是占位域名（未配置时入口要如实说明，而不是给一个点不开的链接） */
export const ADMIN_CONSOLE_IS_PLACEHOLDER = isPlaceholderBase(ADMIN_CONSOLE_URL);

/**
 * **硬性**配置问题（空数组 = 可以发请求）。
 *
 * 判据：这个问题会让**所有**请求必然失败，且与网络状况无关。
 * 命中时调用方（`utils/request.ts`）应当**立刻失败**，给出可操作提示，
 * 而不是让 `wx.request` 走一遍 DNS 失败后弹"网络开小差了"。
 *
 * ⚠️ 只放"必然失败"的项 —— 放错了会把可用的开发环境一并拦死。
 * 开发环境的回环地址**不在**这里（开发者工具下它是对的），见 `envConfigWarnings`。
 */
export function envConfigProblems(): string[] {
  const problems: string[] = [];
  if (API_BASE_IS_PLACEHOLDER) {
    problems.push(
      `当前环境「${ENV_NAME}」的后端地址仍是占位域名（${API_BASE}），` +
        `请到 apps/mp/config/endpoints.ts 填入真实域名`,
    );
  }
  return problems;
}

/**
 * **软性**配置提醒（只 warn，不阻断请求）。
 *
 * 开发环境的回环地址在**开发者工具**里完全正常，所以绝不能当故障拦下来；
 * 但它同时意味着"真机调试/预览必然连不上"，这个信息必须让人看到 ——
 * 否则现象就是真机上莫名其妙的网络失败，而开发者工具里一切正常。
 */
export function envConfigWarnings(): string[] {
  const warnings: string[] = [];
  if (API_BASE_IS_LOCAL_OVERRIDE) {
    warnings.push(
      `基址来自本地 storage 覆盖（${API_BASE}，key=${API_BASE_STORAGE_KEY}）：` +
        '只在这台设备上生效，换设备或清缓存后会回到 endpoints.ts 的编译期常量。',
    );
  }
  if (ENV_NAME === 'develop' && /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(API_BASE)) {
    warnings.push(
      '开发环境基址是本机回环地址（127.0.0.1）：开发者工具可用，' +
        '但真机调试 / 预览二维码会连不上（真机上 127.0.0.1 指向手机自己）。' +
        '真机联调请把 apps/mp/config/endpoints.ts 的 LOCAL_API_BASE 改成局域网 IP。',
    );
  }
  return warnings;
}

