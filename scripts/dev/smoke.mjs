#!/usr/bin/env node
/**
 * 冒烟脚本（任务清单 M0-15 / 3.3）
 * 用 node 直接请求 /health，断言 200 与字段完整；失败退出码非 0（可进 CI）。
 *
 * 用法：
 *   node scripts/dev/smoke.mjs                 # 需 API 已在运行
 *   node scripts/dev/smoke.mjs --spawn         # 先拉起 API 再检查（自动清理）
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const PORT = process.env.PORT || '3000';
const PREFIX = process.env.API_PREFIX || '/api/v1';
const URL = `http://127.0.0.1:${PORT}${PREFIX}/health`;
const spawnMode = process.argv.includes('--spawn');

function log(msg) {
  process.stdout.write(`[smoke] ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`[smoke] FAIL: ${msg}\n`);
  process.exitCode = 1;
}

async function check() {
  log(`GET ${URL}`);
  const res = await fetch(URL, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => null);

  if (res.status !== 200) return fail(`期望 HTTP 200，实际 ${res.status}`);

  // 统一响应体：{ code, message, data, traceId }
  if (!body || body.code !== 0)
    return fail(`期望 code=0，实际 ${JSON.stringify(body)?.slice(0, 200)}`);
  const d = body.data;
  if (!d?.status || !d?.version) return fail('响应缺少 status/version 字段');

  log(`OK  status=${d.status} version=${d.version} providerMode=${d.providerMode}`);
  if (Array.isArray(d.mockProviders) && d.mockProviders.length) {
    log(`提示：以下 Provider 仍为 Mock（红线 10 已标记）: ${d.mockProviders.join(', ')}`);
  }
  const marker = res.headers.get('x-provider');
  if (marker) log(`响应头 X-Provider=${marker}`);
  return true;
}

if (!spawnMode) {
  try {
    await check();
  } catch (e) {
    fail(`请求失败：${e.message}（请先启动 API：npm run dev:api）`);
  }
} else {
  log('以 --spawn 模式启动 API ...');
  const child = spawn('npm', ['run', 'dev:api'], {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;

  child.stdout.on('data', (b) => {
    const s = b.toString();
    if (s.includes('已启动') || s.includes('Nest application successfully started')) ready = true;
  });
  child.stderr.on('data', (b) => process.stderr.write(b));

  // 最多等 60s
  for (let i = 0; i < 120 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 500));
  }

  try {
    await check();
  } catch (e) {
    fail(`请求失败：${e.message}`);
  } finally {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3000);
  }
}

process.on('exit', () => log(process.exitCode ? '结果：失败' : '结果：通过'));
