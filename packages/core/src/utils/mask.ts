/**
 * 敏感信息脱敏（文档 6.12.3 / 日志规范）
 * 纪律：日志与列表展示中禁止出现明文手机号、学号、身份证
 */

/** 手机号脱敏：13812341234 -> 138****1234 */
export function maskPhone(phone: string): string {
  if (!phone || phone.length < 7) return '***';
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/** 学号脱敏：2023010101 -> 2023****01 */
export function maskStudentNo(no: string): string {
  if (!no || no.length < 6) return '***';
  return `${no.slice(0, 4)}****${no.slice(-2)}`;
}

/** 姓名脱敏：张三丰 -> 张*丰；张三 -> 张* */
export function maskName(name: string): string {
  if (!name) return '***';
  if (name.length === 1) return name;
  if (name.length === 2) return `${name[0]}*`;
  return `${name[0]}${'*'.repeat(name.length - 2)}${name.slice(-1)}`;
}

/** 通用字符串掩码（保留首尾） */
export function maskMiddle(s: string, keepStart = 3, keepEnd = 4, mask = '****'): string {
  if (!s) return mask;
  if (s.length <= keepStart + keepEnd) return mask;
  return `${s.slice(0, keepStart)}${mask}${s.slice(-keepEnd)}`;
}

/** 字段名 → 脱敏策略（未列出的敏感字段统一替换为 ***） */
const MASKERS: { match: (k: string) => boolean; mask: (v: string) => string }[] = [
  { match: (k) => /phone|mobile|tel/i.test(k), mask: maskPhone },
  { match: (k) => /student_?no|studentno|学号/i.test(k), mask: maskStudentNo },
  { match: (k) => /real_?name|realname|nickname/i.test(k), mask: maskName },
  {
    match: (k) => /id_?card|idcard|identity/i.test(k),
    mask: (v) => maskMiddle(v, 4, 3, '********'),
  },
];

/** 需要脱敏的字段名（未命中 MASKERS 的一律替换为 ***） */
const SENSITIVE_KEYS = [
  'password',
  'passwd',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'accessKey',
  'secretKey',
  'privateKey',
  'apiKey',
  'openid',
  'unionid',
];

function stripSensitive(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  for (const m of MASKERS) {
    if (m.match(key)) return m.mask(value);
  }
  if (SENSITIVE_KEYS.some((s) => normalizeKey(s) === normalizeKey(key))) return '***';
  return value;
}

/**
 * 字段名归一化：去掉分隔符再比大小写。
 *
 * 为什么需要它：同一个概念在不同来源里的写法不一样 ——
 * 我们自己的 DTO 是 `refreshToken`，而网关日志、第三方回调、跨语言序列化
 * 常见 `refresh_token` / `access-token`。原来的比较是
 * `s.toLowerCase() === key.toLowerCase()`，于是 `refresh_token` **不会被脱敏**，
 * 明文 token 就这么进了日志（写 mask 的用例时才发现的）。
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

/** 递归脱敏对象（用于日志输出与对外暴露的接口） */
export function maskObject<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map((v) => maskObject(v)) as unknown as T;

  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (v && typeof v === 'object') {
        out[k] = maskObject(v);
      } else {
        out[k] = stripSensitive(k, v);
      }
    }
    return out as T;
  }

  return input;
}
