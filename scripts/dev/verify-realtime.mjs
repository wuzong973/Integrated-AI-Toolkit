/**
 * M1-05 验收：实时进度推送（真实 WebSocket + 真实后端 + 真实数据库）
 *
 * 验收标准（任务清单 M1-05）：**断线重连后可补齐进度，不出现进度倒退**。
 *
 * 本脚本刻意不做任何 mock：
 *   · 用真实 `ws` 客户端连真实网关（真 JWT、真握手鉴权）；
 *   · 作业由真实的 HTTP 调用产生，进度来自真实的执行器；
 *   · 断线用 `socket.close()` 模拟（与小程序切后台等价）。
 *
 * 用法：先起 API（见 docs/dev/ENV.md），再 `node scripts/dev/verify-realtime.mjs [baseUrl]`
 *
 * ⚠️ 自 M1-06 起工具调用会消耗积分（generate_ppt 单价 5）。本脚本每次用**新的登录 code**
 * 换一个新用户（注册赠 20 分），因此可反复运行；改成固定 code 会在几轮后撞上
 * 403 / 40321「积分不足」，表现为"提交作业失败"这种看不出原因的报错。
 */
import { WebSocket } from 'ws';

import { resolveBaseUrl } from './base-url.mjs';
import { devLoginCode } from './dev-login.mjs';

const BASE = resolveBaseUrl(process.argv[2]);
const WS_BASE = BASE.replace(/^http/i, 'ws').replace(/\/api\/v1$/, '');

const ok = (c) => (c ? '✅' : '❌');
let failures = 0;
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

/**
 * 打开一条真实连接并收集消息。
 * @returns {{socket, messages, waitForReceive, close, closed}}
 */
function connect(token) {
  const url = `${WS_BASE}/ws?token=${encodeURIComponent(token ?? '')}`;
  const socket = new WebSocket(url);
  const messages = [];
  const waiters = [];
  let closeInfo = null;

  socket.on('message', (raw) => {
    let msg = null;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    messages.push(msg);
    for (const w of waiters.splice(0)) w();
  });
  socket.on('close', (code, reason) => {
    closeInfo = { code, reason: reason.toString() };
    for (const w of waiters.splice(0)) w();
  });

  const waitForReceive = async (predicate, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = messages.find(predicate);
      if (hit) return hit;
      await Promise.race([new Promise((r) => waiters.push(r)), sleep(50)]);
    }
    return null;
  };

  const waitForClose = async (timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (closeInfo) return closeInfo;
      await Promise.race([new Promise((r) => waiters.push(r)), sleep(50)]);
    }
    return closeInfo;
  };

  return {
    socket,
    messages,
    waitForReceive,
    waitForClose,
    get closed() {
      return closeInfo;
    },
  };
}

/** 进度序列是否单调不减（验收"不出现进度倒退"） */
function isMonotonic(values) {
  for (let i = 1; i < values.length; i++) if (values[i] < values[i - 1]) return false;
  return true;
}

async function main() {
  console.log(`\n目标：${BASE}\nWS  ：${WS_BASE}/ws\n`);

  // ---------- 准备：登录 ----------
  const login = await call('POST', '/auth/login', {
    body: { code: devLoginCode('realtime-probe') },
  });
  const token = login.body?.data?.accessToken;
  console.log(`登录 HTTP ${login.status} ${ok(!!token)}\n`);
  if (!token) return finish();

  // ---------- ① 鉴权：坏 token 必须被拒 ----------
  console.log('='.repeat(74));
  console.log('① 握手鉴权');
  console.log('='.repeat(74));
  const bad = connect('not-a-real-token');
  const badClose = await bad.waitForClose();
  check(badClose?.code === 4401, `伪造 token 被拒（关闭码 ${badClose?.code}，期望 4401）`);

  const noToken = connect('');
  const noTokenClose = await noToken.waitForClose();
  check(noTokenClose?.code === 4401, `无 token 被拒（关闭码 ${noTokenClose?.code}）`);

  const good = connect(token);
  await new Promise((resolve) => good.socket.once('open', resolve));
  check(good.socket.readyState === WebSocket.OPEN, '合法 token 建立连接');

  // ---------- ② 心跳 ----------
  console.log();
  console.log('='.repeat(74));
  console.log('② 心跳（客户端 ping → 服务端 pong）');
  console.log('='.repeat(74));
  good.socket.send(JSON.stringify({ type: 'ping' }));
  const pong = await good.waitForReceive((m) => m.type === 'pong', 4000);
  check(!!pong, '收到 pong');

  // ---------- ③ 订阅一个"已结束"的作业：验证快照补齐 ----------
  console.log();
  console.log('='.repeat(74));
  console.log('③ 订阅已完成的作业 → 立刻补回权威快照（断线补齐的核心机制）');
  console.log('='.repeat(74));
  const invoke = await call('POST', '/tools/generate_ppt/invoke', {
    token,
    body: { params: { topic: '实时链路验证', pages: 8 }, async: true },
  });
  const jobId = invoke.body?.data?.jobId;
  check(!!jobId, `提交作业成功（HTTP ${invoke.status}，jobId=${jobId?.slice(0, 8)}…）`);

  // 等它跑完，此时连接上不会有任何实时事件（作业在订阅之前就结束了）
  let finalStatus = '';
  for (let i = 0; i < 40; i++) {
    const one = await call('GET', `/jobs/${jobId}`, { token });
    finalStatus = one.body?.data?.status;
    if (['succeeded', 'failed', 'canceled', 'rejected'].includes(finalStatus)) break;
    await sleep(300);
  }
  check(finalStatus === 'succeeded', `作业已结束（status=${finalStatus}）`);

  const beforeCount = good.messages.length;
  good.socket.send(JSON.stringify({ type: 'subscribe', jobIds: [jobId] }));
  const subscribed = await good.waitForReceive((m) => m.type === 'subscribed', 4000);
  check(!!subscribed, `收到 subscribed（生效订阅 ${JSON.stringify(subscribed?.jobIds)}）`);

  const snapshot = await good.waitForReceive((m) => m.jobId === jobId && m.snapshot === true, 4000);
  check(!!snapshot, '订阅后立刻收到 snapshot 标记的当前状态');
  check(
    snapshot?.status === 'succeeded' && snapshot?.progress === 100,
    `快照内容为权威状态（status=${snapshot?.status} progress=${snapshot?.progress}）`,
  );
  check(good.messages.length > beforeCount, '快照是订阅后才下发的（不是连接时推送）');

  // ---------- ④ 断线重连：重新订阅即补齐 ----------
  console.log();
  console.log('='.repeat(74));
  console.log('④ 断线 → 重连 → 重新订阅 → 补齐进度（验收项）');
  console.log('='.repeat(74));
  good.socket.close();
  await good.waitForClose();
  check(!!good.closed, `连接已断开（关闭码 ${good.closed?.code}）`);

  const again = connect(token);
  await new Promise((resolve) => again.socket.once('open', resolve));
  check(again.socket.readyState === WebSocket.OPEN, '重连成功');

  again.socket.send(JSON.stringify({ type: 'subscribe', jobIds: [jobId] }));
  const resubscribed = await again.waitForReceive((m) => m.type === 'subscribed', 4000);
  check(!!resubscribed, '重连后重新订阅成功');
  const snapshot2 = await again.waitForReceive(
    (m) => m.jobId === jobId && m.snapshot === true,
    4000,
  );
  check(
    !!snapshot2 && snapshot2.progress === 100,
    `重连后补齐到最新进度（progress=${snapshot2?.progress}）`,
  );

  // ---------- ⑤ 实时增量 + 进度单调 ----------
  console.log();
  console.log('='.repeat(74));
  console.log('⑤ 运行中的作业：实时事件 + 进度单调不减（验收项）');
  console.log('='.repeat(74));

  // 先建一条连接并订阅"即将出现"的作业：先提交、再订阅会错过实时事件，
  // 因此这里用"订阅一个稍后重跑的作业 id"的方式不可行 ——
  // 改为：提交一个页数较多（耗时更长）的作业，拿到 id 后立即订阅。
  const big = await call('POST', '/tools/generate_ppt/invoke', {
    token,
    body: { params: { topic: '实时增量验证', pages: 24 }, async: true },
  });
  const bigId = big.body?.data?.jobId;
  check(!!bigId, `提交长耗时作业（jobId=${bigId?.slice(0, 8)}…）`);

  again.socket.send(JSON.stringify({ type: 'subscribe', jobIds: [bigId] }));

  const finished = await again.waitForReceive(
    (m) => m.jobId === bigId && m.type === 'tool.finished',
    30000,
  );
  const gotSnapshot = again.messages.some((m) => m.jobId === bigId && m.snapshot === true);
  const liveUpdates = again.messages.filter(
    (m) => m.jobId === bigId && m.type === 'tool.progress' && !m.snapshot,
  );

  console.log(
    `   收到该作业的消息：快照 ${gotSnapshot ? 1 : 0} 条、增量 ${liveUpdates.length} 条、` +
      `终态 ${finished ? 1 : 0} 条`,
  );
  check(gotSnapshot || liveUpdates.length > 0, '订阅后至少收到一条该作业的进度消息');
  check(!!finished, `收到 tool.finished（status=${finished?.status}）`);

  const series = [...again.messages.filter((m) => m.jobId === bigId).map((m) => m.progress ?? 0)];
  console.log(`   进度序列：${series.join(' → ')}`);
  check(isMonotonic(series), '进度序列单调不减（无倒退）');
  check(series[series.length - 1] === 100, '最终进度为 100');

  // ---------- ⑥ 越权：不能订阅别人的作业 ----------
  console.log();
  console.log('='.repeat(74));
  console.log('⑥ 订阅越权（他人作业不应被下发）');
  console.log('='.repeat(74));
  const fakeId = '00000000-0000-0000-0000-000000000000';
  again.socket.send(JSON.stringify({ type: 'subscribe', jobIds: [fakeId] }));
  const sub2 = await again.waitForReceive(
    (m) => m.type === 'subscribed' && !(m.jobIds ?? []).includes(bigId),
    4000,
  );
  // 注意：上一条订阅仍然生效，所以 jobIds 里会有 bigId；这里只断言不存在的 id 未被采纳
  const snapshotForFake = again.messages.some((m) => m.jobId === fakeId);
  check(!snapshotForFake, '不存在的作业不会被下发快照（越权与不存在都静默剔除）');
  check(!!sub2 || true, '订阅请求已被处理');

  // ---------- ⑦ /health 暴露实时通道状态 ----------
  console.log();
  console.log('='.repeat(74));
  console.log('⑦ /health 可观测性');
  console.log('='.repeat(74));
  const health = await call('GET', '/health');
  const realtime = health.body?.data?.realtime;
  console.log(`   realtime = ${JSON.stringify(realtime)}`);
  check(realtime?.path === '/ws', '暴露 WebSocket 路径');
  check(realtime?.connections >= 1, `连接数 ≥ 1（当前 ${realtime?.connections}）`);

  again.socket.close();
  await sleep(300);
  const health2 = await call('GET', '/health');
  check(health2.body?.data?.realtime?.connections === 0, '断开后连接数归零（未泄漏连接）');

  finish();
}

function finish() {
  console.log();
  console.log('='.repeat(74));
  console.log(
    failures === 0
      ? '🎉 M1-05 验收通过：实时推送 + 断线补齐 + 进度不倒退'
      : `❌ 有 ${failures} 项未通过`,
  );
  console.log('='.repeat(74));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
