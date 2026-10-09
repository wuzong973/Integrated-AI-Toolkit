#!/usr/bin/env node
/**
 * 端到端验证：管理后台控制台（登录 / 权限 / 增删改查 / 数据流转）
 *
 * ## 为什么默认打 5173 而不是 3100
 *
 * 后端接口本身已被 `verify:auth` 之类脚本覆盖过；**本脚本要额外证明的是
 * "前端那条路真的通"**：Vite 的 `/api` 代理、前端 `apps/admin/src/lib/api/*`
 * 里写的路径与载荷、后端 controller 的路由，三者必须严丝合缝。
 *
 * 这类错配的典型症状是 **404 或"筛选没生效"**，而不是报错：
 * 前端换了参数名（比如 `pageSize`），zod 默认值会把它悄悄吃掉，
 * 界面表现为"翻了页但内容没变"。所以这里**逐个断言读回来的数据**，
 * 而不是只看 HTTP 200。
 *
 * ## 为什么写操作要么可自清理，要么是同值幂等写入
 *
 * 本脚本会被反复运行，也可能被人在生产库上误跑：
 * - 管理员账号：建探针 → 用 → 删（自清理，且删的是 `admin_account` 与角色，
 *   User 本体按设计保留）；
 * - 用户状态 / 工具上下线：**写入当前值**（幂等），证明写路径通但不改变任何状态。
 *   绝不"先封禁再恢复"——脚本中途挂掉就会把一个真实用户留在封禁态。
 * - 改密码只在**探针账号**上做，绝不碰超管口令（那会把整个项目的登录凭据弄丢）。
 *
 * ## 前置
 *
 *   后端已在运行（`npm run dev:api`），前端 dev server 已在运行（`npm run dev:admin`）。
 *
 * ## 用法
 *
 *   npm run verify:admin
 *   npm run verify:admin -- http://127.0.0.1:3100      # 直连后端（跳过代理）
 */

const ORIGIN = (process.argv[2] ?? process.env.QZ_ADMIN_ORIGIN ?? 'http://127.0.0.1:5173').replace(
  /\/+$/,
  '',
);
const API = `${ORIGIN}/api/v1`;

/** 超管凭据：与 `docs` 中记录的一致（仅本地开发库） */
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'wzl88888';

/** 探针账号：每次运行都重建，跑完删除 */
const PROBE_USER = 'verify_console';
const PROBE_PASS = 'Probe#2026';
const PROBE_PASS2 = 'Probe#2026b';

const failures = [];

function section(title) {
  console.log(`\n${title}`);
}

function check(ok, label, extra = '') {
  if (!ok) failures.push(label);
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? '  → ' + extra : ''}`);
}

function note(msg) {
  console.log(`   · ${msg}`);
}

/**
 * @returns {Promise<{status:number, code?:number, data?:any, message?:string}>}
 */
async function call(method, path, { token, body } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return {
    status: res.status,
    code: json?.code,
    data: json?.data,
    message: json?.message,
    traceId: json?.traceId,
  };
}

/** 列表信封 `{ list, total }` 的形状校验 */
function listShape(r) {
  return Array.isArray(r.data?.list) && typeof r.data?.total === 'number';
}

async function stepSpaShell() {
  section('① 前端外壳（dev server + 代理连通性）');
  const res = await fetch(`${ORIGIN}/`);
  const html = await res.text();
  check(res.ok, `GET ${ORIGIN}/ 返回 200`, `HTTP ${res.status}`);
  check(html.includes('id="root"'), 'SPA 挂载点存在（<div id="root">）');
  check(html.includes('/src/main.tsx'), '入口脚本被正确引用');

  const health = await call('GET', '/health');
  check(health.status === 200, '代理转发 /health 成功（证明 proxy 生效）', `HTTP ${health.status}`);
}

async function stepLogin() {
  section('② 登录与身份');

  const bad = await call('POST', '/admin/auth/login', {
    body: { username: ADMIN_USER, password: 'definitely-wrong' },
  });
  check(bad.code !== 0, '错误口令被拒绝', `code=${bad.code}`);

  const ok = await call('POST', '/admin/auth/login', {
    body: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  check(ok.code === 0, '正确口令登录成功', `code=${ok.code}`);
  // 登录返回的是 `{ accessToken, refreshToken, expiresIn, admin }`，
  // 权限在 `data.admin.permissions` 里 —— 不是顶层 `token` / `permissions`。
  // 这正是本脚本要盯的那类错配：前端 `AuthContext` 读的是 `result.accessToken`。
  const token = ok.data?.accessToken;
  const perms = ok.data?.admin?.permissions;
  check(typeof token === 'string' && token.length > 20, '返回了 accessToken');
  check(Array.isArray(perms) && perms.length > 0, '返回了权限清单', `${perms?.length} 项`);

  const me = await call('GET', '/admin/auth/me', { token });
  check(me.code === 0, 'GET /admin/auth/me 可用');
  const mePerms = me.data?.permissions ?? [];
  check(
    mePerms.length === (perms?.length ?? -1) && mePerms.every((p) => perms?.includes(p)),
    '刷新后权限与登录时一致（菜单不会"刷新就少一项"）',
    `${mePerms.length} 项`,
  );

  const anon = await call('GET', '/admin/users');
  check(anon.status === 401 || anon.code === 40101, '无 token 访问被拒', `HTTP ${anon.status}`);

  return token;
}

async function stepReadEndpoints(token) {
  section('③ 只读端点（前端每个页面都要的东西）');

  const stats = await call('GET', '/admin/dashboard/stats', { token });
  check(stats.code === 0, '看板统计 /admin/dashboard/stats', `code=${stats.code}`);

  const users = await call('GET', '/admin/users?page=1&size=5', { token });
  check(users.code === 0 && listShape(users), '用户列表 /admin/users', `total=${users.data?.total}`);
  check(
    (users.data?.list ?? []).length <= 5,
    '分页参数真的生效（size=5 → 最多 5 条）',
    `返回 ${users.data?.list?.length} 条`,
  );

  const admins = await call('GET', '/admin/admins?page=1&size=5', { token });
  check(admins.code === 0 && listShape(admins), '管理员列表 /admin/admins');

  const tools = await call('GET', '/admin/tools', { token });
  check(tools.code === 0 && Array.isArray(tools.data), '工具列表 /admin/tools', `${tools.data?.length} 个`);

  const jobs = await call('GET', '/admin/tools/jobs?page=1&size=5', { token });
  check(jobs.code === 0 && listShape(jobs), '作业列表 /admin/tools/jobs', `total=${jobs.data?.total}`);

  const orders = await call('GET', '/admin/orders?page=1&size=5', { token });
  check(orders.code === 0 && listShape(orders), '订单列表 /admin/orders', `total=${orders.data?.total}`);

  const verifications = await call('GET', '/admin/content/verifications?page=1&size=5', { token });
  check(
    verifications.code === 0 && listShape(verifications),
    '认证审核队列 /admin/content/verifications',
    `total=${verifications.data?.total}`,
  );

  const audit = await call('GET', '/admin/audit?page=1&size=5', { token });
  check(audit.code === 0 && listShape(audit), '操作日志 /admin/audit', `total=${audit.data?.total}`);

  return { users, tools, jobs };
}

async function stepDetail(token, reads) {
  section('④ 详情跳转（列表 → 详情的 id 必须真的能用）');

  const userId = reads.users.data?.list?.[0]?.id;
  if (userId) {
    const detail = await call('GET', `/admin/users/${userId}`, { token });
    check(detail.code === 0, '用户详情 /admin/users/:id', `id=${userId.slice(0, 8)}…`);
    check(detail.data?.id === userId, '详情返回的 id 与请求一致');
  } else {
    note('用户表为空，跳过用户详情');
  }

  const jobId = reads.jobs.data?.list?.[0]?.id;
  if (jobId) {
    const detail = await call('GET', `/admin/tools/jobs/${jobId}`, { token });
    check(detail.code === 0, '作业详情 /admin/tools/jobs/:id');
    if (detail.code === 0) {
      check('qualityScore' in detail.data || 'qualityIssues' in detail.data,
        '作业详情带质量评分字段（列映射修正的回归点）');
    }
  } else {
    note('作业表为空，跳过作业详情');
  }

  return { userId };
}

async function stepIdempotentWrites(token, reads) {
  section('⑤ 写路径连通性（幂等写入：证明能写，但不改变任何状态）');

  const userId = reads.users.data?.list?.[0]?.id;
  const currentStatus = reads.users.data?.list?.[0]?.status;
  if (userId && currentStatus) {
    const w = await call('PUT', `/admin/users/${userId}`, {
      token,
      body: { status: currentStatus, reason: 'verify-admin-console 幂等自检' },
    });
    check(w.code === 0, `PUT /admin/users/:id 写状态（保持 ${currentStatus}）`, `code=${w.code}`);

    const back = await call('GET', `/admin/users/${userId}`, { token });
    check(back.data?.status === currentStatus, '写入后读回状态未改变（幂等）', `status=${back.data?.status}`);
  } else {
    note('无可用用户，跳过用户写入');
  }

  const tool = (reads.tools.data ?? []).find((t) => t.status === 'active');
  if (tool) {
    const w = await call('PUT', `/admin/tools/${encodeURIComponent(tool.name)}/status`, {
      token,
      body: { status: tool.status },
    });
    check(w.code === 0, `PUT /admin/tools/:name/status 写状态（保持 ${tool.status}）`);
  } else {
    note('没有 active 工具，跳过工具上下线写入');
  }
}

/**
 * 权限矩阵 + 管理员账号全生命周期。全部落在探针账号上，跑完删除。
 * @returns {Promise<void>}
 */
async function stepRbacLifecycle(token) {
  section('⑥ 管理员 CRUD 与权限矩阵（探针账号，跑完自清理）');

  // 上次跑挂了可能留下残留，先清掉，保证可重复运行
  const existing = await call('GET', `/admin/admins?keyword=${PROBE_USER}`, { token });
  for (const row of existing.data?.list ?? []) {
    await call('DELETE', `/admin/admins/${row.id}`, { token });
  }

  const created = await call('POST', '/admin/admins', {
    token,
    body: {
      username: PROBE_USER,
      password: PROBE_PASS,
      displayName: '验证探针（可删）',
      adminRole: 'operator',
    },
  });
  check(created.code === 0, '创建管理员账号', `code=${created.code}`);
  const probeId = created.data?.id;
  check(typeof probeId === 'string', '创建返回了新账号 id');
  if (!probeId) return;

  // 回归点：这个用户名对应的 User 本体仍在库（删除后台账号时刻意保留），
  // 所以冲突必须返回业务码 —— 之前会撞 User.openid 唯一键并被兜成 50001，
  // 界面上表现为"服务器内部错误"，而管理员列表里查不到这个名字。
  const dupCreate = await call('POST', '/admin/admins', {
    token,
    body: {
      username: PROBE_USER,
      password: 'Another#2026',
      displayName: '重复创建',
      adminRole: 'operator',
    },
  });
  check(
    dupCreate.code !== 0 && dupCreate.code !== 50001,
    '重复用户名创建返回业务错误码（而不是 50001 内部错误）',
    `code=${dupCreate.code} ${dupCreate.message ?? ''}`,
  );

  try {
    // —— 数据流转：新建的账号必须能从列表里搜出来
    const found = await call('GET', `/admin/admins?keyword=${PROBE_USER}`, { token });
    check(
      (found.data?.list ?? []).some((r) => r.id === probeId),
      '新建账号能通过 keyword 搜到（列表 ← 写入的数据流）',
      `命中 ${found.data?.list?.length} 条`,
    );

    const detail = await call('GET', `/admin/admins/${probeId}`, { token });
    check(detail.code === 0 && detail.data?.username === PROBE_USER, '账号详情可读且用户名正确');

    // —— 权限矩阵：operator 能看用户，不能看管理员
    const probeLogin = await call('POST', '/admin/auth/login', {
      body: { username: PROBE_USER, password: PROBE_PASS },
    });
    check(probeLogin.code === 0, '探针账号能登录');
    const probeToken = probeLogin.data?.accessToken;

    const denied = await call('GET', '/admin/admins', { token: probeToken });
    check(
      denied.status === 403 || denied.code === 40313,
      'operator 访问 /admin/admins 被拒（权限矩阵真的在拦）',
      `HTTP ${denied.status} code=${denied.code}`,
    );

    const allowed = await call('GET', '/admin/users?page=1&size=1', { token: probeToken });
    check(allowed.code === 0, 'operator 访问 /admin/users 放行（没有一概拒绝）');

    // —— 修改自有密码：只在探针账号上动，绝不碰超管凭据
    const changed = await call('POST', '/admin/admins/me/password', {
      token: probeToken,
      body: { oldPassword: PROBE_PASS, newPassword: PROBE_PASS2 },
    });
    check(changed.code === 0, 'POST /admin/admins/me/password 改自有密码', `code=${changed.code}`);

    const oldLogin = await call('POST', '/admin/auth/login', {
      body: { username: PROBE_USER, password: PROBE_PASS },
    });
    check(oldLogin.code !== 0, '改密后旧密码失效（证明真的落库了）', `code=${oldLogin.code}`);

    const newLogin = await call('POST', '/admin/auth/login', {
      body: { username: PROBE_USER, password: PROBE_PASS2 },
    });
    check(newLogin.code === 0, '改密后新密码可登录');

    const wrongOld = await call('POST', '/admin/admins/me/password', {
      token: newLogin.data?.token,
      body: { oldPassword: 'not-the-old-one', newPassword: 'Whatever#2026' },
    });
    check(wrongOld.code !== 0, '旧密码不正确时改密被拒', `code=${wrongOld.code}`);

    // —— 改角色 / 停用 / 停用即失效
    const roleUp = await call('PUT', `/admin/admins/${probeId}`, {
      token,
      body: { adminRole: 'auditor' },
    });
    check(roleUp.code === 0, '修改账号角色', `role=${roleUp.data?.adminRole}`);

    const disabled = await call('PUT', `/admin/admins/${probeId}`, {
      token,
      body: { status: 'disabled' },
    });
    check(disabled.code === 0, '停用账号');

    const disabledLogin = await call('POST', '/admin/auth/login', {
      body: { username: PROBE_USER, password: PROBE_PASS2 },
    });
    check(disabledLogin.code !== 0, '停用后立即无法登录（角色/状态以库为准）', `code=${disabledLogin.code}`);
  } finally {
    const del = await call('DELETE', `/admin/admins/${probeId}`, { token });
    check(del.code === 0, '删除探针账号（清理）', `code=${del.code}`);
  }

  const gone = await call('GET', `/admin/admins?keyword=${PROBE_USER}`, { token });
  check((gone.data?.list ?? []).length === 0, '删除后列表里不再出现');
}

async function stepSuperAdminSafety(token) {
  section('⑦ 超管自保护（别把唯一的管理员锁在门外）');

  const list = await call('GET', `/admin/admins?keyword=${ADMIN_USER}`, { token });
  const self = (list.data?.list ?? []).find((r) => r.username === ADMIN_USER);
  if (!self) {
    note('未能定位超管账号，跳过自保护用例');
    return;
  }

  const selfDemote = await call('PUT', `/admin/admins/${self.id}`, {
    token,
    body: { adminRole: 'operator' },
  });
  check(selfDemote.code !== 0, '超管改自己角色被拒', `code=${selfDemote.code}`);

  const selfDisable = await call('PUT', `/admin/admins/${self.id}`, {
    token,
    body: { status: 'disabled' },
  });
  check(selfDisable.code !== 0, '超管停用自己被拒', `code=${selfDisable.code}`);

  const stillOk = await call('GET', '/admin/auth/me', { token });
  check(stillOk.code === 0, '（安全门未误伤超管本人，仍可正常请求）');
}

async function stepLogout(token) {
  section('⑧ 登出');
  const out = await call('POST', '/admin/auth/logout', { token });
  check(out.code === 0, 'POST /admin/auth/logout 成功（只记审计，不吊销 token）');
}

async function main() {
  console.log('==========================================================');
  console.log(' 管理后台控制台端到端验证');
  console.log(` 目标：${API}`);
  console.log('==========================================================');

  try {
    await stepSpaShell();
    const token = await stepLogin();
    if (!token) throw new Error('登录失败，后续用例无法继续');
    const reads = await stepReadEndpoints(token);
    await stepDetail(token, reads);
    await stepIdempotentWrites(token, reads);
    await stepSuperAdminSafety(token);
    await stepRbacLifecycle(token);
    await stepLogout(token);
  } catch (err) {
    failures.push(`脚本异常：${err.message}`);
    console.log(`\n❌ 脚本异常中断：${err.message}`);
  }

  console.log('\n==========================================================');
  if (failures.length === 0) {
    console.log('✅ 全部通过');
    console.log('==========================================================');
    return;
  }
  console.log(`❌ 有 ${failures.length} 项未通过：`);
  for (const f of failures) console.log(`   - ${f}`);
  console.log('==========================================================');
  process.exitCode = 1;
}

await main();
