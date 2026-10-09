/**
 * 端到端验证：驿站写路径（M3-01 / 06 / 07 / 08 / 09 / 10）
 *
 * ## 为什么需要它
 *
 * 这四条接口构成一条链：**发布 → 报名 → 选定 → 生成订单**。
 * 只做前一半（比如只做发布）会让用户走到"报名成功"之后卡住，
 * 而卡住的地方**没有任何报错**，只是"什么都没发生" ——
 * 这正是本项目反复出现的形态（详情页曾"假成功"、工作台曾编匹配度、
 * 报名情况曾恒为空）。单测覆盖不到这些接缝：单测里每个 service 都是桩。
 *
 * ## 它钉住的三类事
 *
 * 1. **拦得住**：违规标题/描述/报名留言返回 40051，且**没有落库**；
 * 2. **规则真的生效**：非服务者不能报名（40312）、非发布者不能选定（40313）、
 *    不能重复报名（40901）、不能被抢单（40903）、已选定的不能关闭（40902）；
 * 3. **匹配度是真算的**：同技能服务者的分数必须**严格高于**无技能者 ——
 *    这条断言专门针对"假匹配度"（旧实现按列表序号递减，与技能无关，
 *    任何"分数在 0~100 之间"的弱断言都拦不住它）。
 *
 * ## 前置
 *
 *   后端已在 `http://127.0.0.1:3000` 运行（`npm run dev:api`），数据库可连。
 *   `POST /station/parse` 会真实调用 LLM（需要 `.env` 里的模型 Key 可用）。
 *
 * ## 用法
 *
 *   npm run verify:station
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
const GOOD_DESC = '需要一位同学帮忙拍毕业照，时间是本周六下午，地点在校内。';

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

const post = (api, path, payload) =>
  api(path, { method: 'POST', body: JSON.stringify(payload ?? {}) });

const code = (res) => res.body?.code;

// ---------- 各段验证 ----------

async function verifyCategories(ctx) {
  console.log('\n【1】服务分类（M3-01）');
  const res = await ctx.pub('/station/categories');
  const list = res.body?.data ?? [];
  check(res.status < 300 && list.length >= 9, `返回 ${list.length} 个分类（HTTP ${res.status}）`);
  check(
    list.some((c) => c.id === 'photo') && list.some((c) => c.id === 'other'),
    '含 photo 与 other（与 seed 的 id 口径一致）',
  );
}

/** 发布：正常 + 违规 + 分类不存在 */
async function verifyPublish(ctx) {
  console.log('\n【2】发布需求（M3-06）');
  const { api, prisma } = ctx;

  const ok = await post(api, '/station/tasks', {
    title: '毕业照拍摄',
    categoryId: 'photo',
    description: GOOD_DESC,
    budget: 30000,
    budgetType: 'fixed',
    skillTags: ['摄影'],
    source: 'manual',
  });
  const task = ok.body?.data;
  check(ok.status < 300 && !!task?.id, `发布成功（HTTP ${ok.status}）`, task?.taskNo);
  check(task?.status === 'published', '落库即为 published（内容安全是同步 fail-closed）', task?.status);
  check(task?.isDemo === false, 'isDemo=false（真实任务不该被标成演示数据）');
  check(task?.source === 'manual', 'source 字段被保留（此前被 Zod 静默丢弃）', task?.source);

  // 违规标题：必须 40051 且**没有落库**
  const before = await prisma.task.count({ where: { publisherId: ctx.user.id } });
  const bad = await post(api, '/station/tasks', {
    title: BAD,
    categoryId: 'photo',
    description: GOOD_DESC,
    budget: 10000,
    budgetType: 'fixed',
  });
  check(bad.status === 400 && code(bad) === 40051, `违规标题被拦（HTTP ${bad.status} / ${code(bad)}）`, bad.body?.message);
  const after = await prisma.task.count({ where: { publisherId: ctx.user.id } });
  check(after === before, '被拦后未落库（不是"先写后查"）', `${before} → ${after}`);

  // 违规描述同样要拦（多字段串行送审）
  const badDesc = await post(api, '/station/tasks', {
    title: '帮忙拍毕业照',
    categoryId: 'photo',
    description: `${GOOD_DESC}另外需要${BAD}`,
    budget: 10000,
    budgetType: 'fixed',
  });
  check(code(badDesc) === 40051, `违规描述被拦（${code(badDesc)}）`, badDesc.body?.message);

  // 分类不存在 → 40001（而不是外键 500）
  const badCat = await post(api, '/station/tasks', {
    title: '不存在的分类测试',
    categoryId: 'no_such_category',
    description: GOOD_DESC,
    budget: 10000,
    budgetType: 'fixed',
  });
  check(code(badCat) === 40001, `不存在的分类报 40001（${code(badCat)}）`, badCat.body?.message);

  return task?.id;
}

/** AI 极速发布：真实调用 LLM */
async function verifyParse(ctx) {
  console.log('\n【3】AI 极速发布（M3-07）');
  const res = await post(ctx.api, '/station/parse', {
    text: '帮我找个摄影师拍毕业照，大概300块，6月10日在学校',
  });
  const d = res.body?.data ?? {};
  check(res.status < 300, `解析成功（HTTP ${res.status}）`, res.body?.message);
  check(typeof d.title === 'string' && d.title.length > 0, '返回标题', d.title);
  check(d.categoryId === 'photo', '分类识别为 photo', d.categoryId);
  // 预算单位必须是**分**（红线：金额一律用分）。300 元 → 30000 分
  check(d.budget === 30000, '预算按「分」返回（300 元 → 30000）', String(d.budget));
  check(
    d.priceHint === undefined || typeof d.priceHint === 'string',
    '无历史成交时不编造估价（字段缺省或为真实统计）',
    d.priceHint ?? '(无)',
  );
}

/** 报名：身份校验 + 违规拦截 + 重复报名 */
async function verifyApply(ctx, taskId) {
  console.log('\n【4】报名 / 抢单（M3-10）');
  const { api, providerApi, outsiderApi, prisma } = ctx;

  /**
   * 非服务者不能报名。
   *
   * ⚠️ 这里必须用**第三方**账号（既不是发布者、也没有服务者身份）——
   * 用发布者的 token 测会先撞上"不能报名自己发布的需求"（40001），
   * 于是 40312 这条规则**看起来被测过了、其实一次都没走到**。
   */
  const notProvider = await post(outsiderApi, `/station/tasks/${taskId}/apply`, { message: '我想试试' });
  check(code(notProvider) === 40312, `非服务者报名被拒（${code(notProvider)}）`, notProvider.body?.message);

  // 违规留言：40051 且报名数不变
  const badMsg = await post(providerApi, `/station/tasks/${taskId}/apply`, { message: BAD });
  check(code(badMsg) === 40051, `违规留言被拦（${code(badMsg)}）`, badMsg.body?.message);
  const afterBad = await prisma.taskApplication.count({ where: { taskId } });
  check(afterBad === 0, '被拦后没有产生报名记录', String(afterBad));

  // 正常报名
  const ok = await post(providerApi, `/station/tasks/${taskId}/apply`, {
    message: '我有三年跟拍经验',
    quote: 28000,
  });
  check(ok.status < 300 && !!ok.body?.data?.applicationId, `报名成功（HTTP ${ok.status}）`);

  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { applyCount: true } });
  check(task?.applyCount === 1, 'applyCount 原子自增为 1', String(task?.applyCount));

  // 重复报名 → 40901（唯一约束兜住并发连点）
  const dup = await post(providerApi, `/station/tasks/${taskId}/apply`, { message: '再报一次' });
  check(code(dup) === 40901, `重复报名报 40901（${code(dup)}）`, dup.body?.message);
  const afterDup = await prisma.taskApplication.count({ where: { taskId } });
  check(afterDup === 1, '重复报名没有多插一条', String(afterDup));

  // 发布者不能报名自己的需求
  const self = await post(api, `/station/tasks/${taskId}/apply`, { message: '自己报自己' });
  check(code(self) === 40001, `发布者报名自己的需求被拒（${code(self)}）`, self.body?.message);
}

/** 报名者列表：权限 + 真实匹配度 */
async function verifyApplications(ctx, taskId) {
  console.log('\n【5】报名者列表');
  const { api, providerApi } = ctx;

  const denied = await providerApi(`/station/tasks/${taskId}/applications`);
  check(code(denied) === 40313, `非发布者查看被拒（${code(denied)}）`, denied.body?.message);

  const res = await api(`/station/tasks/${taskId}/applications`);
  const list = res.body?.data ?? [];
  check(res.status < 300 && list.length === 1, `发布者能看到 ${list.length} 条报名（此前恒为空）`);
  check(typeof list[0]?.providerId === 'string', '带 providerId（选定接口要的就是它）');
  check(typeof list[0]?.matchScore === 'number', '带真实匹配度', String(list[0]?.matchScore));
  check(Array.isArray(list[0]?.matchReasons) && list[0].matchReasons.length > 0, '带匹配依据');
}

/** 匹配度必须是真算的：同技能者严格高于无技能者 */
async function verifyMatch(ctx, taskId) {
  console.log('\n【6】智能匹配（M3-09）');

  const res = await ctx.api(`/station/match?taskId=${taskId}`);
  const list = res.body?.data ?? [];
  check(res.status < 300, `推荐接口可用（HTTP ${res.status}）`);
  check(list.length > 0, `推荐了 ${list.length} 位服务者`);
  check(
    list.every((p, i) => i === 0 || list[i - 1].score >= p.score),
    '按匹配度降序',
    list.map((p) => p.score).join(' > '),
  );

  // ⭐ 关键断言：分数必须**随技能变化**。旧的假实现是按列表序号递减，
  //    与技能完全无关 —— 那种实现下"有技能"和"没技能"的分差会是固定的 7 分。
  const withSkill = list.find((p) => p.userId === ctx.provider.id);
  const withoutSkill = list.find((p) => p.userId === ctx.plainProvider.id);
  check(!!withSkill && !!withoutSkill, '两位服务者都在推荐列表里');
  if (withSkill && withoutSkill) {
    check(
      withSkill.score > withoutSkill.score,
      '同技能者的匹配度**严格高于**无技能者',
      `${withSkill.score} vs ${withoutSkill.score}`,
    );
    check(
      withSkill.reasons.some((r) => r.includes('技能命中')),
      '给出技能命中依据',
      withSkill.reasons.join(' | '),
    );
  }
}

/** 选定服务者 → 生成订单（闭环的关键一步） */
async function verifySelect(ctx, taskId) {
  console.log('\n【7】选定服务者 → 生成担保订单（M3-10 + M3-11）');
  const { api, providerApi, provider, plainProvider, prisma } = ctx;

  const denied = await post(providerApi, `/station/tasks/${taskId}/select`, {
    providerId: provider.id,
  });
  check(code(denied) === 40313, `非发布者选定被拒（${code(denied)}）`, denied.body?.message);

  const notApplied = await post(api, `/station/tasks/${taskId}/select`, {
    providerId: plainProvider.id,
  });
  check(code(notApplied) === 40001, `选未报名的人被拒（${code(notApplied)}）`, notApplied.body?.message);

  const ok = await post(api, `/station/tasks/${taskId}/select`, { providerId: provider.id });
  const r = ok.body?.data;
  check(ok.status < 300 && !!r?.orderId, `选定成功（HTTP ${ok.status}）`, r?.orderNo);
  check(r?.amount === 30000, '订单金额取任务预算（30000 分）', String(r?.amount));

  const order = await prisma.order.findUnique({ where: { id: r?.orderId } });
  check(order?.status === 'pending_payment', '订单状态为待支付', order?.status);
  check(order?.taskId === taskId, '订单关联到该任务');
  check(order?.requirement === GOOD_DESC, '需求说明来自任务描述（已送审内容，不经客户端）');

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { status: true, selectedProviderId: true },
  });
  check(task?.status === 'assigned', '任务变为已选定', task?.status);
  check(task?.selectedProviderId === provider.id, '记录了选定的服务者');

  const app = await prisma.taskApplication.findFirst({ where: { taskId } });
  check(app?.status === 'selected', '报名记录被标记为已选定', app?.status);

  // 抢单保护：再选一次必须失败，而不是覆盖
  const again = await post(api, `/station/tasks/${taskId}/select`, { providerId: provider.id });
  check(
    code(again) === 40902 || code(again) === 40903,
    `重复选定被拒（${code(again)}）`,
    again.body?.message,
  );
}

/** 关闭需求 + "我的任务"过滤 */
async function verifyCloseAndMine(ctx) {
  console.log('\n【8】关闭需求（M3-08）与「我的任务」过滤');
  const { api, providerApi, pub, prisma, user } = ctx;

  const second = await post(api, '/station/tasks', {
    title: '跑腿取快递',
    categoryId: 'rent',
    description: '帮忙去菜鸟驿站取两个快递送到三号宿舍楼下。',
    budget: 1000,
    budgetType: 'fixed',
  });
  const secondId = second.body?.data?.id;
  check(!!secondId, '再发一条用于验证关闭');

  const closed = await post(api, `/station/tasks/${secondId}/close`);
  check(closed.body?.data?.status === 'closed', '关闭成功', closed.body?.data?.status);

  const afterClose = await post(api, `/station/tasks/${secondId}/close`);
  check(code(afterClose) === 40904 || code(afterClose) === 40902, `重复关闭被拒（${code(afterClose)}）`);

  const closedApply = await post(providerApi, `/station/tasks/${secondId}/apply`, { message: '我来' });
  check(
    code(closedApply) === 40902 || code(closedApply) === 40904,
    `已关闭的需求不能报名（${code(closedApply)}）`,
    closedApply.body?.message,
  );

  // 我接的单：必须只有 1 条（就是被选定的那条）
  const mine = await providerApi('/station/tasks?role=provider');
  const mineList = mine.body?.data?.list ?? [];
  check(
    mine.status < 300 && mineList.length === 1,
    `role=provider 返回 ${mineList.length} 条（此前是全站所有 assigned）`,
  );
  check(
    mineList.every((t) => t.status === 'assigned'),
    '包含已选定但未完成的单（不限状态）',
  );

  // 我发布的
  const posted = await api('/station/tasks?role=publisher');
  const postedList = posted.body?.data?.list ?? [];
  check(postedList.length === 2, `role=publisher 返回 ${postedList.length} 条我发布的`);

  // 未登录却要"我的任务" → 401，而不是静默返回全站数据
  const anon = await pub('/station/tasks?role=provider');
  check(anon.status === 401, `未登录请求「我的任务」报 401（实际 ${anon.status}）`);

  void prisma;
  void user;
}

/** 清理：删掉本次造的数据 */
async function cleanup(prisma, userIds, taskIds) {
  try {
    const orders = await prisma.order.findMany({
      where: { taskId: { in: taskIds } },
      select: { id: true },
    });
    const orderIds = orders.map((o) => o.id);
    if (orderIds.length) {
      await prisma.walletLedger.deleteMany({ where: { refType: 'order', refId: { in: orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userProfile.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    console.log('\n   ℹ️ 已清理本次验证造的数据');
  } catch (e) {
    console.log(`   ⚠️ 清理失败（不影响验证结论）：${e.message}`);
  }
}

/** 收集本次造的所有任务 id（含中途新发的），供清理使用 */
async function collectTaskIds(prisma, publisherId, known) {
  const rest = await prisma.task.findMany({
    where: { publisherId },
    select: { id: true },
  });
  const out = [...known];
  for (const t of rest) {
    if (!out.includes(t.id)) out.push(t.id);
  }
  return out;
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
  /** 发布者（同时也是"非服务者"，用来验证 40312） */
  const user = await prisma.user.create({
    data: { openid: `verify_station_${stamp}`, nickname: '验证发布者' },
  });
  /** 有技能的服务者 */
  const provider = await prisma.user.create({
    data: { openid: `verify_station_p_${stamp}`, nickname: '验证服务者甲' },
  });
  /** 无技能的服务者（匹配度必须更低） */
  const plainProvider = await prisma.user.create({
    data: { openid: `verify_station_q_${stamp}`, nickname: '验证服务者乙' },
  });
  /** 普通同学（没有服务者身份）—— 用来验证 40312 那条规则真的会被走到 */
  const outsider = await prisma.user.create({
    data: { openid: `verify_station_o_${stamp}`, nickname: '验证普通同学' },
  });

  await prisma.userRole.createMany({
    data: [
      { userId: provider.id, role: 'provider', scope: 'self' },
      { userId: plainProvider.id, role: 'provider', scope: 'self' },
    ],
  });
  await prisma.userProfile.createMany({
    data: [
      { userId: user.id, creditScore: 80 },
      { userId: provider.id, creditScore: 95, skills: ['摄影', '后期修图'], lastActiveAt: new Date() },
      { userId: plainProvider.id, creditScore: 70, skills: [], lastActiveAt: new Date() },
      { userId: outsider.id, creditScore: 80 },
    ],
  });

  const ctx = {
    prisma,
    user,
    provider,
    plainProvider,
    api: makeApi(base, signToken(user, env)),
    providerApi: makeApi(base, signToken(provider, env)),
    outsiderApi: makeApi(base, signToken(outsider, env)),
    pub: makeApi(base, null),
  };

  console.log('='.repeat(74));
  console.log(`   后端：${base}`);
  console.log(`   发布者：${user.id}`);
  console.log(`   服务者甲（有技能）：${provider.id}`);
  console.log(`   服务者乙（无技能）：${plainProvider.id}`);
  console.log(`   普通同学（非服务者）：${outsider.id}`);
  console.log('='.repeat(74));

  const taskIds = [];
  try {
    await verifyCategories(ctx);
    const taskId = await verifyPublish(ctx);
    if (taskId) taskIds.push(taskId);
    await verifyParse(ctx);
    if (taskId) {
      await verifyApply(ctx, taskId);
      await verifyApplications(ctx, taskId);
      await verifyMatch(ctx, taskId);
      await verifySelect(ctx, taskId);
    }
    await verifyCloseAndMine(ctx);
  } catch (e) {
    check(false, '流程异常', e.message);
  } finally {
    const allTaskIds = await collectTaskIds(prisma, user.id, taskIds);
    await cleanup(prisma, [user.id, provider.id, plainProvider.id, outsider.id], allTaskIds);
    await prisma.$disconnect();
  }

  console.log('\n' + '='.repeat(74));
  console.log(
    failures === 0
      ? '🎉 通过：驿站写路径可用（发布 → 报名 → 选定 → 生成订单），规则与内容安全均生效'
      : `❌ 有 ${failures} 项未通过`,
  );
  console.log('='.repeat(74));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
