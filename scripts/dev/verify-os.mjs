/**
 * 青智 OS（AI 助手）端到端验证
 *
 * ## 为什么需要它
 *
 * 小程序早就在调 `/os/sessions`、`/os/intent`，但后端一直没有 os 模块，
 * 请求全部 404 —— 界面靠 `pages/os/index.ts` 的本地关键词规则硬撑着，
 * **模型一次都没被调用过**。本脚本验证这条链路真的通了，且用的是真实模型。
 *
 * ⚠️ 覆盖范围包含 **plan 档（深度思考）**：`POST /os/plan` 走的是 `tier: 'plan'`
 * 那一档模型，产出的是**有依赖关系的 DAG**（不是线性清单）。
 * 曾经这一档"配了却没有任何调用方"，而当时的脚本只测 intent/chat，
 * 于是它一直是死的也没人发现 —— 加 ⑥ 就是为了堵住这个盲区。
 *
 * ## 用法
 *
 *   npm run build -w @qz/api && npm run dev:api   # 另开一个终端
 *   node scripts/dev/verify-os.mjs
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
    /* 非 JSON 响应（如 502）保持 null */
  }
  return { status: res.status, body: json };
}

/** 登录拿 token（每次用新 code → 新用户，避免上一轮数据干扰） */
async function login(tag) {
  const r = await call('POST', '/auth/login', { body: { code: devLoginCode(`os-probe-${tag}`) } });
  return { token: r.body?.data?.accessToken, userId: r.body?.data?.user?.id };
}

/** 需要识别的样例：覆盖 5 类意图 + 1 个复合意图 */
const INTENT_CASES = [
  { text: '帮我把这个视频压缩到 50MB', expect: 'file_process' },
  { text: '把这首歌的人声和伴奏分开', expect: 'media_ai' },
  { text: '帮我做一份关于校园二手交易平台的 PPT', expect: 'ai_generate' },
  { text: '我要办一场 200 人的创新创业活动，帮我全部安排', expect: 'campus_service' },
  { text: '今天天气怎么样', expect: 'knowledge' },
];

/** ① 会话：新建 + 列表 */
async function sectionSessions(token) {
  console.log('\n' + '='.repeat(74));
  console.log('① 会话：新建 + 列表');
  console.log('='.repeat(74));

  const created = await call('POST', '/os/sessions', { token, body: { title: '青智 OS' } });
  const sessionId = created.body?.data?.id;
  check(created.status === 201 || created.status === 200, `新建会话 HTTP ${created.status}`);
  check(!!sessionId, '返回了会话 id');

  const list = await call('GET', '/os/sessions', { token });
  check(Array.isArray(list.body?.data), '会话列表返回数组');
  check(
    (list.body?.data ?? []).some((s) => s.id === sessionId),
    '列表里能找到刚建的会话',
  );
  return sessionId;
}

/** ② 意图识别（真实模型） */
async function sectionIntent(token) {
  console.log('\n' + '='.repeat(74));
  console.log('② 意图识别（调真实大模型，逐条比对分类）');
  console.log('='.repeat(74));

  let hit = 0;
  for (const c of INTENT_CASES) {
    const r = await call('POST', '/os/intent', { token, body: { text: c.text } });
    const d = r.body?.data;
    if (!d) {
      console.log(`   ❌ 「${c.text}」HTTP ${r.status} ${JSON.stringify(r.body?.message ?? '')}`);
      failures += 1;
      continue;
    }
    const ok = d.intent === c.expect;
    if (ok) hit += 1;
    console.log(
      `   ${ok ? '✅' : '⚠️ '} 「${c.text.slice(0, 22)}」→ ${d.intent}（期望 ${c.expect}）` +
        ` 置信度=${d.confidence} 复合=${d.isComposite}`,
    );
  }
  check(hit >= 4, `意图分类命中 ${hit}/${INTENT_CASES.length}（≥4 视为可用）`);

  const composite = await call('POST', '/os/intent', {
    token,
    body: { text: '我要办一场 200 人的创新创业活动，帮我全部安排' },
  });
  check(composite.body?.data?.isComposite === true, '「办一场活动」被识别为复合意图');
}

/** ③ 对话：发消息 → 模型回复 → 落库 */
async function sectionChat(token, sessionId) {
  console.log('\n' + '='.repeat(74));
  console.log('③ 对话：发消息 → 模型回复 → 落库');
  console.log('='.repeat(74));

  const sent = await call('POST', `/os/sessions/${sessionId}/messages`, {
    token,
    body: { content: '帮我做个 PPT，主题是校园二手交易平台' },
  });
  const reply = sent.body?.data?.reply;
  check(sent.status === 201 || sent.status === 200, `发消息 HTTP ${sent.status}`);
  check(!!reply?.content, '模型返回了非空回复');
  if (reply?.content) console.log(`   回复：${reply.content.slice(0, 100)}`);

  const msgs = await call('GET', `/os/sessions/${sessionId}/messages`, { token });
  const rows = msgs.body?.data ?? [];
  check(rows.length >= 2, `消息已落库（${rows.length} 条）`);
  check(rows[0]?.role === 'user', '第一条是用户消息');
  check(rows.some((m) => m.role === 'assistant'), '存在助手回复');
}

/** ④ 归属校验：别人的会话读不到、也发不进去 */
async function sectionOwnership(sessionId) {
  console.log('\n' + '='.repeat(74));
  console.log('④ 归属校验：别人的会话读不到、也发不进去');
  console.log('='.repeat(74));

  const other = await login('other');
  const stolen = await call('GET', `/os/sessions/${sessionId}/messages`, { token: other.token });
  check(stolen.status === 404, `他人读会话返回 404（实际 ${stolen.status}）`);

  const stolenSend = await call('POST', `/os/sessions/${sessionId}/messages`, {
    token: other.token,
    body: { content: 'hi' },
  });
  check(stolenSend.status === 404, `他人发消息返回 404（实际 ${stolenSend.status}）`);
}

/** ⑤ 参数校验与鉴权 */
async function sectionValidation(token) {
  console.log('\n' + '='.repeat(74));
  console.log('⑤ 参数校验与鉴权');
  console.log('='.repeat(74));

  const empty = await call('POST', '/os/intent', { token, body: { text: '' } });
  check(empty.status === 400, `空 text 返回 400（实际 ${empty.status}）`);

  const anon = await call('POST', '/os/intent', { body: { text: '你好' } });
  check(anon.status === 401, `未登录返回 401（实际 ${anon.status}）`);
}

/**
 * ⑥ plan 档（深度思考）：目标 → 有依赖关系的 DAG
 *
 * ⚠️ 这里要验的**不是"有没有返回"**，而是"返回的图能不能按序执行"：
 * 拓扑序错了、依赖指向了不存在的节点，前端照样渲染（看起来一切正常），
 * 但真正跑起来会因为依赖没就绪而卡住或乱序 —— 属于"错了也不报错"的那一类。
 */
/**
 * 找出 DAG 的第一处结构性缺陷（没有则返回 null）。
 *
 * 这些都是"渲染出来看不出问题、真跑起来才炸"的错误：
 *   · 依赖指向不存在的节点 → 永远等不到前置，任务卡死
 *   · 成环 → 同上（下面的拓扑序检查一并覆盖这两种）
 *   · 自依赖 → 同上
 *   · 类型越界 → 前端图标与执行策略会落到默认分支，静默降级
 */
function findGraphDefect(nodes) {
  const TYPES = ['ai', 'human', 'hitl', 'external'];
  const badType = nodes.find((n) => !TYPES.includes(n.type));
  if (badType) return `节点 ${badType.id} 的类型越界：${badType.type}`;

  if (nodes.length !== new Set(nodes.map((n) => n.id)).size) return '节点 id 有重复';

  // ⭐ 拓扑序：每个依赖都必须指向**它之前**已出现过的节点
  const seen = new Set();
  for (const n of nodes) {
    const missing = (n.dependsOn ?? []).find((d) => !seen.has(d));
    if (missing) return `${n.id} 依赖了尚未出现的 ${missing}（依赖不存在或成环）`;
    seen.add(n.id);
  }

  const selfDep = nodes.find((n) => (n.dependsOn ?? []).includes(n.id));
  if (selfDep) return `${selfDep.id} 依赖了自己`;
  return null;
}

/** 打印节点构成，供人工判断规划是否合理（不参与断言） */
function reportNodeMix(nodes) {
  const count = (t) => nodes.filter((n) => n.type === t).length;
  console.log(
    `      节点构成：AI ${count('ai')} 项 / 真人 ${count('human')} 项 / 待确认 ${count('hitl')} 项 / 外部 ${count('external')} 项`,
  );
  console.log(
    `      前 3 个节点：${nodes.slice(0, 3).map((n) => `${n.id}(${n.type})`).join(' → ')}`,
  );
}

/** plan 的参数校验与鉴权（与 intent 同一套纪律：空值 400、未登录 401） */
async function sectionPlanValidation(token) {
  const empty = await call('POST', '/os/plan', { token, body: { goal: '' } });
  check(empty.status === 400, `空 goal 返回 400（实际 ${empty.status}）`);

  const anon = await call('POST', '/os/plan', { body: { goal: '随便什么目标' } });
  check(anon.status === 401, `未登录返回 401（实际 ${anon.status}）`);
}

async function sectionPlan(token) {
  console.log('\n' + '='.repeat(74));
  console.log('⑥ plan 档（深度思考）：目标 → 有依赖关系的 DAG');
  console.log('='.repeat(74));

  const goal = '我要办一场 200 人的校园创新创业大赛，从报名到颁奖全流程帮我安排';
  const t0 = Date.now();
  const r = await call('POST', '/os/plan', { token, body: { goal } });
  const ms = Date.now() - t0;
  check(r.status === 201, `规划 HTTP 201（实际 ${r.status}，${ms}ms）`);

  const data = r.body?.data;
  if (!data) {
    check(false, '响应体含 data');
    return;
  }

  check(data.degraded === false, `未降级（degraded=${data.degraded}）`);
  if (data.degraded) {
    console.log(`      ⚠️ 降级原因：${data.degradedReason ?? '未说明'} —— 后续检查跳过`);
    return;
  }

  const nodes = data.nodes ?? [];
  // 12 = packages/core 的 OS_PLAN_MAX_NODES，刻意硬编码：脚本是 .mjs，读不到 TS 常量
  check(nodes.length > 0 && nodes.length <= 12, `产出 ${nodes.length} 个节点（上限 12）`);

  const defect = findGraphDefect(nodes);
  check(
    !defect,
    defect ? `图结构缺陷：${defect}` : '图结构合法（类型 / id 唯一 / 拓扑序 / 无自依赖）',
  );

  reportNodeMix(nodes);
  await sectionPlanValidation(token);
}

/**
 * ⑦ AI 能力调用与调度：对话里真的能触发工具箱的能力
 *
 * ## 为什么单列一节
 *
 * 此前助手只能"说话"：`OsService` 的工具清单里只有 `search_knowledge`，
 * 而工具箱里 20 个真能跑的 AI 能力一个都没接上。界面上助手会用
 * "可以用 XX 工具完成，点这里开始"把你推去自己填表单 ——
 * **不是没实现，是没接线**，而这种缺失从会话接口的返回里完全看不出来
 *（回复文案看起来很像那么回事）。所以必须真跑一遍，验到产物为止。
 *
 * ## 断言的取舍：验"作业真的建了"，而不是"回复文案说了什么"
 *
 * 文案是模型写的，可以随口说"已经做好了"。真正能证明执行发生过的，
 * 是**作业记录真的存在**（`GET /jobs/:id` 能查到、且属于当前用户）。
 * 顺带反过来钉一条：文案声称完成时**必须有结果卡** ——
 * 没有卡就是"报告成功但没产物"，属于红线 9 的假成功。
 */

/**
 * ⑦-1 能力清单：目录 ∩ 工具表 ∩ 执行器 的对账结果
 *
 * 单独一个函数，一是为了复杂度（这个脚本也受 `complexity ≤ 10` 约束），
 * 二是这一节和"真的能调用"是两件事：清单对不代表调用能通，
 * 调用能通也不代表清单是对的（模型可能靠猜名字调用）。
 */
async function checkCapabilityList(token) {
  const caps = await call('GET', '/os/capabilities', { token });
  check(caps.status === 200, `能力清单 HTTP 200（实际 ${caps.status}）`);

  const available = caps.body?.data?.available ?? [];
  const dropped = caps.body?.data?.dropped ?? [];
  check(available.length > 0, `可用能力 ${available.length} 项`);
  check(available.some((c) => c.toolName === 'generate_ppt'), 'generate_ppt 在可用清单里（本次主场景）');
  check(
    available.some((c) => c.toolName === 'search_knowledge'),
    'search_knowledge（内部能力）也在清单里',
  );
  // 被丢弃的必须带原因，否则"某能力为什么没进来"只能靠翻日志
  check(
    dropped.every((d) => d.toolName && d.reason),
    dropped.length ? `被丢弃 ${dropped.length} 项，且都带原因` : '没有被丢弃的能力',
  );
  if (dropped.length) {
    // 这通常是本地库没跟上 seed 的症状（不是代码问题），如实打印便于一眼定位
    console.log(`      ℹ️ 被丢弃：${dropped.map((d) => `${d.toolName}(${d.reason})`).join('、')}`);
  }

  const anon = await call('GET', '/os/capabilities');
  check(anon.status === 401, `能力清单未登录返回 401（实际 ${anon.status}）`);
}

/**
 * ⑦-2 主干路径：一句中文请求 → 真的建作业 → 回结果卡
 *
 * ⭐ 决定性断言是 `GET /jobs/:id` 能查到作业，而不是"回复文案看起来像做了"——
 * 文案是模型写的，它可以说得头头是道而实际什么都没干。
 */
async function checkPptDispatch(token, sessionId, pptText) {
  const asked = await call('POST', `/os/sessions/${sessionId}/messages`, {
    token,
    body: { content: pptText },
  });
  check(asked.status === 201, `发消息 HTTP 201（实际 ${asked.status}）`);

  const reply = asked.body?.data?.reply;
  const cards = reply?.cards ?? [];
  const resultCard = cards.find((c) => c.kind === 'result');
  console.log(`      助手回复：${String(reply?.content ?? '').slice(0, 60)}…`);

  check(cards.length > 0, `回复带了 ${cards.length} 张结果卡`);
  check(!!resultCard, '其中至少一张是 result 卡（真的执行过，而不是只说了句话）');
  checkHonestClaim(String(reply?.content ?? ''), cards);

  if (!resultCard) return;

  check(resultCard.toolName === 'generate_ppt', `卡指向 generate_ppt（实际 ${resultCard.toolName}）`);
  check(!!resultCard.jobId, `卡里带了作业 id（${String(resultCard.jobId).slice(0, 8)}…）`);
  check(
    Array.isArray(resultCard.params) && resultCard.params.length > 0,
    `卡里带了参数摘要（${resultCard.params.length} 项）`,
  );

  // ⭐ 作业真的存在 —— 这是"不是编出来的卡"的唯一证据
  const job = await call('GET', `/jobs/${resultCard.jobId}`, { token });
  check(job.status === 200, `作业可查（HTTP ${job.status}）`);
  check(job.body?.data?.toolName === 'generate_ppt', `作业工具名正确（${job.body?.data?.toolName}）`);
  check(
    ['queued', 'running', 'succeeded'].includes(job.body?.data?.status),
    `作业状态合理（${job.body?.data?.status}）`,
  );
}

/**
 * 声称"完成"的判定。
 *
 * ⚠️ 正则必须覆盖「已经**为您**生成」这种插了宾语的写法：模型最爱的正是这一句，
 * 而简单的 `已经生成` 会漏掉它，让下面的断言形同虚设（实测踩过）。
 */
function claimsCompletion(text) {
  return /已(?:经)?\s*(?:为(?:您|你))?\s*(?:生成|完成|做好|提交|处理)|正在(?:为(?:您|你))?(?:生成|处理)|已生成|已提交/.test(
    text,
  );
}

/** 诚实性：说了"完成"就必须有卡；没卡就必须带上"未实际执行"的说明 */
function checkHonestClaim(content, cards) {
  if (!claimsCompletion(content)) return;
  // 没有卡就是"报告成功但没产物"（红线 9 的假成功）
  check(cards.length > 0, '文案声称完成 → 必须配结果卡（无卡即假成功）');
  if (!cards.length) {
    check(content.includes('没有实际执行'), '无卡却声称完成时，出口净化必须补上"未实际执行"的说明');
  }
}

/**
 * ⑦-3 同一会话里再来一次同样的请求
 *
 * 这是**实测抓到的真实坑**：历史里有上一轮助手说的"已经为您生成…"，
 * 模型会把历史当成既成事实，于是**不再调用工具、直接复述结论** ——
 * 用户看到"点下面的卡片查看"而下面什么都没有。
 *
 * 两条出路都算通过：重新执行（有 result 卡）／如实说明没执行。
 * 唯一不允许的是"声称完成 + 无卡 + 无说明"这个组合。
 *
 * ⭐ 而"如实说明"那一支**必须再附一张「我的文件」卡**：
 * 模型之所以这么说，恰恰因为上一轮真的生成过，东西就在用户名下。
 * 只补一句"本轮没执行"等于给了坏消息却不给出路。
 *
 * ⚠️ 走哪一支由模型决定（有抖动），所以这里不做"必须重新执行"这类断言 ——
 * 只断言"无论走哪一支，用户都有出路"。
 */
async function checkRepeatRequest(token, sessionId, pptText) {
  const again = await call('POST', `/os/sessions/${sessionId}/messages`, {
    token,
    body: { content: pptText },
  });
  check(again.status === 201, `重复请求 HTTP 201（实际 ${again.status}）`);

  const reply = again.body?.data?.reply;
  const cards = reply?.cards ?? [];
  const content = String(reply?.content ?? '');
  const reExecuted = cards.some((c) => c.kind === 'result');
  const admitted = content.includes('没有实际执行');

  check(
    reExecuted || admitted || !claimsCompletion(content),
    reExecuted
      ? `重复请求重新执行了（${cards.length} 张卡）`
      : '重复请求未执行时，如实说明了"没有实际执行"',
  );
  check(
    !(claimsCompletion(content) && !cards.length && !admitted),
    '不存在"声称完成 + 无卡 + 无说明"的假成功组合',
  );

  // ⭐ 承认"没执行"却不给出路 = 半吊子；必须带上「我的文件」卡
  if (!reExecuted && admitted) checkFilesCard(cards);
}

/** 「我的文件」补救卡：必须有、必须指向文件列表页、且不能冒充成本轮结果 */
function checkFilesCard(cards) {
  const card = cards.find((c) => c.kind === 'files');
  check(!!card, '说了"本轮没执行"就还欠一条出路 → 必须附「我的文件」卡');
  if (!card) return;

  check(
    String(card.route ?? '').includes('/pkg-toolbox/files/'),
    `「我的文件」卡指向文件列表页（${card.route}）`,
  );
  check(!card.jobId, '它不是本轮的结果，不能带作业 id（带了会被当成"已完成"）');
  console.log(`      补救卡：${card.title} — ${card.summary}`);
}

/**
 * ⑦-4 需要文件的能力：缺文件时必须回引导卡，且**不能建作业**
 *
 * 模型可能选择先追问而不是给引导卡（那也是对的），所以这里不算失败，
 * 只如实打印 —— 但一旦给了卡，它必须指向执行页、且不能带作业 id。
 */
async function checkGuideCard(token, sessionId) {
  const guide = await call('POST', `/os/sessions/${sessionId}/messages`, {
    token,
    body: { content: '帮我把这张图片抠一下背景' },
  });
  check(guide.status === 201, `引导场景 HTTP 201（实际 ${guide.status}）`);

  const card = (guide.body?.data?.reply?.cards ?? []).find((c) => c.kind === 'guide');
  if (!card) {
    const text = String(guide.body?.data?.reply?.content ?? '').slice(0, 40);
    console.log(`      ℹ️ 本次模型未产出引导卡（回复：${text}…）`);
    return;
  }

  check(
    String(card.route ?? '').includes('/pkg-toolbox/run/index'),
    `引导卡指向执行页（${String(card.route).slice(0, 48)}…）`,
  );
  check(!card.jobId, '引导卡**没有**作业 id（没执行就不该有作业）');
  console.log(`      引导卡：${card.title} — ${card.summary}`);
}

/**
 * ⑦ AI 能力调用与调度：对话里真的能触发工具箱的能力
 *
 * ## 为什么单列一节
 *
 * 此前助手只能"说话"：`OsService` 的工具清单里只有 `search_knowledge`，
 * 而工具箱里 20 个真能跑的 AI 能力一个都没接上。界面上助手会用
 * "可以用 XX 工具完成，点这里开始"把你推去自己填表单 ——
 * **不是没实现，是没接线**，而这种缺失从会话接口的返回里完全看不出来
 *（回复文案看起来很像那么回事）。所以必须真跑一遍，验到作业为止。
 *
 * ## 为什么每次都新开会话
 *
 * 复用别的用例的会话会踩到 ⑦-3 那个坑（历史里的"已完成"让模型不再执行）。
 * 那个坑本身由 `guardFalseCompletion` 兜住，但这里要验的是主干路径，
 * 不该被它干扰。所以 ⑦-1~④ 用同一个**干净**会话，⑦-3 专门验那个坑。
 */
async function sectionCapabilities(token) {
  console.log('\n' + '='.repeat(74));
  console.log('⑦ AI 能力调用：对话触发 → 建作业 → 结果卡');
  console.log('='.repeat(74));

  const fresh = await call('POST', '/os/sessions', { token, body: { title: '能力验收' } });
  const sessionId = fresh.body?.data?.id;
  check(!!sessionId, '新开一个干净会话（避开历史干扰）');

  const pptText = '帮我做一份关于校园二手交易平台的 PPT，课程汇报用，12 页';

  await checkCapabilityList(token);
  await checkPptDispatch(token, sessionId, pptText);
  await checkRepeatRequest(token, sessionId, pptText);
  await checkGuideCard(token, sessionId);
}

async function main() {
  console.log('\n青智 OS（AI 助手）端到端验证\n');
  console.log(`   接口地址: ${BASE}`);

  const health = await call('GET', '/health');
  if (health.status !== 200) {
    console.log('\n❌ 后端未就绪，请先启动：npm run dev:api');
    process.exit(1);
  }
  const mocks = health.body?.data?.mockProviders ?? [];
  console.log(`   LLM 是否为 Mock: ${mocks.some((m) => m.includes('llm')) ? '是（未配 Key）' : '否（真实模型）'}`);

  const { token, userId } = await login('main');
  if (!token) {
    console.log('\n❌ 登录失败，无法继续');
    process.exit(1);
  }
  console.log(`   登录成功，userId=${String(userId).slice(0, 8)}…`);

  const sessionId = await sectionSessions(token);
  await sectionIntent(token);
  await sectionChat(token, sessionId);
  await sectionOwnership(sessionId);
  await sectionValidation(token);
  await sectionPlan(token);
  await sectionCapabilities(token);

  console.log('\n' + '='.repeat(74));
  console.log(
    failures === 0 ? '🎉 通过：AI 助手链路已接通，且用的是真实模型' : `❌ 有 ${failures} 项未通过`,
  );
  console.log('='.repeat(74));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
