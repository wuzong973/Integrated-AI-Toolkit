/**
 * 端到端验证：服务者入驻认证（任务清单 M3-02）
 *
 * ## 它钉住的是 M3-02 的两条验收标准
 *
 *   ① **未认证账号无法接单**；
 *   ② **驳回时给出具体原因**。
 *
 * 这两条都容易被"看起来做了"糊弄过去：
 *   · 只做审核通过、不做身份校验 → 没认证也能接单，而界面上一切正常；
 *   · 只把 `reason` 声明成 optional → 服务端能存下一条**没有原因**的驳回，
 *     用户看到"未通过"却不知道该改什么，只能反复重交。
 * 所以本脚本**故意**去撞这两条：先断言"未认证报名被拒"，再断言"驳回不写原因被拒"。
 *
 * ## 为什么必须和 `verify:station` 一起跑
 *
 * 本模块负责"把人变成 provider"，`StationWriteService.assertIsProvider` 负责"校验"。
 * 只测一边会出现"认证了却接不了单"或"没认证也能接单"，两种都不报错。
 *
 * ## 前置
 *
 *   后端已在 `http://127.0.0.1:3000` 运行（`npm run dev:api`），数据库可连。
 *
 * ## 用法
 *
 *   npm run verify:provider
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

/** 违规样例：命中 `CAMPUS_LEXICON` 的「代考」 */
const BAD_SKILL = '代考';

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

function signToken(user, env, isAdmin = false) {
  return jwt.sign(
    { sub: user.id, openid: user.openid, roles: isAdmin ? ['admin'] : [], isAdmin },
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

/** 一份合法的入驻申请 */
const application = (schoolId, materialIds, patch = {}) => ({
  realName: '张同学',
  studentNo: '2023010101',
  schoolId,
  college: '计算机学院',
  materialIds,
  skillTags: ['摄影', '后期修图'],
  portfolioIds: [],
  ...patch,
});

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
  const applicant = await prisma.user.create({
    data: { openid: `verify_provider_${stamp}`, nickname: '验证入驻者' },
  });
  const other = await prisma.user.create({
    data: { openid: `verify_provider_o_${stamp}`, nickname: '验证他人' },
  });
  const admin = await prisma.user.create({
    data: { openid: `verify_provider_a_${stamp}`, nickname: '验证管理员' },
  });
  const publisher = await prisma.user.create({
    data: { openid: `verify_provider_p_${stamp}`, nickname: '验证发布者' },
  });

  await prisma.userRole.create({ data: { userId: admin.id, role: 'admin', scope: 'global' } });
  await prisma.userProfile.createMany({
    data: [
      { userId: applicant.id, creditScore: 80 },
      { userId: other.id, creditScore: 80 },
      { userId: admin.id, creditScore: 80 },
      { userId: publisher.id, creditScore: 80 },
    ],
  });

  const school = await prisma.school.findFirst({ select: { id: true, name: true } });
  if (!school) {
    console.log('❌ 库里没有任何学校记录，请先跑 npm run db:seed');
    await prisma.$disconnect();
    process.exit(1);
  }

  /** 属于申请人自己的学生证 */
  const mine = await prisma.fileAsset.create({
    data: {
      userId: applicant.id,
      name: 'student-card.jpg',
      type: 'image',
      size: 1024,
      objectKey: `verify/${stamp}/mine.jpg`,
      scene: 'verification',
    },
  });
  /** **别人**的学生证 —— 用来验证"材料必须属于自己" */
  const notMine = await prisma.fileAsset.create({
    data: {
      userId: other.id,
      name: 'someone-else.jpg',
      type: 'image',
      size: 1024,
      objectKey: `verify/${stamp}/other.jpg`,
      scene: 'verification',
    },
  });
  /** 一条已发布的任务，用来验证"未认证不能接单 → 认证后能接单" */
  const task = await prisma.task.create({
    data: {
      taskNo: `QTVERIFY${stamp}`,
      publisherId: publisher.id,
      categoryId: 'photo',
      title: '验证用：拍毕业照',
      description: '这是 verify:provider 造的验证任务，用来检查接单权限。',
      budget: 30000,
      budgetType: 'fixed',
      status: 'published',
      publishedAt: new Date(),
    },
    select: { id: true },
  });

  const ctx = {
    prisma,
    applicant,
    admin,
    school,
    mine,
    notMine,
    task,
    api: makeApi(base, signToken(applicant, env)),
    adminApi: makeApi(base, signToken(admin, env, true)),
    pub: makeApi(base, null),
  };

  console.log('='.repeat(74));
  console.log(`   后端：${base}`);
  console.log(`   入驻申请人：${applicant.id}`);
  console.log(`   管理员：${admin.id}`);
  console.log(`   学校：${school.name}（${school.id}）`);
  console.log('='.repeat(74));

  try {
    await verifyBasics(ctx);
    const verificationId = await verifySubmit(ctx);
    await verifyReviewGuards(ctx, verificationId);
    await verifyReject(ctx, verificationId);
    await verifyResubmitAndApprove(ctx, verificationId);
  } catch (e) {
    check(false, '流程异常', e.message);
  } finally {
    await cleanup(prisma, [applicant.id, other.id, admin.id, publisher.id], task.id);
    await prisma.$disconnect();
  }

  console.log('\n' + '='.repeat(74));
  console.log(
    failures === 0
      ? '🎉 通过：入驻认证可用（提交 → 驳回给原因 → 重提 → 通过 → 能接单）'
      : `❌ 有 ${failures} 项未通过`,
  );
  console.log('='.repeat(74));
  process.exit(failures === 0 ? 0 : 1);
}

/** ① 基础：学校列表 + 初始状态 + 未认证不能接单 */
async function verifyBasics(ctx) {
  console.log('\n【1】基础状态');
  const { api, pub, school, task } = ctx;

  const schools = await pub('/provider/schools');
  const list = schools.body?.data ?? [];
  check(schools.status < 300 && list.length >= 1, `学校列表返回 ${list.length} 所（公开接口）`);
  check(
    list.some((s) => s.id === school.id),
    '含 seed 的那所学校',
  );

  const profile = await api('/provider/profile');
  const p = profile.body?.data;
  check(profile.status < 300 && p?.isProvider === false, '初始状态：不是服务者');
  check(p?.verification === null, '初始状态：没有任何申请记录');

  // ⭐ M3-02 验收标准之一
  const apply = await post(api, `/station/tasks/${task.id}/apply`, { message: '我想接' });
  check(
    code(apply) === 40312,
    `未认证账号报名被拒（${code(apply)}）`,
    apply.body?.message,
  );
}

/** ② 提交：材料归属 + 学校存在性 + 正常提交 + 重复提交 */
async function verifySubmit(ctx) {
  console.log('\n【2】提交入驻申请');
  const { api, school, mine, notMine } = ctx;

  const foreign = await post(
    api,
    '/provider/apply',
    application(school.id, [notMine.id]),
  );
  check(
    code(foreign) === 40313,
    `引用别人的材料被拒（${code(foreign)}）`,
    foreign.body?.message,
  );

  const badSchool = await post(api, '/provider/apply', application('no_such_school', [mine.id]));
  check(code(badSchool) === 40001, `学校不存在报 40001（${code(badSchool)}）`, badSchool.body?.message);

  const badSkill = await post(
    api,
    '/provider/apply',
    application(school.id, [mine.id], { skillTags: [BAD_SKILL] }),
  );
  check(
    code(badSkill) === 40051,
    `违规技能标签被内容安全拦下（${code(badSkill)}）`,
    badSkill.body?.message,
  );

  const ok = await post(api, '/provider/apply', application(school.id, [mine.id]));
  const v = ok.body?.data;
  check(ok.status < 300 && !!v?.verificationId, `提交成功（HTTP ${ok.status}）`, v?.status);
  check(v?.status === 'pending', '状态为 pending', v?.status);

  const dup = await post(api, '/provider/apply', application(school.id, [mine.id]));
  check(
    code(dup) === 40901,
    `审核中重复提交被拒（${code(dup)}）`,
    dup.body?.message,
  );

  const after = await ctx.prisma.verification.count({ where: { userId: ctx.applicant.id } });
  check(after === 1, '重复提交没有多插一条记录', String(after));

  return v?.verificationId;
}

/** ③ 审核守卫：非管理员 + 驳回必须写原因 */
async function verifyReviewGuards(ctx, id) {
  console.log('\n【3】审核守卫');
  const { api, adminApi } = ctx;

  const denied = await post(api, `/provider/verifications/${id}/review`, { approved: true });
  check(code(denied) === 40313, `非管理员审核被拒（${code(denied)}）`, denied.body?.message);

  // ⭐ M3-02 验收标准之二：驳回**必须**给出具体原因
  const noReason = await post(adminApi, `/provider/verifications/${id}/review`, { approved: false });
  check(
    noReason.status === 400,
    `驳回不写原因被拒（HTTP ${noReason.status}）`,
    noReason.body?.message,
  );

  const shortReason = await post(adminApi, `/provider/verifications/${id}/review`, {
    approved: false,
    reason: '不行',
  });
  check(
    shortReason.status === 400,
    `驳回原因过短也被拒（HTTP ${shortReason.status}）`,
    shortReason.body?.message,
  );

  const still = await ctx.prisma.verification.findUnique({ where: { id }, select: { status: true } });
  check(still?.status === 'pending', '两次无效驳回后申请仍是 pending', still?.status);
}

/** ④ 驳回：状态、原因透出、且**仍未获得接单权限** */
async function verifyReject(ctx, id) {
  console.log('\n【4】驳回');
  const { api, adminApi, task } = ctx;
  const REASON = '学生证照片模糊，请重新上传清晰的照片';

  const res = await post(adminApi, `/provider/verifications/${id}/review`, {
    approved: false,
    reason: REASON,
  });
  const v = res.body?.data;
  check(res.status < 300 && v?.status === 'rejected', `驳回成功（HTTP ${res.status}）`, v?.status);
  check(v?.rejectReason === REASON, '驳回原因原样保存', v?.rejectReason);

  // 用户必须能拿到原因（界面靠它显示"上次为什么没过"）
  const profile = await api('/provider/profile');
  const p = profile.body?.data;
  check(
    p?.verification?.rejectReason === REASON,
    '申请人在 profile 里能看到驳回原因',
    p?.verification?.rejectReason,
  );
  check(p?.isProvider === false, '驳回后仍不是服务者');

  const apply = await post(api, `/station/tasks/${task.id}/apply`, { message: '再试一次' });
  check(code(apply) === 40312, `驳回后仍无法接单（${code(apply)}）`);
}

/** ⑤ 重新提交 → 通过 → 技能画像落库 → 能接单 */
async function verifyResubmitAndApprove(ctx, id) {
  console.log('\n【5】重新提交 → 通过 → 能接单');
  const { api, adminApi, prisma, school, mine, applicant, task } = ctx;

  const again = await post(
    api,
    '/provider/apply',
    application(school.id, [mine.id], { skillTags: ['摄影', '摄像'] }),
  );
  check(again.status < 300, `被驳回后可以重新提交（HTTP ${again.status}）`);
  const newId = again.body?.data?.verificationId;
  check(newId !== id, '重新提交产生的是**新**记录（保留被驳回的那条）', newId);

  const approved = await post(adminApi, `/provider/verifications/${newId}/review`, {
    approved: true,
  });
  check(
    approved.status < 300 && approved.body?.data?.status === 'approved',
    `审核通过（HTTP ${approved.status}）`,
  );

  // 三处必须同时写全：角色 + 技能画像 + 用户资料
  const role = await prisma.userRole.findUnique({
    where: { userId_role: { userId: applicant.id, role: 'provider' } },
    select: { status: true },
  });
  check(role?.status === 'active', '已授予 provider 角色', role?.status);

  const profileRow = await prisma.userProfile.findUnique({
    where: { userId: applicant.id },
    select: { skills: true },
  });
  const skills = Array.isArray(profileRow?.skills) ? profileRow.skills : [];
  check(
    skills.includes('摄影') && skills.includes('摄像'),
    '技能画像已写入（否则匹配算法会把他算成零技能）',
    JSON.stringify(skills),
  );

  const me = await api('/provider/profile');
  check(me.body?.data?.isProvider === true, 'profile 显示已是服务者');

  // ⭐ M3-02 验收标准之一的反面：认证后必须**能**接单
  const apply = await post(api, `/station/tasks/${task.id}/apply`, { message: '我可以拍' });
  check(
    apply.status < 300,
    `认证后可以报名接单（HTTP ${apply.status}）`,
    apply.body?.message,
  );

  // 已通过再申请 → 40001（不要让人重复入驻）
  const reapply = await post(api, '/provider/apply', application(school.id, [mine.id]));
  check(code(reapply) === 40001, `已是服务者再申请被拒（${code(reapply)}）`, reapply.body?.message);

  // 重复审核 → 40902
  const reviewAgain = await post(adminApi, `/provider/verifications/${newId}/review`, {
    approved: true,
  });
  check(
    code(reviewAgain) === 40902,
    `重复审核被拒（${code(reviewAgain)}）`,
    reviewAgain.body?.message,
  );

  const list = await adminApi('/provider/verifications?status=approved');
  check(list.status < 300 && (list.body?.data?.total ?? 0) >= 1, '管理端能按状态筛出已通过的申请');
}

async function cleanup(prisma, userIds, taskId) {
  try {
    await prisma.taskApplication.deleteMany({ where: { taskId } });
    await prisma.task.deleteMany({ where: { id: taskId } });
    await prisma.verification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.fileAsset.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userProfile.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    console.log('\n   ℹ️ 已清理本次验证造的数据');
  } catch (e) {
    console.log(`   ⚠️ 清理失败（不影响验证结论）：${e.message}`);
  }
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
