/**
 * 解析验证脚本要打的后端地址。
 *
 * ## 为什么要有这个文件
 *
 * 三个验证脚本（`verify-billing` / `verify-billing-modes` / `verify-realtime`）
 * 原先各自把默认地址写死成 `http://127.0.0.1:3100/api/v1`，
 * 而 `.env` 的 `PORT=3000`、`docs/dev/ENV.md` 写的也是 3000 ——
 * **默认值不一致的后果是：直接 `node scripts/dev/xxx.mjs` 必然 `ECONNREFUSED`**，
 * 看起来像"后端没起"，实际是脚本打错了端口（2026-09-18 排查时踩到）。
 *
 * 现在统一从 `.env` 读 `PORT`，取不到再回落到 3000，与后端启动用的是同一份配置。
 *
 * ## 用法
 *
 *   import { resolveBaseUrl } from './base-url.mjs';
 *   const BASE = resolveBaseUrl(process.argv[2]);
 *
 * 仍然允许命令行显式覆盖：`node scripts/dev/xxx.mjs http://127.0.0.1:4000/api/v1`
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 从 .env 读一个键（极简解析：够用即可，不引 dotenv）。
 *
 * 导出给 `check-api-base.mjs` 复用 —— 端口与前缀的解析只允许有一份实现，
 * 各脚本各写一遍必然漂移（这正是本文件诞生的原因）。
 */
export function readEnv(key, fallback) {  const file = join(ROOT, '.env');
  if (!existsSync(file)) return fallback;
  const line = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith(`${key}=`));
  if (!line) return fallback;
  const value = line.slice(line.indexOf('=') + 1).trim();
  return value || fallback;
}

/**
 * @param explicit 命令行传入的完整 baseUrl（优先）
 * @returns 形如 `http://127.0.0.1:3000/api/v1`
 */
export function resolveBaseUrl(explicit) {
  if (explicit) return explicit;
  const port = readEnv('PORT', '3000');
  const prefix = readEnv('API_PREFIX', '/api/v1');
  return `http://127.0.0.1:${port}${prefix}`;
}

export { ROOT };
