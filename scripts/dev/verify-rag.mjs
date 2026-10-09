/**
 * 校园知识库 RAG 端到端验证（M4-06）
 *
 * ## 为什么需要它
 *
 * `SiliconflowEmbeddingProvider` 早就配好了，但**没有任何业务调用方** ——
 * 只服务于 `/health`。配了却没人调的 Provider 不会报错，它只是让
 * "语义检索"这个能力在产品上根本不存在。本脚本验证这条链路真的通了：
 *
 *   切片 → 向量化（真实硅基流动）→ 写入（真实 Qdrant）
 *        → 检索 → 带引用回答（真实大模型）
 *
 * 并且验证两件"错了也不会报错"的事：
 *   ① **权限**：知识库是全站共享的，非管理员灌库必须被拒（403），
 *      否则任何学生都能污染所有人的检索结果；
 *   ② **无依据不硬答**：检索为空时不能调用 LLM，必须如实返回 `grounded: false`。
 *
 * ## 用法
 *
 *   npm run build -w @qz/api
 *   node apps/api/dist/main.js        # 另开一个终端（cwd 用仓库根）
 *   node scripts/dev/verify-rag.mjs
 *
 * ⚠️ 前置条件：
 *   · `.env` 里 `VECTOR_DRIVER=qdrant` 且 Qdrant 已在 `QDRANT_URL` 上运行；
 *   · `SILICONFLOW_API_KEY` 有效（向量化要真实调用）；
 *   · `LLM_API_KEY` 有效（问答要真实调用）。
 *   `/health` 的 `mockProviders` 里若出现 `mock-vector` / `mock-embedding`，脚本会直接报错退出。
 *
 * ## 脚本会往库里写什么
 *
 * 每次运行登录一个全新的探针用户（`rag-probe-*`），给它临时授予 admin 角色
 *（灌库接口要求 `Role.Admin`），跑完后**撤销该角色并删掉灌进去的文档**。
 *
 * ⚠️ 提权之后**必须用同一个 code 重新登录**再调灌库接口 —— 角色写在 JWT payload 里，
 * 提权前签发的 token 仍是旧角色（复用会 403，且看起来像"RBAC 没生效"）。
 */
import { devLoginCode } from './dev-login.mjs';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? '✅' : '❌'} ${label}`);
};

async function call(method, path, { body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON 响应保持 null */
  }
  return { status: res.status, body: json };
}

/**
 * 登录探针用户。
 *
 * ⚠️ 传**同一个 `code`** 两次会得到**同一个用户**（openid 由 code 派生 + upsert 去重），
 * 但会得到**两个不同的 token** —— 因为角色是写进 JWT payload 的
 * （`JwtAuthGuard` 只读 payload，不查库），提权前签发的 token 永远是旧角色。
 * 所以「授予 admin 之后必须重新登录」。
 */
async function login(tag, code) {
  const r = await call('POST', '/auth/login', {
    body: { code: code ?? devLoginCode(`rag-probe-${tag}`) },
  });
  return { token: r.body?.data?.accessToken, userId: r.body?.data?.user?.id };
}

/** 灌库用的样例文档：两篇内容明显不同，便于验证"检索确实按语义命中" */
const DOC_CARD = {
  title: '校园卡补办流程',
  source: '学生手册 2026 版',
  category: 'guide',
  content: [
    '校园卡丢失后，第一步应立即在「一卡通服务平台」上挂失，挂失后原卡立即失效，可防止被盗刷。',
    '挂失满 24 小时后，携带本人学生证到行政楼一层的校园卡服务中心办理补办。',
    '补办工本费为 20 元，从校园卡账户余额中扣除；余额不足时需先充值。',
    '补办后新卡当场领取并激活，原卡的消费记录与余额会自动转移到新卡。',
    '如果只是卡片消磁而非丢失，可以到服务中心免费重写磁条，无需工本费。',
    '补办期间如需临时用卡，可在服务中心申请有效期 7 天的临时卡。',
  ].join('\n'),
};

const DOC_LIB = {
  title: '图书馆座位预约规则',
  source: '图书馆公告',
  category: 'policy',
  content: [
    '图书馆自习座位采用线上预约制，通过「图书馆微服务」小程序选座。',
    '预约后需在 30 分钟内到馆扫码签到，超时未签到系统自动释放座位并记一次违约。',
    '累计 3 次违约将暂停预约权限 7 天。',
    '阅览区座位可预约当天，考研自习区可提前 3 天预约。',
  ].join('\n'),
};

/** ① Provider 装配：必须是真实的向量化 + 真实向量库 */
async function sectionProviders() {
  console.log('\n' + '='.repeat(74));
  console.log('① Provider 装配（必须是真实向量化 + 真实向量库，不能是 Mock）');
  console.log('='.repeat(74));

  const health = await call('GET', '/health');
  const mocks = health.body?.data?.mockProviders ?? [];
  console.log(`   mockProviders: ${JSON.stringify(mocks)}`);

  check(!mocks.some((m) => m.includes('embedding')), '向量化不是 Mock（mock-embedding 未出现）');
  check(!mocks.some((m) => m.includes('vector')), '向量库不是 Mock（mock-vector 未出现）');
  check(!mocks.some((m) => m.includes('llm')), 'LLM 不是 Mock（问答要真实模型）');
  return health.status === 200;
}

/** ② 权限：非管理员不得灌库 */
async function sectionPermission(token) {
  console.log('\n' + '='.repeat(74));
  console.log('② 权限：知识库全站共享，非管理员灌库必须被拒');
  console.log('='.repeat(74));

  const r = await call('POST', '/knowledge/documents', { token, body: DOC_CARD });
  check(r.status === 403, `普通用户灌库返回 403（实际 ${r.status}）`);

  const anon = await call('POST', '/knowledge/search', { body: { query: '校园卡' } });
  check(anon.status === 401, `未登录检索返回 401（实际 ${anon.status}）`);
}

/** ③ 灌库：切片 → 向量化 → 写入向量库 */
async function sectionIngest(token) {
  console.log('\n' + '='.repeat(74));
  console.log('③ 灌库：切片 → 真实向量化 → 写入 Qdrant');
  console.log('='.repeat(74));

  const ids = [];
  for (const doc of [DOC_CARD, DOC_LIB]) {
    const t0 = Date.now();
    const r = await call('POST', '/knowledge/documents', { token, body: doc });
    const d = r.body?.data;
    const ms = Date.now() - t0;
    check(r.status === 201 || r.status === 200, `灌库「${doc.title}」HTTP ${r.status}（${ms}ms）`);
    if (d?.documentId) {
      ids.push(d.documentId);
      console.log(`      切片 ${d.chunkCount} 片 → 集合 ${d.collection}`);
    } else {
      console.log(`      ${JSON.stringify(r.body?.message ?? r.body).slice(0, 200)}`);
    }
  }
  check(ids.length === 2, '两篇文档都灌库成功');

  const list = await call('GET', '/knowledge/documents', { token });
  const titles = (list.body?.data ?? []).map((x) => x.title);
  check(titles.includes(DOC_CARD.title), '文档列表里能看到刚灌的文档');
  return ids;
}

/** ④ 检索：按语义命中，且不相关的问题命中为空 */
async function sectionSearch(token) {
  console.log('\n' + '='.repeat(74));
  console.log('④ 检索：语义命中 + 无关问题不硬凑');
  console.log('='.repeat(74));

  const hit = await call('POST', '/knowledge/search', {
    token,
    body: { query: '学生卡丢了怎么补办，要多少钱' },
  });
  const hits = hit.body?.data ?? [];
  check(hits.length > 0, `「校园卡丢了怎么补办」命中 ${hits.length} 条切片`);
  if (hits[0]) {
    console.log(`       第 1 条：${hits[0].title} 得分=${hits[0].score?.toFixed?.(4)}`);
    console.log(`       原文：${String(hits[0].text).slice(0, 60)}…`);
  }
  check(
    hits.some((h) => h.title === DOC_CARD.title),
    '命中结果来自「校园卡补办流程」（语义匹配到了正确的文档）',
  );

  const lib = await call('POST', '/knowledge/search', {
    token,
    body: { query: '图书馆座位怎么预约，违约会怎么样' },
  });
  const libHits = lib.body?.data ?? [];
  check(
    libHits.some((h) => h.title === DOC_LIB.title),
    '「图书馆座位」命中「图书馆座位预约规则」',
  );

  // 阈值的作用：完全无关的问题不应凑出 topK 条噪音
  const off = await call('POST', '/knowledge/search', {
    token,
    body: { query: '量子纠缠的贝尔不等式如何推导' },
  });
  const offHits = off.body?.data ?? [];
  console.log(`       无关问题命中 ${offHits.length} 条（阈值过滤生效则应为 0）`);
  check(offHits.length === 0, '无关问题没有命中（相似度阈值拦住了噪音）');
}

/** ⑤ 问答：带引用，且无依据时不调用模型 */
async function sectionAsk(token) {
  console.log('\n' + '='.repeat(74));
  console.log('⑤ 问答：检索 → 带来源引用的回答');
  console.log('='.repeat(74));

  const r = await call('POST', '/knowledge/ask', {
    token,
    body: { question: '校园卡丢了怎么办？补办要多少钱？' },
  });
  const d = r.body?.data;
  check(r.status === 201 || r.status === 200, `问答 HTTP ${r.status}`);
  check(d?.grounded === true, 'grounded=true（有真实检索依据）');
  check((d?.citations ?? []).length > 0, `返回了 ${d?.citations?.length ?? 0} 条引用`);
  check(
    (d?.citations ?? []).some((c) => c.title === DOC_CARD.title),
    '引用里包含「校园卡补办流程」',
  );
  if (d?.answer) console.log(`   回答：${d.answer.slice(0, 160)}`);

  const off = await call('POST', '/knowledge/ask', {
    token,
    body: { question: '请解释一下黎曼猜想与素数分布的关系' },
  });
  const od = off.body?.data;
  check(od?.grounded === false, '知识库没有相关内容时 grounded=false（不硬答）');
  check(
    od?.citations?.length === 0,
    '无依据时引用为空（不会附上一堆不相关的来源充数）',
  );
  if (od?.answer) console.log(`   回答：${od.answer.slice(0, 100)}`);
}

/** ⑥ 清理：删除文档后不应再被检索到 */
async function sectionCleanup(token, ids) {
  console.log('\n' + '='.repeat(74));
  console.log('⑥ 清理：删文档 → 向量库切片同步删除');
  console.log('='.repeat(74));

  for (const id of ids) {
    const r = await call('DELETE', `/knowledge/documents/${id}`, { token });
    check(r.status === 200 || r.status === 204, `删除文档 ${String(id).slice(0, 8)}… HTTP ${r.status}`);
  }

  const after = await call('POST', '/knowledge/search', {
    token,
    body: { query: '校园卡丢了怎么补办' },
  });
  const hits = after.body?.data ?? [];
  check(hits.length === 0, `删除后不再检索到内容（命中 ${hits.length} 条）`);
}

/**
 * 临时给探针用户授予 admin 角色。
 *
 * 灌库接口要求 `Role.Admin`（知识库全站共享，不能让普通用户写），
 * 而脚本没法通过微信登录变成种子里的 `demo_admin` —— 开发模式下 openid
 * 是按 code 哈希出来的，无法伪造。所以直接写一行 `user_role`，
 * 跑完在 `finally` 里删掉。
 */
async function grantAdmin(userId, grant) {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    if (grant) {
      await prisma.userRole.upsert({
        where: { userId_role: { userId, role: 'admin' } },
        create: { userId, role: 'admin', scope: 'global' },
        update: {},
      });
    } else {
      await prisma.userRole.deleteMany({ where: { userId, role: 'admin' } });
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  console.log('\n校园知识库 RAG 端到端验证（M4-06）\n');
  console.log(`   接口地址: ${BASE}`);

  // 让 Prisma 能连上库（@prisma/client 不会自动读 .env）
  try {
    process.loadEnvFile('.env');
  } catch {
    console.log('   （未找到 .env，依赖进程已有的环境变量）');
  }

  const ok = await sectionProviders();
  if (!ok) {
    console.log('\n❌ 后端未就绪，请先启动：cd apps/api && node --enable-source-maps dist/main.js');
    process.exit(1);
  }

  // 固定 code：提权后要用同一个 code 重新登录（拿到带 admin 角色的新 token）
  const probeCode = devLoginCode('rag-probe-main');
  const { token, userId } = await login('main', probeCode);
  if (!token) {
    console.log('\n❌ 登录失败，无法继续');
    process.exit(1);
  }
  console.log(`   登录成功，userId=${String(userId).slice(0, 8)}…`);

  let ids = [];
  try {
    await sectionPermission(token);
    await grantAdmin(userId, true);

    // ⚠️ 必须重新登录：角色在 token 签发那一刻就固化了（JwtAuthGuard 读 payload，不查库），
    //    复用旧 token 会 403，而且看起来像"RBAC 没生效"，实际是"token 过期了角色"。
    const elevated = await login('main', probeCode);
    if (elevated.userId !== userId) {
      throw new Error(
        `同一 code 登录到了不同用户（${String(userId).slice(0, 8)} → ${String(elevated.userId).slice(0, 8)}），提权会落空`,
      );
    }
    ids = await sectionIngest(elevated.token);
    await sectionSearch(elevated.token);
    await sectionAsk(elevated.token);
    await sectionCleanup(elevated.token, ids);
    ids = [];
  } finally {
    // 无论成功失败都撤销提权，避免探针用户留在库里当管理员
    await grantAdmin(userId, false).catch(() => undefined);
  }

  console.log('\n' + '='.repeat(74));
  console.log(
    failures === 0
      ? '🎉 通过：向量化已有真实调用方，RAG 链路（切片→向量→检索→带引用回答）全程可用'
      : `❌ 有 ${failures} 项未通过`,
  );
  console.log('='.repeat(74));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
