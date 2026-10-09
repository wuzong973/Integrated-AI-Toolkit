/**
 * 端到端验证：订单 + 担保支付链路（任务清单 M3-11 / M3-12 / M3-14 / M3-15）
 *
 * ## 为什么需要它
 *
 * 这条链路横跨三处：`OrderController`（状态机）、`OrderPayService`（资金与回调）、
 * `PayProvider`（支付网关）。**单测覆盖不到它们之间的接缝** —— 单测里 Provider 是桩，
 * "回调 → 幂等 → 金额核对 → 状态迁移 → 钱包入账"这条真实时序只有真进程里才跑得到。
 *
 * 更关键的是：这条链路里**最不能出错的地方，全都是"看起来能跑"的** ——
 * 重复回调重复放款、小额回调付掉大额订单、验收了钱没到账。
 * 本脚本把这几个逐个断言出来，而不是只看"接口返回 200"。
 *
 * ## 它验证什么（真实 HTTP + Mock 支付网关）
 *
 *   ① 下单            POST /orders
 *   ② 发起支付        POST /orders/:id/pay
 *   ③ 回调金额核对    —— 金额不符必须拒绝（防"1 分钱付掉大额订单"）
 *   ④ 支付回调        POST /orders/pay/notify
 *   ⑤ 回调幂等        —— 重复投递不得重复处理
 *   ⑥ 交付            POST /orders/:id/deliver
 *   ⑦ 验收放款        POST /orders/:id/accept + **钱包入账核对**
 *   ⑧ 退款            POST /orders/:id/refund
 *
 * ## 前置
 *
 *   后端已在 `http://127.0.0.1:3000` 运行（`npm run dev:api`）；
 *   数据库可连（用户不足 2 个时脚本会自己造，跑完不清理，便于复用）。
 *
 * ## 用法
 *
 *   npm run verify:order
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const require = createRequire(resolve(ROOT, 'apps/api/package.json'));
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

let failures = 0;
const check = (ok, label, extra = '') => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? '  → ' + extra : ''}`);
};

/** 订单金额：100 元（10000 分）—— 便于心算平台费 5%（封顶 20 元）= 500 分 */
const AMOUNT = 10000;

/** 环境变量：以根 .env 为准，缺的从 apps/api/.env 补 */
function readEnv() {
  const out = {};
  for (const file of [resolve(ROOT, '.env'), resolve(ROOT, 'apps/api/.env')]) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !out[m[1]]) out[m[1]] = m[2].trim();
    }
  }
  return out;
}

/** 用 JWT_SECRET 直接签 access token（载荷与 TokenService.issue 一致），跳过微信登录 */
function signToken(user, env) {
  return jwt.sign(
    { sub: user.id, openid: user.openid, roles: [], isAdmin: false },
    env.JWT_SECRET,
    { expiresIn: '10m' },
  );
}

/** 造一个带 token 的请求器；token 传 null 表示公开接口（如支付回调） */
function makeApi(base, token) {
  return async (path, init = {}) => {
    const headers = { 'content-type': 'application/json', ...(init.headers ?? {}) };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(base + path, { ...init, headers });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };
}

/** 确保至少有 2 个用户（买家 / 服务者），不足则补造 */
async function ensureTwoUsers(prisma) {
  const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' }, take: 2 });
  while (users.length < 2) {
    users.push(
      await prisma.user.create({
        data: {
          openid: `verify_order_${Date.now()}_${users.length}`,
          nickname: `验证用户${users.length + 1}`,
        },
      }),
    );
  }
  return users;
}

/** 模拟支付网关回调报文（与 MockPayProvider.parseCallback 的约定一致） */
const notify = (pub, orderNo, amountCents, success = true) =>
  pub('/orders/pay/notify', {
    method: 'POST',
    body: JSON.stringify({ orderNo, payNo: `mock_pay_${orderNo}`, amountCents, success }),
  });

/** 下单 + 发起支付，返回 orderId / orderNo */
async function createAndPrepay(buyerApi, providerId) {
  const created = await buyerApi('/orders', {
    method: 'POST',
    body: JSON.stringify({ providerId, amount: AMOUNT }),
  });
  const order = created.body?.data;
  check(created.status < 300 && !!order?.id, `① 下单（HTTP ${created.status}）`, order?.orderNo);
  if (!order?.id) throw new Error('下单失败：' + JSON.stringify(created.body));

  const prep = await buyerApi(`/orders/${order.id}/pay`, { method: 'POST' });
  const pre = prep.body?.data;
  check(prep.status < 300 && !!pre?.prepay, `② 发起支付（HTTP ${prep.status}）`, pre?.notifyUrl);
  return order;
}

/**
 * 正向链路：下单 → 支付 → 金额核对 → 回调 → 幂等 → 交付 → 验收放款。
 * @returns 订单 id（供清理）
 */
async function runHappyPath(ctx) {
  const { buyerApi, providerApi, pub, prisma, provider } = ctx;
  const order = await createAndPrepay(buyerApi, provider.id);

  // ③ 金额核对：先用错误金额，必须被拒绝
  const wrong = await notify(pub, order.orderNo, 1);
  check(wrong.status >= 400, `③ 金额不符被拒（HTTP ${wrong.status}）`, wrong.body?.message);

  const afterWrong = await buyerApi(`/orders/${order.id}`);
  check(
    afterWrong.body?.data?.status === 'pending_payment',
    '③ 被拒后订单仍为待支付（未被误标记为已付）',
    afterWrong.body?.data?.status,
  );

  // ④ 正确金额回调
  const ok = await notify(pub, order.orderNo, AMOUNT);
  check(ok.status < 300, `④ 支付回调（HTTP ${ok.status}）`);

  const paid = await buyerApi(`/orders/${order.id}`);
  check(paid.body?.data?.status === 'paid', '④ 订单已变为担保中(paid)', paid.body?.data?.status);

  // ⑤ 幂等：重复投递同一条回调
  const again = await notify(pub, order.orderNo, AMOUNT);
  const afterAgain = await buyerApi(`/orders/${order.id}`);
  check(
    again.status < 300 && afterAgain.body?.data?.status === 'paid',
    '⑤ 重复回调幂等（状态未被打乱）',
    afterAgain.body?.data?.status,
  );

  // ⑥ 服务者交付
  const deliver = await providerApi(`/orders/${order.id}/deliver`, {
    method: 'POST',
    body: JSON.stringify({ fileIds: ['verify-file-1'], remark: '验证脚本交付' }),
  });
  check(
    deliver.status < 300 && deliver.body?.data?.status === 'pending_acceptance',
    `⑥ 交付（HTTP ${deliver.status}）`,
    deliver.body?.data?.status,
  );

  // ⑦ 买家验收放款
  const accept = await buyerApi(`/orders/${order.id}/accept`, {
    method: 'POST',
    body: JSON.stringify({ rating: 5 }),
  });
  check(
    accept.status < 300 && accept.body?.data?.status === 'completed',
    `⑦ 验收（HTTP ${accept.status}）`,
    accept.body?.data?.status,
  );

  // ⑦-2 钱包入账核对：服务者应收到 订单金额 - 平台费
  const expectIncome = AMOUNT - Math.min(Math.round(AMOUNT * 0.05), 2000);
  const ledger = await prisma.walletLedger.findFirst({
    where: { refType: 'order', refId: order.id, type: 'income' },
  });
  check(
    ledger?.amount === expectIncome,
    `⑦ 服务者入账 ${expectIncome} 分`,
    ledger ? `实际 ${ledger.amount} 分` : '**没有入账流水**',
  );

  return order.id;
}

/** 退款链路：下单 → 支付 → 回调 → 退款 */
async function runRefundPath(ctx) {
  const { buyerApi, pub, provider } = ctx;
  const order = await createAndPrepay(buyerApi, provider.id);
  await notify(pub, order.orderNo, AMOUNT);

  const refund = await buyerApi(`/orders/${order.id}/refund`, {
    method: 'POST',
    body: JSON.stringify({ reason: '验证脚本：不需要了' }),
  });
  check(
    refund.status < 300 && refund.body?.data?.status === 'refunded',
    `⑧ 退款（HTTP ${refund.status}）`,
    refund.body?.data?.status,
  );
  return order.id;
}

/** 清掉本次造的数据（walletLedger 无外键，需单独删；其余随订单级联） */
async function cleanup(prisma, orderIds) {
  if (!orderIds.length) return;
  try {
    await prisma.walletLedger.deleteMany({ where: { refType: 'order', refId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    console.log(`\n   ℹ️ 已清理验证订单 ${orderIds.length} 条（含时间线 / 支付记录 / 入账流水）`);
  } catch (e) {
    console.log(`   ⚠️ 清理失败（不影响验证结论）：${e.message}`);
  }
}

async function main() {
  const env = readEnv();
  const base = `http://127.0.0.1:${env.PORT || 3000}${env.API_PREFIX || '/api/v1'}`;
  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });

  try {
    const ping = await fetch(`${base}/health`);
    if (!ping.ok) throw new Error(`HTTP ${ping.status}`);
  } catch (e) {
    console.log(`❌ 后端未运行（${base}）：${e.message}\n   请先执行：npm run dev:api`);
    await prisma.$disconnect();
    process.exit(1);
  }

  const [buyer, provider] = await ensureTwoUsers(prisma);
  const ctx = {
    prisma,
    provider,
    buyerApi: makeApi(base, signToken(buyer, env)),
    providerApi: makeApi(base, signToken(provider, env)),
    pub: makeApi(base, null),
  };

  console.log('='.repeat(74));
  console.log(`   后端：${base}`);
  console.log(`   买家：${buyer.id}（${buyer.nickname ?? '未设置'}）`);
  console.log(`   服务者：${provider.id}（${provider.nickname ?? '未设置'}）`);
  console.log('='.repeat(74) + '\n');

  const orderIds = [];
  try {
    orderIds.push(await runHappyPath(ctx));
    orderIds.push(await runRefundPath(ctx));
  } catch (e) {
    check(false, '流程异常', e.message);
  } finally {
    await cleanup(prisma, orderIds);
    await prisma.$disconnect();
  }

  console.log('\n' + '='.repeat(74));
  console.log(
    failures === 0
      ? '🎉 通过：订单 + 担保支付链路端到端可用（Mock 支付网关）'
      : `❌ 有 ${failures} 项未通过`,
  );
  console.log('='.repeat(74));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
