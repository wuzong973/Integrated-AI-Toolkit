/**
 * 端到端验证：AI 极速发布（任务清单 M3-07，`POST /station/parse`）
 *
 * ## 为什么需要它（以及为什么 verify-station 不够）
 *
 * `verify-station.mjs` 的【3】确实打了这条接口，但它把整条驿站写路径串在一起跑，
 * 一旦前面某段（发布/报名）先炸，**这一段的结论就跟着一起丢**。
 * M3-07 单独可验时应当能单独出结论，所以拆一个只打 `/station/parse` 的脚本。
 *
 * ## 它钉住的三类事
 *
 * 1. **真的调了模型**：`/health` 的 `mockProviders` 里不能出现 LLM ——
 *    否则"解析成功"只是本地桩在返回固定 JSON（本项目最容易自欺的形态）；
 * 2. **钱不能错**：模型给的是「元」，归一化要乘 100 变「分」整数。
 *    300 元写成 300 或 3000000 在表单上**看起来都像个正常数字**，
 *    所以这里断言的是单位量级区间，而不只是"是个整数"；
 * 3. **不许编造**：用户没提钱时 `budget` 必须**缺省**。
 *    这一条最反直觉 —— 模型被要求"填表"时的默认行为就是**补一个价**，
 *    而用户会以为那是系统估价（红线 1）。
 *
 * 另外顺带守住两条接缝：未登录必须 401（该路由不在 `@Public()` 名单里）、
 * 短文本必须被 `ParseRequirementSchema` 挡在 400。
 *
 * ## 前置
 *
 *   后端已在运行（`npm run dev:api`），且 `.env` 的 LLM Key 可用、
 *   登录夹具通道（`devLoginCode()`，见 dev-login.mjs）。
 *
 * ## 用法
 *
 *   node scripts/dev/verify-station-parse.mjs [baseUrl]
 *
 * 退出码非 0 = 有断言未通过。
 */
import { resolveBaseUrl } from './base-url.mjs';
import { devLoginCode } from './dev-login.mjs';

const BASE = resolveBaseUrl(process.argv[2]);

/** 真实感输入：一次覆盖 时间/地点/品类/预算 四类槽位 */
const TEXT_WITH_BUDGET = '周五晚上需要人帮我在东区拍一组毕业照，预算300以内';
/** 预算缺省探针：完全没提钱，也不该冒出金额 */
const TEXT_NO_BUDGET = '想找个同学周末一起去操场打羽毛球，我出球';

let failures = 0;
const check = (ok, label, extra = '') => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? `  → ${extra}` : ''}`);
};
const info = (msg) => console.log(`   · ${msg}`);

/** @returns {Promise<{status:number, body:any, headers:Headers, ms:number}>} */
async function call(method, path, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const t0 = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null; // 非 JSON（网关 HTML / 纯文本），保留原文给下面打印用
  }
  return { status: res.status, body: json ?? text, headers: res.headers, ms, raw: text };
}

/** dev 登录换 token（每次新 code → 新用户，避免上一轮数据干扰） */
async function login() {
  const res = await call('POST', '/auth/login', { body: { code: devLoginCode('verify_station_parse') } });
  return { token: res.body?.data?.accessToken, userId: res.body?.data?.user?.id, res };
}

const codeOf = (res) => (typeof res.body === 'object' ? res.body?.code : undefined);
const msgOf = (res) => (typeof res.body === 'object' ? res.body?.message : String(res.body).slice(0, 200));

/** ① 这一轮到底有没有真的打模型 */
async function verifyNotMock() {
  console.log('【1】先确认解析走的是真实模型（红线 1：不许用桩冒充）');
  const health = await call('GET', '/health');
  if (health.status >= 400) {
    check(false, `后端未运行或 /health 失败（HTTP ${health.status}）`, '请先 npm run dev:api');
    return false;
  }
  const d = health.body?.data ?? {};
  info(`status=${d.status} providerMode=${d.providerMode} env=${d.env}`);
  const mocks = (d.mockProviders ?? []).concat((d.degradations ?? []).map((x) => x.name));
  const llmMocked = mocks.some((n) => /llm/i.test(String(n)));
  check(!llmMocked, 'LLM 未走 Mock 通道', mocks.join(', ') || '(无 mock 提供方)');
  return !llmMocked;
}

/** ② 鉴权与入参校验 */
async function verifyGuards(token) {
  console.log('\n【2】鉴权与入参校验');
  const anon = await call('POST', '/station/parse', { body: { text: TEXT_WITH_BUDGET } });
  check(anon.status === 401, `未登录调用报 401（实际 HTTP ${anon.status} / ${codeOf(anon)}）`, msgOf(anon));

  const short = await call('POST', '/station/parse', { body: { text: '拍照' }, token });
  check(
    short.status === 400 && codeOf(short) === 40001,
    `4 字以下文本被 ParseRequirementSchema 挡住（HTTP ${short.status} / ${codeOf(short)}）`,
    msgOf(short),
  );
}

/** 字符串化（缺省一律成空串，避免断言里到处写 ??） */
const str = (v) => (typeof v === 'string' ? v : '');

/** 钱：必须是「分」整数，且量级合理（单位错一次就是 100 倍，界面上看不出来） */
function assertParsedMoney(d) {
  const budget = d.budget;
  check(typeof budget === 'number', '返回了 budget 字段', String(budget));
  check(Number.isInteger(budget), '预算是整数（红线：金额一律用「分」，禁止浮点）', String(budget));
  // 用户说"300 以内" → 30000 分。区间 [10000, 60000] = ¥100~¥600：
  // 单位若错成「元」(300) 或"元当分又乘一次"(3000000)，都会掉出区间。
  check(inRange(budget, 10000, 60000), '预算单位是「分」（300 元 → 30000，非 300 / 非 3000000）', String(budget));
  check(budget === 30000, '预算精确等于 30000 分', String(budget));
}

function inRange(n, lo, hi) {
  return typeof n === 'number' && n >= lo && n <= hi;
}

/** 其余槽位：标题 / 分类 / 描述 / 标签 / 时间地点 / 估价提示 */
function assertParsedSlots(d) {
  const title = str(d.title);
  check(title.length >= 2, '返回标题', title);
  check(title.length <= 20, '标题未超过 20 字（提示词约束）', String(title.length));
  check(d.categoryId === 'photo', '分类识别为 photo（而不是中文名）', String(d.categoryId));
  check(str(d.description).length > 0, '返回需求描述', d.description);
  check(Array.isArray(d.skillTags), 'skillTags 是数组', JSON.stringify(d.skillTags));

  const tags = Array.isArray(d.skillTags) ? d.skillTags : [];
  const badTag = tags.find((t) => typeof t !== 'string' || !t || t.length > 20);
  check(badTag === undefined, '每个技能标签都是非空短词', JSON.stringify(d.skillTags));

  check(optString(d.time) && optString(d.location), 'time / location 类型为缺省或字符串', `time=${d.time} location=${d.location}`);

  // 模型可以把时间/地点并进描述，所以断言的是"信息没丢"而不是"字段一定单独存在"
  const bag = str(d.time) + str(d.location) + str(d.description);
  check(/周五|晚上/.test(bag), '"周五晚上"被承载进了 time/description', d.time);
  check(/东区/.test(bag), '"东区"被承载进了 location/description', d.location);

  check(optString(d.priceHint), 'priceHint 缺省或为真实统计文案（无样本不编造估价）', d.priceHint);
}

/** 缺省或字符串 —— 两者之一即合法 */
function optString(v) {
  return v === undefined || typeof v === 'string';
}

/** ③ 主用例：一句话 → 草稿 */
async function verifyParse(token) {
  console.log('\n【3】一句话解析（真实 LLM 调用）');
  info(`输入：${TEXT_WITH_BUDGET}`);

  const res = await call('POST', '/station/parse', { body: { text: TEXT_WITH_BUDGET }, token });
  const d = (typeof res.body === 'object' ? res.body?.data : undefined) ?? {};
  info(`HTTP ${res.status} code=${codeOf(res)} 耗时 ${res.ms}ms`);
  info(`响应：${JSON.stringify(d)}`);

  check(res.status < 300 && codeOf(res) === 0, '解析成功', msgOf(res));
  assertParsedSlots(d);
  assertParsedMoney(d);

  // ⚠️ 这里**不能**断言 `X-Provider !== mock`：`MockMarkerMiddleware` 打的是
  // 「声明式」全局标记 —— 只要当前装配里有任一 mock Provider 或服务层降级
  //（本项目 mock-pay / mock-moderation，以及 WECHAT_DEV_LOGIN=true 时的 wechat-login），
  // 每条响应都会带 `X-Provider: mock`，与这条接口用没用模型无关。
  // 真正有信息量的是：**标记集合里不含 LLM**（见 ①），以及下面「输出随输入而变」。
  for (const h of ['x-provider', 'x-mock-providers', 'x-degradations']) {
    info(`${h}=${res.headers.get(h) ?? '(无)'}`);
  }
  check(!/llm/i.test(res.headers.get('x-mock-providers') ?? ''), '本请求的 mock 集合里没有 LLM（解析确由模型产出）');

  return { ms: res.ms, d };
}

/** ④ 反编造：没提钱就不能冒出钱 */
async function verifyNoFabricatedBudget(token) {
  console.log('\n【4】用户没提预算时不得编造金额');
  info(`输入：${TEXT_NO_BUDGET}`);
  const res = await call('POST', '/station/parse', { body: { text: TEXT_NO_BUDGET }, token });
  const d = (typeof res.body === 'object' ? res.body?.data : undefined) ?? {};
  info(`HTTP ${res.status} 耗时 ${res.ms}ms 响应：${JSON.stringify(d)}`);
  check(res.status < 300 && codeOf(res) === 0, '解析成功', msgOf(res));
  check(typeof d.title === 'string' && d.title.length >= 2, '仍有标题（草稿可用）', d.title);
  check(
    d.budget === undefined,
    'budget 缺省（前端据此不预填；填了就等于把编的价当成系统估价）',
    String(d.budget),
  );
  return d;
}

/** ⑤ 草稿 → 发布：解析出来的东西必须真能提交 */
async function verifyDraftIsPublishable(token, draft) {
  console.log('\n【5】解析出的草稿直接提交发布（M3-07 → M3-06 接缝）');
  const desc = typeof draft.description === 'string' && draft.description.length >= 10
    ? draft.description
    : `${TEXT_WITH_BUDGET}（补充说明：需要自带设备，出片时间可商量。）`;
  const payload = {
    title: draft.title,
    categoryId: draft.categoryId ?? 'photo',
    description: desc,
    budget: Number.isInteger(draft.budget) ? draft.budget : 30000,
    budgetType: 'fixed',
    skillTags: Array.isArray(draft.skillTags) ? draft.skillTags : [],
    source: 'ai_generated',
  };
  const res = await call('POST', '/station/tasks', { body: payload, token });
  const task = (typeof res.body === 'object' ? res.body?.data : undefined) ?? {};
  info(`提交：${JSON.stringify(payload)}`);
  info(`结果：HTTP ${res.status} code=${codeOf(res)} budget=${task.budget} source=${task.source}`);
  check(res.status < 300 && !!task.id, '草稿能直接发布成任务（不是"填好了但提交报错"）', msgOf(res));
  check(task.budget === payload.budget, '落库预算与草稿一致（单位未被二次换算）', `${payload.budget} vs ${task.budget}`);
  check(task.source === 'ai_generated', 'source=ai_generated 被保留（来源统计不再恒为 manual）', String(task.source));

  if (task.id) {
    const closed = await call('POST', `/station/tasks/${task.id}/close`, { token });
    info(`清理：关闭测试任务 ${task.id}（HTTP ${closed.status}）`);
  }
}

/** ⑥ 契约差异探针：只报告，不算失败（M3-07 本身通了才算通） */
async function probeContractGaps(token, withBudget, withoutBudget) {
  console.log('\n【6】契约差异探针（只报差异，不计入失败）');
  const warn = (msg, detail = '') => console.log(`   ⚠️ ${msg}${detail ? `  → ${detail}` : ''}`);

  // (a) 输出必须随输入而变 —— 固定桩会返回同一份 JSON，那才是"假解析"
  const same =
    withBudget.title === withoutBudget.title && withBudget.categoryId === withoutBudget.categoryId;
  check(!same, '两次不同输入得到不同输出（排除固定桩）', `${withBudget.title} vs ${withoutBudget.title}`);

  // (b) parse 给的 time 是**用户原话**（"周五晚上"），而发布接口的时间字段
  //     `deadline` 要 ISO datetime —— 两端对不上，前端也没提交它。
  const freeText = await call('POST', '/station/tasks', {
    token,
    body: {
      title: '契约差异探针用任务标题',
      categoryId: 'photo',
      description: '这是一条用于验证时间字段口径的探针任务，不会被保留。',
      budget: 1000,
      budgetType: 'fixed',
      deadline: withBudget.time ?? '周五晚上',
    },
  });
  warn(
    `parse 的 time「${withBudget.time}」直接当 deadline 提交：HTTP ${freeText.status} / ${codeOf(freeText)}`,
    msgOf(freeText),
  );
  warn(
    freeText.status >= 400
      ? '已证实：AI 解析出的「时间」无法落入发布接口（前端 onSubmit 也确实没发 time 字段 → 用户填了会丢）'
      : '意外通过：deadline 口径可能已放宽，请复核前端是否仍丢弃 time',
  );

  // (c) 来源标记：后端支持 source=ai_generated，但发布页的 source 只来自页面 query，
  //     onParse 成功后并不改写它 —— AI 发布的占比统计会恒为 0。
  warn('parse 成功后页面仍按 query 传 source（manual）；`ai_generated` 在 apps/mp 里无任何生产方');

  // 探针任务若真被建出来了（deadline 口径已放宽）要关掉，别留在大厅
  const probeId = typeof freeText.body === 'object' ? freeText.body?.data?.id : undefined;
  if (probeId) {
    const closed = await call('POST', `/station/tasks/${probeId}/close`, { token });
    warn(`探针任务 ${probeId} 已建出 → 关闭清理（HTTP ${closed.status}）`);
  }
}

async function main() {
  console.log('='.repeat(74));
  console.log(`   AI 极速发布端到端验证（M3-07）`);
  console.log(`   目标：${BASE}`);
  console.log('='.repeat(74));

  const llmIsReal = await verifyNotMock();

  const { token, userId, res: loginRes } = await login();
  console.log('\n⑩ 登录（测试夹具通道）');
  check(!!token, `dev 登录拿到 accessToken（HTTP ${loginRes.status}）`, String(userId).slice(0, 8));
  if (!token) {
    console.log('\n❌ 无法登录，后续断言全部跳过');
    process.exit(1);
  }

  await verifyGuards(token);
  const parsed = await verifyParse(token);
  const noBudget = await verifyNoFabricatedBudget(token);
  await verifyDraftIsPublishable(token, parsed.d);
  await probeContractGaps(token, parsed.d, noBudget);

  console.log('\n' + '='.repeat(74));
  if (!llmIsReal) console.log('   ⚠️ 注意：LLM 处于 Mock/降级通道，下面的"解析成功"不代表真实模型可用');
  console.log(
    failures === 0
      ? `🎉 通过：AI 极速发布可跑通（单次解析 ${parsed.ms}ms）`
      : `❌ 有 ${failures} 项未通过`,
  );
  console.log('='.repeat(74));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n脚本异常：', e?.stack ?? e);
  process.exit(1);
});
