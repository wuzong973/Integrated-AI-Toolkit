/**
 * ID 与业务单号生成（文档 9.1）
 *
 * ## ⚠️ 为什么不用 `import { randomUUID } from 'node:crypto'`
 *
 * `@qz/core` 的定位是"与端侧解耦，可在小程序 / H5 / 后端复用"，而 `node:crypto`
 * 是 Node 专有模块。把它留在包里，**后端的 `tsc` 编译发现不了问题**——只有打包器
 * 才做静态解析：Vite/Rollup 会把它外部化成 `__vite-browser-external`，然后报
 * `"randomUUID" is not exported by "__vite-browser-external"`，整个后台构建失败。
 *
 * 改用 WebCrypto（`globalThis.crypto`）：Node ≥ 20（根 `package.json` 的 `engines`
 * 已约束）与所有现代浏览器都内置它，且无需打包器对 Node 内置模块做特殊处理。
 *
 * ## 安全上下文：降级只允许降到 `getRandomValues`
 *
 * `crypto.randomUUID()` 仅在**安全上下文**（https 或 localhost）可用；
 * `crypto.getRandomValues()` 没有这个限制。
 * 幂等键的随机性直接决定"重复提交"能否被识别，所以这里宁可手写 UUID 拼装，
 * 也不用 `Math.random` 糊弄——那会把幂等去重悄悄变成"偶尔失效"。
 */

/** UUID v4 的文本形态：8-4-4-4-12 */
function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * 16 字节随机数 → 标准 UUID v4 文本（RFC 4122：版本位 = 4，变体位 = 10xx）。
 *
 * 导出仅供测试：`crypto.randomUUID()` 存在时下面 `uuid()` 不会走这条分支，
 * 但浏览器非安全上下文一定会走，属于必须被覆盖的分支。
 */
export function formatUuidV4(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** UUID v4（幂等键、traceId 等） */
export function uuid(): string {
  if (typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return formatUuidV4(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

/** 幂等键生成（前端调用写接口前生成） */
export function idempotencyKey(): string {
  return uuid();
}

/**
 * 业务单号：前缀 + yyyyMMddHHmmss + 6 位随机
 * 例：QZ20260917103025123456
 */
export function bizNo(prefix: string, at: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  const rand = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  return `${prefix}${stamp}${rand}`;
}

/** 订单号 */
export function orderNo(at?: Date): string {
  return bizNo('QZ', at);
}

/** 任务号 */
export function taskNo(at?: Date): string {
  return bizNo('QT', at);
}
