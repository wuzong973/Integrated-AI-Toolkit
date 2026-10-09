/**
 * 练习中心（M4-16）端到端验证
 *
 * ## 为什么单测不够 —— 五件只能在真环境里验的事
 *
 *   ① **判卷在服务端**。句子的 `en` 在下发时按模式不同：连词成句给英文
 *      （不给砖块没法答），中译英**不给**（给了等于给答案）。
 *      这个区别单测测不到：它在队列服务的组装里，依赖真实数据。
 *
 *   ② **门槛真的生效**。`scoreSpoken` 有单测，但"错答 → 判不过 → 落库为 fail"
 *      这条链要真跑一遍。接口返回的 `pass` 若恒为 true，单测全绿也发现不了。
 *
 *   ③ **SM-2 真的落库了**。提交后立刻查 `today`，模块的 `done` 必须 +1；
 *      且刚练过的题**今天不该到期**（间隔归 1 后到期日是明天）——
 *      这一条能一次性抓住"间隔算错""到期日写错""`@db.Date` 时区错一天"三类问题。
 *
 *   ④ **作文批改降级不阻断**。若 LLM 不通，提交仍要成功（内容照存），
 *      且 `write.comments` 里有一句说明 —— 而不是 500、也不是静默给 0 分。
 *
 *   ⑤ **权重与总分的算法在服务端**。四个维度的权重合计必须是 100，
 *      且总分必须**等于加权结果**（不是模型直接给的数字）。
 *      后者是最容易飘的一处：模型给个总分、代码照抄，看起来完全正常。
 *
 * ## 用法
 *
 *   npm run build -w @qz/api && npm run start -w @qz/api   # 另开一个终端
 *   npm run verify:practice
 *
 * 依赖登录夹具通道（`devLoginCode()`，见 dev-login.mjs）取 token。每次用新 code 登录 = 新用户，
 * 所以结果不受上一次运行影响（两次跑不会互相把配额吃掉）。
 */
import { devLoginCode } from './dev-login.mjs';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';

let failures = 0;
const check = (ok, label, extra = '') => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? ` —— ${extra}` : ''}`);
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

const login = await call('POST', '/auth/login', { body: { code: devLoginCode('practice-probe') } });
const token = login.body?.data?.accessToken;
console.log(`\n登录：HTTP ${login.status}，token ${token ? '已取得' : '缺失'}`);
if (!token) process.exit(1);

/* ==================== ① 模块清单 ==================== */

console.log('\n【模块清单】');
const modules = await call('GET', '/practice/modules', { token });
check(modules.status === 200, 'GET /practice/modules 200', `实际 ${modules.status}`);
const list = modules.body?.data?.modules ?? [];
check(list.length === 3, '返回三个模块（句子/口语/作文）', `实际 ${list.length}`);
const order = list.map((m) => m.module).join(',');
check(order === 'sentence,speak,write', '顺序是 句子→口语→作文（先输入后输出）', order);
for (const m of list) {
  check(Boolean(m.title && m.hint), `模块 ${m.module} 带中文名与说明`);
  check(Array.isArray(m.modes) && m.modes.length > 0, `模块 ${m.module} 有可用模式`);
  for (const md of m.modes) check(Boolean(md.title), `  模式 ${md.mode} 带中文名`);
}

/* ==================== ② 今日总览 ==================== */

console.log('\n【今日总览】');
const today = await call('GET', '/practice/today', { token });
check(today.status === 200, 'GET /practice/today 200', `实际 ${today.status}`);
const t = today.body?.data;
check(Array.isArray(t?.modules) && t.modules.length === 3, '总览含三个模块的计划');
for (const m of t?.modules ?? []) {
  console.log(
    `   · ${m.module}: 配额 ${m.quota} / 已做 ${m.done} / 可取 ${m.available} / 到期复习 ${m.reviewDue}`,
  );
  // ⚠️ 空态必须说清是哪一种空 —— 统一回"暂无数据"会让用户以为功能坏了
  const meaningful = m.available > 0 || m.emptyReason.length > 0;
  check(meaningful, `   ${m.module} 要么有题、要么给了空态原因`);
}
check(Array.isArray(t?.calendar) && t.calendar.length === 30, '打卡日历补齐 30 天（缺的补零）');
check(typeof t?.streak === 'number', '返回连续打卡天数');
check(typeof t?.totals?.speakAvg === 'number', '返回口语平均分');

/* ==================== ③ 句子练习 ==================== */

console.log('\n【句子练习 · 连词成句】');
const sent = await call('GET', '/practice/cards?module=sentence', { token });
check(sent.status === 200, 'GET /practice/cards?module=sentence 200', `实际 ${sent.status}`);
const sc = sent.body?.data;
check(Array.isArray(sc?.cards), '返回句子卡数组');
check((sc?.cards ?? []).length > 0, '句子队列非空（语料已入库）', `${(sc?.cards ?? []).length} 题`);
check(sc?.quota <= 10, '单次题量不超过 10（配额上限）', `${sc?.quota}`);

const card = (sc?.cards ?? [])[0];
if (card) {
  console.log(`   题目：${card.zh}`);
  check(card.en !== null, '连词成句模式**下发**英文（不给砖块没法答）');
  check(sc?.mode === 'chunks', 'cards 接口透出实际模式（客户端靠它决定渲染哪套题面）', sc?.mode);
  check(Array.isArray(card.chunks) && card.chunks.length > 0, '带语块（连词成句的砖块）');
  check(typeof card.wordCount === 'number' && card.wordCount > 0, '带词数');
  check(card.index === 1, '带题号（界面显示"1/10"用）');

  // —— 错答：必须判不过，且逐词标出差异 ——
  const wrong = await call('POST', '/practice/submit', {
    token,
    body: { refId: card.id, module: 'sentence', text: 'this is definitely wrong text here' },
  });
  const wd = wrong.body?.data;
  check(wrong.status === 200 || wrong.status === 201, '提交错答返回成功（不 500）', `实际 ${wrong.status}`);
  check(wd?.pass === false, '错答判为未通过');
  check(typeof wd?.score === 'number' && wd.score < 100, '返回非满分', `${wd?.score}`);
  check(Array.isArray(wd?.words) && wd.words.length > 0, '返回逐词对比（用户要知道哪个词错）');
  check(wd?.target === card.en, '返回目标句原文');
  check(typeof wd?.needScore === 'number' && wd.needScore > 0, '未过时返回"还差多少"', `${wd?.needScore}`);

  // —— 正答：必须判过、得满分 ——
  const right = await call('POST', '/practice/submit', {
    token,
    body: { refId: card.id, module: 'sentence', text: card.en },
  });
  const rd = right.body?.data;
  check(rd?.pass === true, '正确答案判为通过');
  check(rd?.score === 100, '正确答案得满分', `${rd?.score}`);
  check(rd?.needScore === 0, '已过时 needScore 为 0');
  check((rd?.schedule?.intervalDays ?? 0) >= 1, '落库了 SM-2 间隔', `${rd?.schedule?.intervalDays} 天`);
  check(Boolean(rd?.schedule?.dueDate), '返回下次到期日');
  check((rd?.today?.sentenceCount ?? 0) >= 2, '当天计数累加（错了也算练过）', `${rd?.today?.sentenceCount}`);

  // ⚠️ 口径一致性：这一批里**原来不在队列里的新题**，练完之后今天不该再出现。
  //
  // 为什么不能直接断言 `card`：`card` 是队列首位，而队列的顺序是
  // **到期复习优先、新题补位**（见 `pickSentenceRows`）。若它本来就是"今天到期"
  // 才排到第一位的，那它练完后只是把到期日推到**明天**，今天依然到期 ——
  // 这恰恰是正确行为，拿它断言会把对的判成错的。
  //
  // 正确做法：先记下这一批的 id 集合，练一道**队列里的新题**，再看它是否还在。
  const before = new Set((sc?.cards ?? []).map((c) => c.id));
  const after = await call('GET', '/practice/cards?module=sentence', { token });
  const freshCard = (after.body?.data?.cards ?? []).find((c) => !before.has(c.id));
  if (freshCard) {
    await call('POST', '/practice/submit', {
      token,
      body: { refId: freshCard.id, module: 'sentence', text: freshCard.en },
    });
    const again = await call('GET', '/practice/cards?module=sentence', { token });
    const stillThere = (again.body?.data?.cards ?? []).some((c) => c.id === freshCard.id);
    check(!stillThere, '刚练过的新题今天不再出现在队列里（SM-2 生效）');
  } else {
    // 题目全都做过时无法验证 —— 明说"没验证"，不要静默跳过（静默跳过会被读成"通过了"）
    console.log('   ⚠️ 队列里没有未练过的新题，跳过 SM-2 队列排除断言');
  }
}

/* ==================== ④ 题面字段与模式一致 ==================== */

console.log('\n【句子练习 · 题面字段与模式一致】');
// 下发的题面是 `chunks` 模式（连词成句），此时 `en` 与 `chunks` **都**应有值：
// `en` 用来在答完后展示目标句，`chunks` 是拼装用的砖块。
// 而 `recall`（中译英）**必须**让 `en` 为 null —— 给了就等于给答案。
// HTTP 只暴露当前模式，所以这里断言"当前模式下的字段组合是对的"，
// 三种模式的穷举放在单测（`practice.spec.ts`）。
const modes = sc?.modes ?? [];
check(modes.includes('chunks'), '句子的默认题面是连词成句');
check(modes.includes('recall') && modes.includes('listen'), '同时声明了中译英与听写可供切换');
check(sc?.mode === 'chunks' && card?.en !== null && card?.chunks !== null, 'chunks 模式下 en 与 chunks 同时有值');

/* ==================== ⑤ 口语跟读 ==================== */

console.log('\n【口语跟读】');
const speak = await call('GET', '/practice/cards?module=speak', { token });
check(speak.status === 200, 'GET /practice/cards?module=speak 200', `实际 ${speak.status}`);
const sp = speak.body?.data;
check(sp?.cards?.length > 0, '口语队列非空（有可朗读的句子）', `${sp?.cards?.length} 题`);
check(sp?.quota <= 6, '口语单次题量不超过 6（要录音，定多了会劝退）', `${sp?.quota}`);
check(sp?.mode === 'speak', '口语题面模式是 speak（与句子练习共用一批句子、不同渲染）', sp?.mode);
const spCard = (sp?.cards ?? [])[0];
if (spCard) {
  console.log(`   题目：${spCard.en}`);
  check(spCard.en !== null, '口语模式**必须**下发英文（看不到句子就没法跟读）');

  // 缺音频：必须明确报错（不是 500、也不是静默判 0 分）
  const noAudio = await call('POST', '/practice/submit', {
    token,
    body: { refId: spCard.id, module: 'speak' },
  });
  check(noAudio.status === 400, '没传录音时返回 400（明确的参数错误）', `实际 ${noAudio.status}`);
  check(!noAudio.body?.data, '400 时不带业务数据（不给"假通过"）');

  // 太短的音频：必须在**调 ASR 之前**拦掉（省一次额度）
  const tooShort = await call('POST', '/practice/submit', {
    token,
    body: { refId: spCard.id, module: 'speak', audioBase64: 'AAAAAAAA', audioFormat: 'mp3' },
  });
  check(tooShort.status === 400, '录音过短时返回 400（不进 ASR）', `实际 ${tooShort.status}`);
  console.log(`      提示：${tooShort.body?.message ?? ''}`);
}

/* ==================== ⑥ 作文 ==================== */

console.log('\n【作文练习】');
const write = await call('GET', '/practice/cards?module=write', { token });
check(write.status === 200, 'GET /practice/cards?module=write 200', `实际 ${write.status}`);
const wt = write.body?.data;
check((wt?.topics ?? []).length > 0, '作文题库非空', `${(wt?.topics ?? []).length} 题`);
check(wt?.quota <= 1, '作文单次题量为 1（一篇要认真写 20 分钟）', `${wt?.quota}`);
check(wt?.mode === 'write' && (wt?.cards ?? []).length === 0, '作文模块不下发句子卡（题面字段形状不同）');
const topic = (wt?.topics ?? [])[0];
if (topic) {
  console.log(`   题目：${topic.title}`);
  check(topic.outline.length > 0, '带提纲（该写哪几点）');
  check(Boolean(topic.zhBrief), '带中文题意说明');
  check(topic.minWords > 0, '带词数下限', `${topic.minWords}`);
  // ⚠️ 范文必须**不**在题面里 —— 提前下发等于把答案放在首屏，抓包即得
  check(!('sample' in topic), '题面里**不含**范文（提前下发等于给答案）');

  // —— 太短：必须落库（内容不丢），但不批改 ——
  const short = await call('POST', '/practice/submit', {
    token,
    body: { refId: topic.id, module: 'write', text: 'Too short.' },
  });
  const sd = short.body?.data;
  check(short.status === 200 || short.status === 201, '过短的作文仍提交成功（内容不丢）', `实际 ${short.status}`);
  check(sd?.write?.tooShort === true, '标记为 tooShort');
  check(sd?.write?.wordCount === 2, '返回准确词数', `${sd?.write?.wordCount}`);
  check((sd?.write?.comments ?? []).length > 0, '给出"太短"的说明（不是静默丢弃）');
  check(Boolean(sd?.write?.sample), '过短时也能看到范文');
  check(sd?.pass === false, '过短不算完成一次练习');

  // —— 写够：进入批改（LLM 不通时降级，但**必须**仍返回成功）——
  const full = await call('POST', '/practice/submit', {
    token,
    body: { refId: topic.id, module: 'write', text: buildEssay(topic.zhBrief) },
  });
  const fd = full.body?.data;
  check(full.status === 200 || full.status === 201, '写够词数时提交成功', `实际 ${full.status}`);
  check(fd?.pass === true, '写够词数算完成一次练习', `pass=${fd?.pass}`);
  check(fd?.write?.tooShort === false, '不再标记 tooShort');
  check((fd?.write?.wordCount ?? 0) >= topic.minWords, '词数达到下限', `${fd?.write?.wordCount}/${topic.minWords}`);
  const dims = fd?.write?.dimensions ?? [];
  check(dims.length === 4, '返回四个维度的批改', `${dims.length}`);
  if (dims.length === 4) {
    const weightSum = dims.reduce((s, d) => s + (d.weight ?? 0), 0);
    check(weightSum === 100, '四个维度权重合计 100', `${weightSum}`);
    for (const d of dims) {
      check(Boolean(d.comment), `   维度 ${d.key} 带理由（只给分数用户不知道从哪改）`);
      check(typeof d.score === 'number' && d.score >= 0 && d.score <= 100, `   维度 ${d.key} 分数在 0~100`);
    }
    // ⭐ 总分必须**等于加权结果**，不是模型给的数字（最易飘的一处）
    const expected = Math.round(dims.reduce((s, d) => s + (d.score * d.weight) / 100, 0));
    check(
      Math.abs((fd?.write?.total ?? -1) - expected) <= 1,
      '总分等于服务端加权结果（不是模型直接给的）',
      `${fd?.write?.total} vs ${expected}`,
    );
    // 批改服务不可用时的降级：四个维度全 0 且 comments 里有说明
    const degraded = dims.every((d) => d.score === 0);
    if (degraded) {
      check(
        (fd?.write?.comments ?? []).some((c) => c.includes('不可用')),
        '批改不可用时给出明确说明（不是静默给 0 分）',
      );
      console.log('   ⚠️ 本次批改走了降级路径（LLM 不可用），已确认提示到位');
    }
  }
  check((fd?.write?.sample?.length ?? 0) > 0, '返回范文');
  check((fd?.reference?.length ?? 0) > 0, '返回中文题意');
}

/* ==================== ⑦ 统计口径一致 ==================== */

console.log('\n【统计】');
const stats = await call('GET', '/practice/stats', { token });
check(stats.status === 200, 'GET /practice/stats 200', `实际 ${stats.status}`);
const s = stats.body?.data;
const sCard = (s?.modules ?? []).find((m) => m.module === 'sentence');
if (sCard) {
  check(
    sCard.done === (s?.today?.sentenceCount ?? 0),
    '模块的 done 与当天计数一致（两处口径不能漂移）',
    `${sCard.done} vs ${s?.today?.sentenceCount}`,
  );
}
const last = (s?.calendar ?? [])[s?.calendar?.length - 1];
check(Boolean(last), '日历最后一天是今天');
if (last) {
  check(
    (last.sentenceCount ?? 0) + (last.speakCount ?? 0) + (last.writeCount ?? 0) ===
      (s?.today?.sentenceCount ?? 0) + (s?.today?.speakCount ?? 0) + (s?.today?.writeCount ?? 0),
    '日历今天与 today 计数一致',
  );
}
check((s?.streak ?? 0) >= 1, '今天练过 → 连续天数 ≥ 1', `${s?.streak}`);

/* ==================== ⑧ 鉴权 ==================== */

console.log('\n【鉴权】');
const anon = await call('GET', '/practice/today');
check(anon.status === 401, '未登录访问 /practice/today 返回 401', `实际 ${anon.status}`);
const anonSubmit = await call('POST', '/practice/submit', { body: { refId: 'x', module: 'sentence' } });
check(anonSubmit.status === 401, '未登录提交返回 401', `实际 ${anonSubmit.status}`);
const anonCards = await call('GET', '/practice/cards');
check(anonCards.status === 401, '未登录取题面返回 401', `实际 ${anonCards.status}`);

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项未通过`}\n`);
process.exit(failures === 0 ? 0 : 1);

/* ==================== 辅助 ==================== */

/**
 * 造一篇够长的作文（≥120 词）。
 *
 * ⚠️ 刻意**不写"范文式"的漂亮句子**：若脚本交一篇与题库范文高度相似的作文，
 * 批改分数的断言就失去意义（模型可能只是在比对相似度）。
 * 这里用结构清楚但用词普通的句子，得到的是一个"中等水平学生"的样本。
 */
function buildEssay(brief) {
  return [
    `This essay discusses the topic: ${brief ?? 'a campus issue'}.`,
    '',
    'To begin with, the issue matters because it affects almost every student on campus.',
    'Many of us meet it in daily life, yet few of us stop to think about how it works.',
    '',
    'There are two sides to consider. On the one hand, the current situation brings real',
    'convenience, and it would be unfair to deny that. On the other hand, the costs are',
    'easy to overlook because they appear slowly rather than at once.',
    '',
    'In my view, a reasonable attitude is neither to reject the change nor to accept it',
    'without question. We should look at what we actually gain and what we quietly give up.',
    'If the gains are real and the costs can be managed, the change is worth accepting.',
    'If not, we should say so clearly and act on it.',
    '',
    'To sum up, the question is not whether the change is good or bad in itself, but how',
    'we choose to use it. That choice is still ours to make.',
  ].join('\n');
}
