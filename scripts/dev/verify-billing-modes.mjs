/**
 * 计费开关的一致性验收（真实后端 + 真实 MySQL）
 *
 * ## 它验的是什么
 *
 * 不假设"现在应该是免费还是计费"，而是读 `GET /config/public` 声称的模式，
 * 然后**用真实的一笔作业去证明后端确实按这个模式在办事**：
 *
 *   mode = "free"   → 作业照样能跑成功，但**积分一分不动、流水一条不写**
 *   mode = "points" → 作业成功后积分恰好减少一个单价，且流水是 precharge + charge
 *
 * 这样同一份脚本在两种模式下都能跑，验证的是"**说的和做的必须一致**"——
 * 这恰恰是切换开关时最可能出问题的地方（接口说免费、某条路径仍在扣分）。
 *
 * 用法：
 *   # 免费态（默认）
 *   BILLING_ENABLED=false 起服务 → node scripts/dev/verify-billing-modes.mjs
 *   # 计费态
 *   BILLING_ENABLED=true  起服务 → node scripts/dev/verify-billing-modes.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma/client';

import { resolveBaseUrl } from './base-url.mjs';
import { devLoginCode } from './dev-login.mjs';

const BASE = resolveBaseUrl(process.argv[2]);
const ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/api/.env');

let failures = 0;
const ok = (c) => (c ? '✅' : '❌');
const check = (cond, label) => {
  if (!cond) failures += 1;
  console.log(`   ${ok(cond)} ${label}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, { body, token, headers } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

function readDatabaseUrl() {
  const text = readFileSync(ENV_FILE, 'utf8');
  const line = text.split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error(`未在 ${ENV_FILE} 找到 DATABASE_URL`);
  return line.slice('DATABASE_URL='.length).trim();
}

/**
 * 轮询等待作业终态。
 *
 * ## 超时上限为什么是 120s
 *
 * 曾经是 40s —— 而 LLM 调用链最坏可以到 `LLM_TOTAL_BUDGET_MS`（45s）加上
 * 队列排队与落库时间，40s 会**偶发地**在正常作业上超时（实测踩到过：
 * 首轮失败、重跑即过，被误当成 flaky）。120s 留出了 2 倍余量。
 *
 * ## 超时为什么必须"可辨认"
 *
 * 曾经超时后直接返回 `last`（可能是 null 或半截数据），于是断言报出
 * `status=undefined` —— 排查时看到的是"状态不对"，真实原因却是"没等到"。
 * 这类**归因错误**比失败本身更贵。现在返回带 `timedOut` 的伪状态，
 * 失败信息一眼能区分"作业真的失败了"和"我们没等够"。
 */
async function waitTerminal(token, jobId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await call('GET', `/jobs/${jobId}`, { token })).body?.data;
    if (last && ['succeeded', 'failed', 'canceled', 'rejected'].includes(last.status)) return last;
    await sleep(300);
  }
  return { ...(last ?? {}), status: last?.status ?? '(等待超时)', timedOut: true };
}

/** 免费态应满足的性质 */
async function verifyFree(db, token, userId, job, pointsBefore, pointsAfter, rows) {
  check(job?.status === 'succeeded', `作业照常跑成功（status=${job?.status}）—— 免费不等于不能用`);
  check(pointsAfter === pointsBefore, `积分一分未动（${pointsBefore} → ${pointsAfter}）`);
  check(rows.length === 0, `没有产生任何积分流水（实际 ${rows.length} 条）`);
  check(
    job?.cost !== undefined && job?.cost >= 0,
    `作业仍记录了标价 cost=${job?.cost}（用于统计免费期让利额度）`,
  );

  // 余额为 0 的用户也必须能用（免费模式不得出现"积分不足"）
  const poor = await db.wallet.findUnique({ where: { userId } });
  if (poor) {
    await db.wallet.update({ where: { userId }, data: { points: 0 } });
    const invoke = await call('POST', '/tools/generate_ppt/invoke', {
      token,
      body: { params: { topic: '零余额免费验证' }, async: true },
    });
    check(invoke.status === 201, `余额为 0 时仍可提交（HTTP ${invoke.status}，未出现 403）`);
    const poorJob = await waitTerminal(token, invoke.body?.data?.jobId);
    check(poorJob?.status === 'succeeded', `零余额作业也跑成功（status=${poorJob?.status}）`);
  }
}

/** 计费态应满足的性质 */
async function verifyPoints(db, token, userId, job, pointsBefore, pointsAfter, rows, price) {
  check(job?.status === 'succeeded', `作业成功（status=${job?.status}）`);
  check(
    pointsAfter === pointsBefore - price,
    `积分恰好减少一个单价（${pointsBefore} → ${pointsAfter}，单价 ${price}）`,
  );
  const kinds = rows.map((r) => r.kind);
  check(kinds.includes('precharge'), '产生了预扣流水（precharge）');
  check(kinds.includes('charge'), '成功后台账有转正行（charge，delta=0）');
  check(
    rows.reduce((s, r) => s + r.delta, 0) === pointsAfter - pointsBefore,
    '流水净额 = 余额变化（账实相符）',
  );
  void db;
  void userId;
}

async function main() {
  console.log(`\n目标：${BASE}\n`);
  const prisma = new PrismaClient({ datasources: { db: { url: readDatabaseUrl() } } });

  try {
    // ---------- ① 接口声称的模式 ----------
    console.log('='.repeat(74));
    console.log('① 读取 /config/public 声称的模式');
    console.log('='.repeat(74));
    const cfg = (await call('GET', '/config/public')).body?.data;
    const mode = cfg?.billing?.mode;
    console.log(`   billing = ${JSON.stringify(cfg?.billing)}`);
    check(mode === 'free' || mode === 'points', `模式合法（mode=${mode}）`);
    check(
      cfg?.billing?.enabled === (mode === 'points'),
      'enabled 与 mode 自洽（不会出现"说免费却在扣费"）',
    );
    if (mode === 'free')
      check(!!cfg.billing.notice, `免费期下发了展示文案："${cfg.billing.notice}"`);

    // ---------- ② 用一笔真实作业证明后端确实照做 ----------
    console.log();
    console.log('='.repeat(74));
    console.log(`② 真实作业验证（模式 = ${mode}）`);
    console.log('='.repeat(74));

    const login = await call('POST', '/auth/login', {
      body: { code: devLoginCode('billing-mode') },
    });
    const token = login.body?.data?.accessToken;
    const userId = login.body?.data?.user?.id;
    if (!token) {
      check(false, '登录失败，后续无法验证');
      return;
    }

    const pointsBefore = (await call('GET', '/user/points', { token })).body?.data?.points ?? 0;
    const price = (await prisma.tool.findUnique({ where: { name: 'generate_ppt' } }))?.price ?? 0;
    console.log(
      `   新用户 ${String(userId).slice(0, 8)}…  初始积分 ${pointsBefore}  单价 ${price}`,
    );

    const invoke = await call('POST', '/tools/generate_ppt/invoke', {
      token,
      body: { params: { topic: '计费模式一致性验证', pages: 6 }, async: true },
    });
    check(invoke.status === 201, `提交作业 HTTP ${invoke.status}`);
    const job = await waitTerminal(token, invoke.body?.data?.jobId);

    const pointsAfter = (await call('GET', '/user/points', { token })).body?.data?.points ?? 0;
    const rows = await prisma.pointsLedger.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    if (mode === 'free') {
      await verifyFree(prisma, token, userId, job, pointsBefore, pointsAfter, rows);
    } else {
      await verifyPoints(prisma, token, userId, job, pointsBefore, pointsAfter, rows, price);
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log();
  console.log('='.repeat(74));
  console.log(
    failures === 0
      ? '🎉 通过：接口声称的模式与实际行为一致'
      : `❌ 有 ${failures} 项不一致 —— 开关没有真正生效`,
  );
  console.log('='.repeat(74));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
