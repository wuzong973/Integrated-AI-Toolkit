/**
 * 端到端验证：内容安全关卡（任务清单 M4-05，红线）
 *
 * ## 为什么需要它
 *
 * M4-05 此前是**"Provider 存在但没有任何调用方"** 的状态 ——
 * `WechatModerationProvider` 写好了、`MODERATION_DRIVER` 也配好了、
 * 单测也能跑，但所有 UGC 写入口实际处于裸奔：用户改昵称、填交付说明、
 * 写退款理由都不经任何检查。**"接了但没人调"这件事在单测里完全看不出来** ——
 * 单测直接 new 一个 service，永远不会暴露"没人 new 它"。
 *
 * 本脚本走真实 HTTP，逐条钉住三件事：
 *
 *   ① **拦得住** —— 违规内容返回 40051；
 *   ② **没落库** —— 被拦的内容不能已经写进数据库（"先写后查"是最常见的实现错误）；
 *   ③ **不误伤** —— 正常内容照样通过（拦太狠等于功能坏了，且比漏拦更难发现）。
 *
 * ## 覆盖的入口
 *
 *   · `PUT  /user/me`                    昵称 / 个人简介   scene=profile
 *   · `POST /os/sessions/:id/messages`   AI 会话消息       scene=log
 *   · `POST /orders/:id/deliver`         交付说明          scene=comment
 *   · `POST /orders/:id/refund`          退款理由          scene=comment
 *
 * ## 前置
 *
 *   后端已在 `http://127.0.0.1:3000` 运行（`npm run dev:api`），数据库可连。
 *   `MODERATION_DRIVER=mock` 即可 —— 内置词库对「代考」「校园贷」这类
 *   字面固定的校园灰色交易是**与真实实现共用同一份判据**的
 *   （见 `MockModerationProvider` 的说明），所以本脚本的结论与驱动无关。
 *
 * ## 用法
 *
 *   npm run verify:moderation
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

/** 违规样例：命中 `CAMPUS_LEXICON` 的「代考」，本地词库与真实实现都会拦 */
const BAD = '提供代考服务，包过';
/** 正常样例：必须是真能过审的普通校园文案 */
const GOOD = '帮带一份食堂的饭';

const ORDER_AMOUNT = 5000;

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

function signToken(user, env) {
  return jwt.sign(
    { sub: user.id, openid: user.openid, roles: [], isAdmin: false },
    env.JWT_SECRET,
    { expiresIn: '10m' },
  );
}

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

const post = (api, path, payload) => api(path, { method: 'POST', body: JSON.stringify(payload) });

/** 断言"被内容安全拦下"：HTTP 400 + 业务码 40051 + 文案指明字段 */
function expectBlocked(res, field, label) {
  const code = res.body?.code;
  const message = res.body?.message ?? '';
  check(res.status === 400, `${label}：HTTP 400（实际 ${res.status}）`);
  check(code === 40051, `${label}：错误码 40051（实际 ${code}）`, message);
  check(message.includes(field), `${label}：文案指明「${field}」`, message);
}

// ---------- 各入口的验证 ----------

/** ① 用户资料（昵称 / 简介） */
async function verifyProfile(ctx) {
  const { api, prisma, user } = ctx;
  console.log('\n【1】用户资料（PUT /user/me）');

  const ok = await api('/user/me', {
    method: 'PUT',
    body: JSON.stringify({ nickname: '验证用户甲' }),
  });
  check(ok.status < 300, `正常昵称通过（HTTP ${ok.status}）`);

  const badNick = await api('/user/me', {
    method: 'PUT',
    body: JSON.stringify({ nickname: BAD }),
  });
  expectBlocked(badNick, '昵称', '违规昵称');

  // 关键：拦下之后**昵称不能已经被写进库**（"先写后查"是最常见的实现错误）
  const afterNick = await prisma.user.findUnique({
    where: { id: user.id },
    select: { nickname: true },
  });
  check(
    afterNick?.nickname === '验证用户甲',
    '被拦后昵称未被写入（仍是上一次的合法值）',
    afterNick?.nickname ?? '(null)',
  );

  const badBio = await api('/user/me', {
    method: 'PUT',
    body: JSON.stringify({ bio: BAD }),
  });
  expectBlocked(badBio, '个人简介', '违规简介');

  const afterBio = await prisma.userProfile.findUnique({
    where: { userId: user.id },
    select: { bio: true },
  });
  check(!afterBio?.bio, '被拦后简介未落库', afterBio?.bio ?? '(无记录)');
}

/** ② AI 会话消息 */
async function verifyOsMessage(ctx) {
  const { api, prisma } = ctx;
  console.log('\n【2】AI 会话消息（POST /os/sessions/:id/messages）');

  const session = await post(api, '/os/sessions', { title: '内容安全验证' });
  const sessionId = session.body?.data?.id;
  check(!!sessionId, `建会话（HTTP ${session.status}）`);
  if (!sessionId) return null;

  const before = await prisma.osMessage.count({ where: { sessionId } });
  const bad = await post(api, `/os/sessions/${sessionId}/messages`, { content: BAD });
  expectBlocked(bad, '消息内容', '违规消息');

  const after = await prisma.osMessage.count({ where: { sessionId } });
  check(after === before, '被拦后消息未入库（未把违规内容存下来再报错）', `${before} → ${after}`);
  return sessionId;
}

/** ③④ 交付说明 + 退款理由（需要一条已支付订单） */
async function verifyOrderPaths(ctx) {
  const { api, providerApi, pub, provider } = ctx;
  console.log('\n【3】交付说明 / 退款理由（POST /orders/:id/deliver | /refund）');

  const created = await post(api, '/orders', { providerId: provider.id, amount: ORDER_AMOUNT });
  const order = created.body?.data;
  check(!!order?.id, `下单（HTTP ${created.status}）`);
  if (!order?.id) return null;

  await post(api, `/orders/${order.id}/pay`, {});
  await post(pub, '/orders/pay/notify', {
    orderNo: order.orderNo,
    payNo: `mock_pay_${order.orderNo}`,
    amountCents: ORDER_AMOUNT,
    success: true,
  });
  const paid = await api(`/orders/${order.id}`);
  check(paid.body?.data?.status === 'paid', '订单进入担保中(paid)', paid.body?.data?.status);

  // 违规交付说明
  const badDeliver = await post(providerApi, `/orders/${order.id}/deliver`, {
    fileIds: ['verify-file-1'],
    remark: BAD,
  });
  expectBlocked(badDeliver, '交付说明', '违规交付说明');

  const stillPaid = await api(`/orders/${order.id}`);
  check(
    stillPaid.body?.data?.status === 'paid',
    '被拦后订单状态未变（没把交付物写进去）',
    stillPaid.body?.data?.status,
  );

  // 正常交付说明必须能过 —— 拦太狠等于功能坏了，且比漏拦更难发现
  const goodDeliver = await post(providerApi, `/orders/${order.id}/deliver`, {
    fileIds: ['verify-file-1'],
    remark: GOOD,
  });
  check(
    goodDeliver.status < 300 && goodDeliver.body?.data?.status === 'pending_acceptance',
    `正常交付说明通过（HTTP ${goodDeliver.status}）`,
    goodDeliver.body?.data?.status,
  );

  // 违规退款理由
  const badRefund = await post(api, `/orders/${order.id}/refund`, { reason: BAD });
  expectBlocked(badRefund, '退款理由', '违规退款理由');

  const stillPending = await api(`/orders/${order.id}`);
  check(
    stillPending.body?.data?.status === 'pending_acceptance',
    '被拦后订单状态未变（没误触发退款）',
    stillPending.body?.data?.status,
  );

  // 正常退款理由必须能过
  const goodRefund = await post(api, `/orders/${order.id}/refund`, { reason: GOOD });
  check(
    goodRefund.status < 300 && goodRefund.body?.data?.status === 'refunded',
    `正常退款理由通过（HTTP ${goodRefund.status}）`,
    goodRefund.body?.data?.status,
  );

  return order.id;
}

/** 清掉本次造的数据（walletLedger 无外键，需单独删） */
async function cleanup(prisma, orderIds, sessionId, userId, providerId) {
  try {
    if (orderIds.length) {
      await prisma.walletLedger.deleteMany({
        where: { refType: 'order', refId: { in: orderIds } },
      });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    if (sessionId) await prisma.osSession.deleteMany({ where: { id: sessionId } });
    await prisma.userProfile.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, providerId] } } });
    console.log('\n   ℹ️ 已清理本次验证造的数据');
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

  const stamp = Date.now();
  const user = await prisma.user.create({
    data: { openid: `verify_mod_${stamp}`, nickname: '验证用户乙' },
  });
  const provider = await prisma.user.create({
    data: { openid: `verify_mod_provider_${stamp}`, nickname: '验证服务者' },
  });

  const ctx = {
    prisma,
    user,
    provider,
    api: makeApi(base, signToken(user, env)),
    providerApi: makeApi(base, signToken(provider, env)),
    pub: makeApi(base, null),
  };

  console.log('='.repeat(74));
  console.log(`   后端：${base}`);
  console.log(`   审核驱动：${env.MODERATION_DRIVER || 'mock'}`);
  console.log(`   违规样例：${BAD}`);
  console.log('='.repeat(74));

  const orderIds = [];
  let sessionId = null;
  try {
    await verifyProfile(ctx);
    sessionId = await verifyOsMessage(ctx);
    const orderId = await verifyOrderPaths(ctx);
    if (orderId) orderIds.push(orderId);
  } catch (e) {
    check(false, '流程异常', e.message);
  } finally {
    await cleanup(prisma, orderIds, sessionId, user.id, provider.id);
    await prisma.$disconnect();
  }

  console.log('\n' + '='.repeat(74));
  console.log(
    failures === 0
      ? '🎉 通过：内容安全关卡已生效，UGC 入口拦得住且不误伤'
      : `❌ 有 ${failures} 项未通过`,
  );
  console.log('='.repeat(74));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
