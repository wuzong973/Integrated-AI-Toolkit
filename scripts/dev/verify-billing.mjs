/**
 * 计费链路验收（真实后端 + 真实 MySQL）
 *
 * ## 它验的是什么
 *
 * 直接连数据库核对**钱账**：预扣 → 成功转正 / 失败退回 / 幂等重放 / 余额不足 / 对账相符。
 * 只看接口返回是不够的 —— 计费的正确性最终体现在 `points_ledger` 的流水与
 * `wallet.points` 的余额上，所以这里既打 HTTP 也直连 MySQL。
 *
 * ## 为什么要直连数据库
 *
 * "接口说扣了" 与 "账上真扣了" 是两件事。事务没提交、原生 SQL 写错列、
 * 幂等键没生效导致的重复扣减 —— 这些在接口层完全看不出来，
 * 只有把流水行读出来比对才能发现。
 *
 * 用法：
 *   node scripts/dev/verify-billing.mjs [baseUrl]
 *   # baseUrl 缺省时读 .env 的 PORT / API_PREFIX（见 base-url.mjs）
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

/** 一次验收运行的全部上下文 */
function makeContext(prisma, token, userId) {
  return {
    prisma,
    token,
    userId,
    ledger: () =>
      prisma.pointsLedger.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    wallet: () => prisma.wallet.findUnique({ where: { userId } }),
    points: async () => (await prisma.wallet.findUnique({ where: { userId } }))?.points ?? 0,
    priceOf: async (name) => (await prisma.tool.findUnique({ where: { name } }))?.price ?? 0,
    invoke: (toolName, body, headers) =>
      call('POST', `/tools/${toolName}/invoke`, { token, body, headers }),
  };
}

const rule = (title) => {
  console.log();
  console.log('='.repeat(74));
  console.log(title);
  console.log('='.repeat(74));
};

// ---------- ① 成功路径 ----------

async function verifySuccessPath(ctx, initialPoints, pptPrice) {
  rule('① 成功路径：预扣 → 成功转正（积分净减少 = 单价）');

  const invoke = await ctx.invoke('generate_ppt', {
    params: { topic: '计费成功路径', pages: 8 },
    async: true,
  });
  const job = await waitTerminal(ctx.token, invoke.body?.data?.jobId);
  check(job?.status === 'succeeded', `作业成功（status=${job?.status}）`);

  const rows = await ctx.ledger();
  const pre = rows.find((r) => r.refId === job.id && r.kind === 'precharge');
  const charge = rows.find((r) => r.refId === job.id && r.kind === 'charge');
  check(!!pre, `写入预扣流水（delta=${pre?.delta}）`);
  check(pre?.delta === -pptPrice, `预扣金额等于单价（${pre?.delta} == -${pptPrice}）`);
  check(!!charge, '成功后台账写入转正确认行（kind=charge）—— 原生 SQL 与事务均生效');
  check(charge?.delta === 0, `转正行金额为 0（不重复扣减，delta=${charge?.delta}）`);

  const w = await ctx.wallet();
  check(w?.points === initialPoints - pptPrice, `余额 = 初始 - 单价（${w?.points}）`);
  check(
    pre?.balanceAfter === w?.points && charge?.balanceAfter === w?.points,
    '流水的 balance_after 与钱包余额一致',
  );
  return job;
}

// ---------- ② 失败路径 ----------

async function verifyFailurePath(ctx, bgPrice) {
  rule('② 失败路径：预扣 → 退回（积分原路还回）');
  const before = await ctx.points();

  // 传入不存在的入参文件：执行器读不到文件必然失败 → 走退回
  const invoke = await ctx.invoke('remove_background', {
    params: {},
    fileIds: ['00000000-0000-0000-0000-000000000000'],
    async: true,
  });
  const jobId = invoke.body?.data?.jobId;
  check(!!jobId, `提交必然失败的作业（HTTP ${invoke.status}）`);

  const job = await waitTerminal(ctx.token, jobId);
  check(job?.status === 'failed', `作业失败（status=${job?.status}，error=${job?.error}）`);

  const rows = await ctx.ledger();
  const pre = rows.find((r) => r.refId === jobId && r.kind === 'precharge');
  const refund = rows.find((r) => r.refId === jobId && r.kind === 'refund');
  check(!!pre && pre.delta === -bgPrice, `写入预扣流水（delta=${pre?.delta}）`);
  check(!!refund, '失败后写入退回流水');
  check(refund?.delta === -pre?.delta, `退回额等于预扣额（${refund?.delta}）`);
  check((await ctx.points()) === before, `余额恢复（${await ctx.points()}）`);
}

// ---------- ③ 重复回调 ----------

async function verifyIdempotency(ctx, pptPrice) {
  rule('③ 重复回调：同一幂等键 / 同一作业只扣一次');
  const key = `billing-idem-${Date.now()}`;
  const before = await ctx.points();

  const first = await ctx.invoke(
    'generate_ppt',
    { params: { topic: '幂等计费' }, async: true },
    { 'Idempotency-Key': key },
  );
  const second = await ctx.invoke(
    'generate_ppt',
    { params: { topic: '幂等计费' }, async: true },
    { 'Idempotency-Key': key },
  );
  check(
    first.body?.data?.jobId === second.body?.data?.jobId && second.body?.data?.reused === true,
    '同一幂等键返回同一作业且 reused=true',
  );

  await waitTerminal(ctx.token, first.body?.data?.jobId);
  const after = await ctx.points();
  check(after === before - pptPrice, `只扣了一次单价（${before} → ${after}）`);

  const rows = await ctx.ledger();
  const precharges = rows.filter(
    (r) => r.refId === first.body?.data?.jobId && r.kind === 'precharge',
  );
  check(precharges.length === 1, `该作业只有 1 条预扣流水（实际 ${precharges.length} 条）`);
}

// ---------- ④ 余额不足 ----------

async function verifyInsufficient(ctx, pptPrice) {
  rule('④ 余额不足：明确拒绝（403 / 40321），作业落 rejected、余额不变');

  let guard = 0;
  while ((await ctx.points()) >= pptPrice && guard < 12) {
    const r = await ctx.invoke('generate_ppt', {
      params: { topic: `耗尽余额 ${guard}` },
      async: true,
    });
    await waitTerminal(ctx.token, r.body?.data?.jobId);
    guard += 1;
  }
  const drained = await ctx.points();
  console.log(`   已把余额消耗到 ${drained}（单价 ${pptPrice}）`);

  const poor = await ctx.invoke('generate_ppt', { params: { topic: '余额不足' }, async: true });
  console.log(`   HTTP ${poor.status}  code=${poor.body?.code}  message=${poor.body?.message}`);
  check(poor.status === 403, '返回 403');
  check(poor.body?.code === 40321, '错误码为 40321（积分不足）');
  check(
    !!poor.body?.detail && poor.body.detail.n > 0,
    `detail 带"还差多少分"（n=${poor.body?.detail?.n}）`,
  );

  const rejected = await ctx.prisma.toolJob.findFirst({
    where: { userId: ctx.userId, status: 'rejected' },
    orderBy: { createdAt: 'desc' },
  });
  check(!!rejected, '作业被置为 rejected（用户能看到"提交过但没跑"）');
  check((await ctx.points()) === drained, `被拒时余额未变动（${drained}）`);
}

// ---------- ⑤ 对账 ----------

async function verifyReconciliation(ctx, initialPoints) {
  rule('⑤ 对账：流水净额 = 余额变化');

  const rows = await ctx.ledger();
  const net = rows.reduce((sum, r) => sum + r.delta, 0);
  const finalPoints = await ctx.points();
  console.log(`   流水 ${rows.length} 条：净额 ${net}；余额 ${initialPoints} → ${finalPoints}`);

  const breakdown = {};
  for (const r of rows) breakdown[r.kind] = (breakdown[r.kind] ?? 0) + 1;
  console.log(`   分布：${JSON.stringify(breakdown)}`);

  check(net === finalPoints - initialPoints, '流水净额等于余额变化（账实相符）');
  check(finalPoints >= 0, `余额从未变成负数（${finalPoints}）`);
  check(
    !!rows.find((r) => r.kind === 'precharge') &&
      !!rows.find((r) => r.kind === 'charge') &&
      !!rows.find((r) => r.kind === 'refund'),
    '三种流水类型都真实落库过（precharge / charge / refund）',
  );
}

async function main() {
  console.log(`\n目标：${BASE}\n`);

  // 前置守卫：模式不对就别跑了（断言必然全灭，而"模式不对"和"代码坏了"看起来一样）
  const cfg = await call('GET', '/config/public');
  const mode = cfg.body?.data?.billing?.mode;
  if (mode !== 'points') {
    console.log('='.repeat(74));
    console.log(`❌ 当前计费模式是 "${mode}"，本脚本要求 "points"（BILLING_ENABLED=true）。`);
    console.log('   免费开放期下积分不会变动，这些断言必然失败 —— 不是 bug，是模式不对。');
    console.log('   想验证开关是否生效：node scripts/dev/verify-billing-modes.mjs');
    console.log('='.repeat(74));
    process.exit(2);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: readDatabaseUrl() } } });

  try {
    // 每次跑用新的 code → 新用户 → 初始积分固定，避免上一轮的余额干扰
    const login = await call('POST', '/auth/login', {
      body: { code: devLoginCode('billing-probe') },
    });
    const token = login.body?.data?.accessToken;
    const userId = login.body?.data?.user?.id;
    console.log(`登录 HTTP ${login.status}，userId=${String(userId).slice(0, 8)}…`);
    if (!token) return;

    const ctx = makeContext(prisma, token, userId);
    const initialPoints = await ctx.points();
    const pptPrice = await ctx.priceOf('generate_ppt');
    const bgPrice = await ctx.priceOf('remove_background');
    console.log(
      `初始积分：${initialPoints}；单价：generate_ppt=${pptPrice}，remove_background=${bgPrice}`,
    );

    await verifySuccessPath(ctx, initialPoints, pptPrice);
    await verifyFailurePath(ctx, bgPrice);
    await verifyIdempotency(ctx, pptPrice);
    await verifyInsufficient(ctx, pptPrice);
    await verifyReconciliation(ctx, initialPoints);
  } finally {
    await prisma.$disconnect();
  }

  console.log();
  console.log('='.repeat(74));
  console.log(
    failures === 0 ? '🎉 M1-06 验收通过：三条路径 + 幂等 + 对账相符' : `❌ 有 ${failures} 项未通过`,
  );
  console.log('='.repeat(74));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
