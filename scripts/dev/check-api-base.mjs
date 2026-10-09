/**
 * 校验小程序开发基址（`endpoints.ts` 的 `LOCAL_API_BASE`）是否还指向本机。
 *
 * ## 为什么需要它
 *
 * 2026-09-20 实测故障：小程序所有请求 `ERR_CONNECTION_TIMED_OUT`，
 * 界面弹「网络开小差了」，看起来**像后端挂了** —— 而后端一直好好的，
 * 监听在 `0.0.0.0:3000` 上。真实原因只是**本机换了个 Wi-Fi**，
 * 局域网地址从 `192.168.11.x` 变成了 `192.168.31.x`，
 * 而 `endpoints.ts` 里还写着旧 IP。
 *
 * 这类故障有三个特征，让它特别值得做成守卫：
 *   ① **现象与原因完全不像** —— "全部请求超时"指向网络/后端，唯独不指向地址配置；
 *   ② **必然发生** —— 家用路由器 DHCP，换 Wi-Fi / 重启路由器 / 开热点都会换 IP；
 *   ③ **排查成本高** —— 光看现象想不到去比对网卡地址，实测绕了一圈才定位。
 *
 * ## 判据（按 host 自动分成两种模式）
 *
 * · **本地模式**（host 是局域网 / 回环地址）：host **必须等于本机某块网卡的非 link-local
 *   IPv4 地址**，不符即失败并给出"应该改成什么"；同时比对 `.env` 的 `PORT`、
 *   `STORAGE_PUBLIC_BASE_URL` 与 `apps/api/.env` 生成物。
 * · **直连线上模式**（host 是公网域名 / 公网 IP，2026-10-09 起本项目用这个）：
 *   上面那些**全部跳过** —— 它们是本地后端的配置，与线上无关；改为探测
 *   `${base}/api/v1/health` 是否真的应答。`--fix` 在此模式下**不会**把地址改回局域网 IP，
 *   否则守卫会悄悄否决掉开发者明确的选择（这类"自动改回上一个值"最难查）。
 *
 * ## ⚠️ 为什么它不在"交付前必须全绿"那一组里
 *
 * 它的结论**依赖当前这台机器的网络**：换一台机器跑（CI、同事的电脑）必然失败，
 * 而那并不是缺陷。所以它是一个**诊断工具**，不是交付门禁 ——
 * 放进 `npm run lint && npm test && ...` 那条链里只会制造假红灯。
 * 触发时机：换 Wi-Fi 后 / 小程序报连接超时 / 真机调试连不上时。
 *
 * ## 用法
 *
 *   npm run check:api-base          # 只检查，给出建议值
 *   npm run check:api-base -- --fix # 顺便把 endpoints.ts 与文档一起改掉
 *
 * 退出码：0 = 地址正确且后端可达；1 = 需要处理。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

import { readEnv, ROOT } from './base-url.mjs';

const ENDPOINTS = join(ROOT, 'apps/mp/config/endpoints.ts');
const DEVTOOLS_DOC = join(ROOT, 'docs/dev/WECHAT-DEVTOOLS.md');

const FIX = process.argv.includes('--fix');

/**
 * 本机可路由的 IPv4 地址。
 *
 * 排除三类：
 *   · `internal` —— 回环（`127.0.0.1`），真机上指向手机自己，不能用来配；
 *   · `169.254.*` —— link-local，网卡没拿到 DHCP 时的自分配地址，不可路由；
 *   · IPv6 —— 小程序里填 IP 基址用 IPv4 最省事。
 */
function localIPv4() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (ni.address.startsWith('169.254.')) continue;
      out.push(ni.address);
    }
  }
  return out;
}

/** 从 endpoints.ts 里取出 LOCAL_API_BASE（唯一来源） */
function readLocalApiBase(src) {
  return /export const LOCAL_API_BASE\s*=\s*'([^']+)'/.exec(src)?.[1] ?? null;
}

/**
 * 带超时的探测：后端在这个地址上到底答不答。
 *
 * 用 `node:http` / `node:https` 而不是全局 `fetch`：`fetch` 的连接池在
 * `process.exit()` 时往往还没拆完，Windows + Node 24 下会打出
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` —— 一个无害的断言
 * 会被当成"脚本报错"，正是本项目最想消灭的那类假红灯。`agent: false` 不留 keep-alive。
 */
function probe(url, timeoutMs) {
  const mod = url.startsWith('https') ? https : http;
  return new Promise((resolve) => {
    const req = mod.get(url, { agent: false, timeout: timeoutMs }, (res) => {
      res.resume(); // 不消费掉响应体，连接不会释放
      resolve({ ok: true, status: res.statusCode });
    });
    req.on('error', (e) => resolve({ ok: false, reason: String(e?.code ?? e?.message ?? e) }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: '超时' });
    });
  });
}

const problems = [];
/** 文件里出现的、**不是本机地址**的 host —— `--fix` 按这个集合做替换 */
const staleHosts = new Set();

// ---------- 1. 读配置 ----------
const src = readFileSync(ENDPOINTS, 'utf8');
const base = readLocalApiBase(src);
if (!base) {
  console.error('❌ 在 apps/mp/config/endpoints.ts 里找不到 LOCAL_API_BASE');
  process.exit(1);
}

let host = null;
try {
  host = new URL(base).hostname;
} catch {
  console.error(`❌ LOCAL_API_BASE 不是合法 URL：${base}`);
  process.exit(1);
}

const ips = localIPv4();

/**
 * host 是否属于"本机 / 局域网"地址 —— 决定走哪一套判据。
 *
 * 只有 RFC 1918 与回环地址才该跟本机网卡比对；公网域名（直连线上模式）比了必然不符，
 * 那会把一个**明确的选择**报成故障。
 */
const LAN_HOST = /^(127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|localhost$)/;
const remote = !LAN_HOST.test(host);

// ---------- 1.5 模式说明 ----------
if (remote) {
  console.log(
    `ℹ️ 直连线上模式（host=${host} 不是局域网地址）：跳过网卡、端口与本地 .env 比对，` +
      '只探测线上 /health 是否应答。',
  );
}

// ---------- 2. 本机网卡比对（仅本地模式） ----------
if (!remote && !ips.length) {
  problems.push(
    '本机没有任何可路由的 IPv4 地址（只有回环或 link-local）—— 先连上 Wi-Fi 或有线网再跑本脚本',
  );
} else if (!remote && !ips.includes(host)) {
  staleHosts.add(host);
  problems.push(
    `LOCAL_API_BASE 指向 ${host}，但本机现在的地址是 ${ips.join(' / ')}。\n` +
      `     这类故障的现象是「所有请求 ERR_CONNECTION_TIMED_OUT」，很容易被误判成后端挂了。`,
  );
}

// ---------- 3. 端口是否与后端实际监听的一致 ----------
/**
 * 后端从 `.env` 的 `PORT` 取端口，而基址里的端口是**手写的**。
 * 两者不一致时请求全部打到空端口上，现象与"后端没起"完全一样 ——
 * `scripts/dev/base-url.mjs` 的诞生原因就是同一类错（脚本默认打 3100、后端是 3000）。
 */
const envPort = readEnv('PORT', '3000');
let basePort = '';
try {
  basePort = new URL(base).port || (base.startsWith('https') ? '443' : '80');
} catch {
  basePort = '';
}
if (!remote && basePort !== envPort) {
  problems.push(
    `基址里的端口是 ${basePort}，而 .env 的 PORT=${envPort} —— ` +
      '请求会全部打到没有监听的端口上，现象与"后端没起"一模一样',
  );
}

// ---------- 4. 后端是否真的在这个地址上应答 ----------
if (remote || ips.includes(host)) {
  const prefix = readEnv('API_PREFIX', '/api/v1');
  const url = `${base}${prefix}/health`;
  const r = await probe(url, remote ? 10000 : 4000);
  if (!r.ok) {
    problems.push(
      remote
        ? `线上后端 ${url} 探测失败（${r.reason}）。\n` +
          '     与本机网卡无关（地址是公网域名）：先确认服务器进程、nginx 反代与证书（见 docs/dev/DEPLOY-PROD.md）'
        : `地址本身是对的（${host} 是本机网卡），但 ${url} 探测失败（${r.reason}）。\n` +
          '     大概率是后端进程没起：npm run build -w @qz/api 后 npm run start -w @qz/api',
    );
  } else {
    console.log(`✅ 后端在 ${base} 上应答正常（HTTP ${r.status}）`);
  }
}

// ---------- 5. `.env` 的 STORAGE_PUBLIC_BASE_URL 是否同源 ----------
/**
 * 它决定**文件下载 / 图片预览**的公开 URL 前缀（见 `docs/dev/ENV.md` 第 5 节）。
 * 留空会回落 `localhost`，真机指向手机自己；填了旧 IP 则是**另一个更隐蔽的坑** ——
 * 接口全通（那是 `endpoints.ts` 管的），只有文件链接打不开，
 * 看起来像"文件服务坏了"，而根因还是那个过期 IP。
 *
 * 2026-09-20 实测：`endpoints.ts` 与 `.env` **两处都写着同一个过期 IP**，
 * 只改前者的话，接口恢复了、文件仍然坏 —— 所以判据必须覆盖所有"跟本机 IP 绑定"的值。
 */
const envFile = join(ROOT, '.env');
if (!remote && existsSync(envFile)) {
  const envSrc = readFileSync(envFile, 'utf8');
  const line = envSrc.split(/\r?\n/).find((l) => l.trim().startsWith('STORAGE_PUBLIC_BASE_URL='));
  const value = (line ?? '').slice(line?.indexOf('=') + 1).trim();
  if (value && value.includes(host)) {
    // 已经是当前地址，正常
  } else if (!value) {
    problems.push(
      '.env 的 STORAGE_PUBLIC_BASE_URL 为空 —— 会回落到 localhost，' +
        '真机上文件下载 / 图片预览会指向手机自己（接口正常但文件打不开）',
    );
  } else {
    const stale = /\/\/([^/:]+)/.exec(value)?.[1] ?? '';
    if (!ips.includes(stale)) {
      staleHosts.add(stale);
      problems.push(
        `.env 的 STORAGE_PUBLIC_BASE_URL 指向 ${stale}，不是本机地址 —— ` +
          '接口能通但**文件下载 / 图片预览会失败**（这个更隐蔽，容易误判成文件服务坏了）',
      );
    }
  }
}

// ---------- 6. 生成物 `apps/api/.env` 是否与源一致 ----------
/**
 * `apps/api/.env` 是 `npm run setup:env` 从根 `.env` **复制**出来的生成物
 * （见 `scripts/dev/setup-env.mjs` 与 `apps/api/src/common/config/paths.ts` 的说明）。
 *
 * 判据取**逐字节一致**，而不是只比 IP —— 实测这份生成物同时过期在三处：
 * `STORAGE_PUBLIC_BASE_URL` 是旧 IP、`LLM_TIMEOUT_MS` 还停在 12000（根是 30000）、
 * 且缺少新增的 `MEDIA_TTS_BIN`。只比 IP 会把后两项漏掉。
 *
 * 它排在 `ENV_FILE_PATHS` 末尾（`REPO_ROOT/.env` 优先），所以平时**不会**发作 ——
 * 但一旦有人 `cd apps/api` 启动，读到的就是这份过期配置，症状与"代码没生效"极像。
 */
const APP_ENV = join(ROOT, 'apps/api/.env');
let appEnvStale = false;
if (!remote && existsSync(envFile) && existsSync(APP_ENV)) {
  const aLines = readFileSync(envFile, 'utf8').split(/\r?\n/);
  const bLines = readFileSync(APP_ENV, 'utf8').split(/\r?\n/);
  const same = aLines.filter((l, i) => l === bLines[i]).length;
  const diffCount = Math.max(aLines.length, bLines.length) - same;
  if (diffCount > 0) {
    appEnvStale = true;
    problems.push(
      `apps/api/.env 与根 .env 有 ${diffCount} 行不一致 —— 它是 \`npm run setup:env\` 的生成物，跑一次即可同步。\n` +
        '     平时不发作（根 .env 优先），但 `cd apps/api` 启动时会读到过期配置。',
    );
  }
}

// ---------- 7. 文档是否跟着漂移 ----------
if (!readFileSync(DEVTOOLS_DOC, 'utf8').includes(host)) {
  problems.push(
    `docs/dev/WECHAT-DEVTOOLS.md 里没有出现当前地址 ${host}（文档与代码已漂移）` +
      '—— 照文档操作的人会填到一个错的地址',
  );
}

// ---------- 输出 ----------
if (!problems.length) {
  console.log(
    remote
      ? `✅ 开发基址有效：${base}（直连线上，不经本机网卡）`
      : `✅ 开发基址有效：${base}（本机网卡：${ips.join(' / ')}）`,
  );
  process.exit(0);
}

console.log(`\n❌ 开发基址需要处理（${problems.length} 项）：\n`);
for (const p of problems) console.log(`  · ${p}`);

// ---------- 输出与修复 ----------
const target = ips[0];

if (staleHosts.size && target) {
  const next = base.replace(host, target);
  console.log(`\n建议值：${next}`);
  console.log('  · 只改代码：把 endpoints.ts 的 LOCAL_API_BASE 换成上面这个');
  console.log('  · 不改代码：开发者工具 → 真机调试 → Storage 面板写入');
  console.log(`      key: qz_api_base   value: ${next}   （仅 develop 生效）`);
}

if (FIX) {
  if (remote)
    console.log(
      '\n（直连线上模式：本脚本**不会**把 LOCAL_API_BASE 改回局域网 IP —— 要切本地后端请手工改 endpoints.ts）',
    );
  // 三个文件都可能绑着本机 IP，**必须一起改** ——
  // 只改 endpoints.ts 的话接口会恢复，但文件下载仍然坏（更隐蔽的那种"只坏一半"）
  const touched = [];
  for (const file of [ENDPOINTS, DEVTOOLS_DOC, envFile]) {
    if (!existsSync(file)) continue;
    const before = readFileSync(file, 'utf8');
    let after = before;
    for (const h of staleHosts) after = after.split(h).join(target);
    if (after === before) continue;
    writeFileSync(file, after, 'utf8');
    touched.push(file.slice(ROOT.length + 1));
  }
  if (appEnvStale) {
    // 生成物不手工改：从源复制一份，与 `npm run setup:env` 的行为一致
    copyFileSync(envFile, APP_ENV);
    touched.push('apps/api/.env');
  }

  if (touched.length) {
    console.log('\n🔧 已修复：');
    for (const f of touched) console.log(`   · ${f}`);
    console.log('   小程序需**重新编译**（endpoints.ts 是编译期常量，热重载不生效）；');
    console.log('   后端需**重启**（.env 只在启动时读一次）。');
  } else {
    console.log('\n（没有可自动修复的项，请按上面的说明人工处理）');
  }
} else if (staleHosts.size || appEnvStale) {
  console.log('\n加 `--fix` 可自动完成上面的替换与同步。');
}

process.exit(1);
