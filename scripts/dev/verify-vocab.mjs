/**
 * 记单词 / 四六级词汇训练（M4-15）端到端验证
 *
 * ## 为什么需要它
 *
 * 这条链路上有三件事**只能在真环境里验，单测验不到**：
 *   ① 判卷在服务端 —— 卡片里不该有 `answerKey`，对错必须由 `POST /vocab/answer` 给；
 *   ② SM-2 真的落库了 —— 答完立刻查统计，此刻应该"零到期"（新学的词明天才到期），
 *      这条能一次性抓住"间隔算错""到期日写错""@db.Date 时区错一天"三类问题；
 *   ③ 发音是真链路 —— `provider` 必须是侧车而不是 `mock-*`，
 *      拿到的必须是 mp3/wav 的 base64（Mock 会返回一段占位音频，长度与格式都对不上）。
 *
 * ## 用法
 *
 *   npm run build -w @qz/api && npm run dev:api   # 另开一个终端
 *   npm run verify:vocab
 *
 * 依赖登录夹具通道（`devLoginCode()`，见 dev-login.mjs）取 token，以及 `npm run dev:media`
 * （发音走侧车 edge-tts）。每次用新 code 登录 = 新用户，所以结果不受上一次运行影响。
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

const login = await call('POST', '/auth/login', { body: { code: devLoginCode('vocab-probe') } });
const token = login.body?.data?.accessToken;
console.log(`\n登录：HTTP ${login.status}，token ${token ? '已取得' : '缺失'}`);
if (!token) process.exit(1);

/**
 * 按**题型**造提交体。
 *
 * 选择题传 `choice`（选项 key）、拼写/填空传 `text`（用户输入）——
 * 与服务端 `pickSubmitted` 的映射完全对齐。合并成一个字段的话，
 * 服务端就得靠"这个字符串像不像选项 key"来猜题型，猜错的表现是
 * "拼写题把一个单词当成 key 判错"，静默且难查。
 */
function buildSubmission(card) {
  if (card.type === 'spelling' || card.type === 'cloze') {
    // 故意传一个明显不对的：这条链路要验的是"判卷能跑通且自洽"，
    // 而不是"能不能蒙对"。正确答案拿不到（卡片里没有），所以不追求答对。
    return { text: 'zzzzzz' };
  }
  return { choice: card.options[0].key };
}

/** 题型分布，打印用 */
function typeSummary(cards) {
  const count = {};
  for (const c of cards) count[c.type] = (count[c.type] ?? 0) + 1;
  return JSON.stringify(count);
}

console.log('\n① 词书列表 GET /vocab/books');
const books = await call('GET', '/vocab/books', { token });
const list = books.body?.data ?? [];
check(books.status === 200, `HTTP ${books.status}`);
check(Array.isArray(list) && list.length > 0, `返回 ${list.length} 本词书`);
console.log(`   ${list.map((b) => `${b.code}(${b.status}, ${b.wordCount} 词)`).join(' / ')}`);

console.log('\n② 还没选词书时 GET /vocab/today：一次请求就能画完选词书那一屏');
const before = await call('GET', '/vocab/today', { token });
check(before.body?.data?.needsBook === true, 'needsBook=true');
check((before.body?.data?.books ?? []).length > 0, '同一次响应里带回了词书列表');

console.log('\n③ 选词书 POST /vocab/books/select');
// 至少两本可选才验得了"来回切" —— 只有一本的话下面的 ③b 会跳过并说明原因
const selectable = list.filter((b) => b.status === 'active');
const active = selectable[0];
if (!active) {
  console.log('   ❌ 没有 status=active 的词书，后面无法继续（先跑 npm run db:gen-words）');
  process.exit(1);
}
const sel = await call('POST', '/vocab/books/select', { token, body: { code: active.code } });
check(sel.status === 200 || sel.status === 201, `HTTP ${sel.status}`);
check((sel.body?.data ?? []).some((b) => b.isActive), `选中的这本 isActive=true（${active.code}）`);

console.log('\n③b 词书可自由切换（来回切两本，任意时刻至多一本 active）');
if (selectable.length < 2) {
  console.log(`   ⚠️ 只有 ${selectable.length} 本可选词书，跳过切换验证（至少需要 2 本）`);
} else {
  const other = selectable[1];
  // ① 切到第二本
  const toOther = await call('POST', '/vocab/books/select', { token, body: { code: other.code } });
  let rows = toOther.body?.data ?? [];
  check(rows.find((b) => b.code === other.code)?.isActive === true, `切到 ${other.code} 后它是当前词书`);
  check(rows.filter((b) => b.isActive).length === 1, `此刻 active 的词书恰好 1 本（不是 0 也不是 2）`);

  // ② ⭐ 切回第一本 —— 这正是界面上"选了六级回不去四级"的那个动作。
  //    判据必须是**接口成功 + 状态真的翻回来**，而不是"没报错"。
  const back = await call('POST', '/vocab/books/select', { token, body: { code: active.code } });
  rows = back.body?.data ?? [];
  check(back.status === 200 || back.status === 201, `切回 HTTP ${back.status}`);
  check(rows.find((b) => b.code === active.code)?.isActive === true, `切回 ${active.code} 后它是当前词书`);
  check(rows.find((b) => b.code === other.code)?.isActive === false, `${other.code} 已取消激活`);
  // 切走的那本必须仍然 selected（学过的进度不能因为换书而丢掉）
  check(rows.find((b) => b.code === other.code)?.selected === true, `${other.code} 仍是"选过的"（进度保留）`);
  check(rows.filter((b) => b.isActive).length === 1, `来回切之后 active 仍然恰好 1 本`);

  // ③ 换书时必须能拿到**完整的词书列表** —— 前端「换词书」按钮就靠这个接口。
  //    ⚠️ 曾经用 `GET /vocab/today` 的 `books` 字段，而它只在"还没有词书"时才非空，
  //    于是换书界面是空的、用户以为回不去（见 apps/mp/pkg-vocab/home/index.ts 的 onSwitchBook）。
  const booksAgain = await call('GET', '/vocab/books', { token });
  check((booksAgain.body?.data ?? []).length === list.length, `换书时 GET /vocab/books 返回全部 ${list.length} 本（不是空列表）`);
}

console.log('\n③c 词库规模（词书数量与词量都要够用）');
const withWords = list.filter((b) => b.wordCount > 0);
// 下限是"词书系统没退化"的底线，不是目标值。
// ⚠️ M4-16 按需求删掉了小学/初中/高中的**通用**词书，只留两本教材版，
// 词书数从 23 降到 13 —— 这是**有意的内容调整**。
// 因此这里不能再写"≥ 15"（那会把有意调整误报成故障，也会挡住下次精简）。
// 真正该守的是"每本都有词"与"总量够用"，词书数量本身只作下限兜底。
check(list.length >= 10, `词书 ${list.length} 本（≥ 10）`);
check(withWords.length === list.length, `全部 ${list.length} 本都有词（不允许"建设中"）`);
const wordTotal = list.reduce((a, b) => a + b.wordCount, 0);
check(wordTotal >= 30000, `词条关联合计 ${wordTotal}（≥ 30000）`);
// ⚠️ `category` 驱动小程序的分组渲染：**缺了它那本词书会被归到「其他」**
// （有兜底所以不会消失，但会分组错），所以这里必须显式断言它非空。
const noCat = list.filter((b) => !b.category);
check(noCat.length === 0, `分类字段齐全${noCat.length ? `（缺：${noCat.map((b) => b.code).join(',')}）` : ''}`);
const catCount = {};
for (const b of list) catCount[b.category] = (catCount[b.category] ?? 0) + 1;
console.log(`   分类：${JSON.stringify(catCount)}`);
console.log(`   ${list.map((b) => `${b.code}=${b.wordCount}`).join(' / ')}`);

console.log('\n④ 今日计划 GET /vocab/today');
const today = await call('GET', '/vocab/today', { token });
const t = today.body?.data;
check(t?.needsBook === false, 'needsBook=false');
check((t?.newCards?.length ?? 0) > 0, `今日新词 ${t?.newCards?.length} 个`);
check(t?.totals?.learned === 0, `新用户初始已学 ${t?.totals?.learned}`);

// 每张卡片必须自带题型，且题型对应的字段是齐的 ——
// 客户端要按 type 决定渲染什么，缺了它那道题就是一片空白（且不报错）
const cards = [...(t?.reviewCards ?? []), ...(t?.newCards ?? [])];
console.log(`   题型分布：${typeSummary(cards)}`);
const TYPES = ['meaning', 'spelling', 'listening', 'cloze'];
const badType = cards.filter((c) => !TYPES.includes(c.type));
check(badType.length === 0, `题型取值合法${badType.length ? `（异常：${badType.map((c) => c.type).join(',')}）` : ''}`);
check(
  cards.every((c) => typeof c.prompt === 'string' && typeof c.senseText === 'string'),
  '题面字段（prompt / senseText）都已下发',
);
check(cards.every((c) => c.answerKey === undefined && c.answer === undefined), '卡片里没有答案泄漏');

// 选择题一定要 4 个选项；拼写题一定没有选项 —— 两个方向都验，
// 否则"拼写题也发 4 个选项"（答案就在里面）这种泄漏不会被发现
const choiceCards = cards.filter((c) => c.type !== 'spelling');
const spellCards = cards.filter((c) => c.type === 'spelling');
check(choiceCards.length === 0 || choiceCards.every((c) => c.options.length === 4), `选择题都是 4 个选项（${choiceCards.length} 张）`);
check(spellCards.every((c) => c.options.length === 0), `拼写题没有选项（${spellCards.length} 张）`);
// ⭐ 听音辨词绝对不能带词形：带了这道题就退化成送分题（且不会有任何报错）
const listenCards = cards.filter((c) => c.type === 'listening');
check(
  listenCards.every((c) => c.spelling === '' && c.phonetic === ''),
  `听音辨词不带词形与音标（${listenCards.length} 张）`,
);

const card = t.newCards.find((c) => c.type !== 'spelling') ?? t.newCards[0];
const card2 = t.newCards.find((c) => c.wordId !== card.wordId && c.type !== 'spelling') ?? t.newCards[1];
console.log(`   首题：${card.type}｜${card.spelling || '(听音)'}｜${card.prompt || card.senseText || card.phonetic}`);

console.log('\n④b 四种题型都能出得出来（题目要覆盖听说读写四条通道）');
// 只出 10 个词时题型可能不齐，所以单独请求几轮、把题型收集起来看覆盖面。
// ⚠️ 这不是"必须一次集齐"的断言：题型由 (词 id, 复习次数) 决定，
// 词库与队列都变了就可能换一批题型 —— 下面用累计的方式判断覆盖面。
const seenTypes = new Set(cards.map((c) => c.type));
check(seenTypes.size >= 2, `首屏出现 ${seenTypes.size} 种题型（${[...seenTypes].join('/')}）`);
check(seenTypes.has('meaning'), '含"看词选义"（门槛最低的兜底题型）');

console.log('\n⑤ 作答 POST /vocab/answer');
// 提交形状**按题型来**：选择题传 choice、拼写/填空传 text。
// 服务端靠题型决定读哪个字段（不靠"这个字符串长不像 key"来猜）。
const first = buildSubmission(card);
const ans = await call('POST', '/vocab/answer', { token, body: { wordId: card.wordId, ...first } });
const a = ans.body?.data;
check(ans.status === 200 || ans.status === 201, `HTTP ${ans.status}`);
check(a?.type === card.type, `回显题型一致（${a?.type}）`);
// 客户端事先并不知道正确项，所以断言的是"服务端判卷自洽"而不是某个固定结果
if (card.type === 'spelling') {
  check(typeof a?.answerText === 'string' && a.answerText.length > 0, `回显正确答案「${a?.answerText}」`);
  check(typeof a?.nearMiss === 'boolean', `nearMiss 已下发（${a?.nearMiss}）`);
} else {
  check(a?.correct === (a?.answerKey === first.choice), `correct=${a?.correct}（选 ${first.choice}，正确项 ${a?.answerKey}）`);
}
check((a?.word?.senses?.length ?? 0) > 0, '答完才给释义');
// ⚠️ 例句**不是每个词都有**（词库覆盖 18,710 / 22,313），所以断言的是
// "有这个字段、且长度对得上"，而不是"必须有例句" —— 后者会把
// "这个词恰好没有例句"误判成"链路断了"，制造假红灯。
check(Array.isArray(a?.word?.examples), '答完下发例句字段（数组）');
check(typeof a?.word?.ukPhonetic === 'string', '答完给出英式音标字段');
check(Array.isArray(a?.word?.phrases), '答完给出词组搭配字段');
// 有例句的词必须把 en/zh 两个键都映射出来（曾出现只映射 en 的情况）
const ex = (a?.word?.examples ?? [])[0];
check(!ex || (typeof ex.en === 'string' && typeof ex.zh === 'string'), `例句结构完整${ex ? `（${ex.en}）` : '（此词无例句）'}`);
check((a?.schedule?.intervalDays ?? 0) >= 1, `下次复习：${a?.schedule?.intervalDays} 天后`);
// ⑤b 会答在**另一个**词上，所以这里只断言"首题算作 1 个新学"，
// 后面用"不同词的数量"来交叉验证（见 ⑥/⑦）
check(a?.today?.newCount === 1, `首题后新学计为 ${a?.today?.newCount}`);
check((a?.today?.correctCount ?? 0) + (a?.today?.wrongCount ?? 0) === 1, '当天作答数 = 1');

console.log('\n⑤b ⭐ 拼写题判卷：答对 / 差一点 / 完全错 三种结果都要能区分');
// 找一个拼写题来验。队列里没有就跳过并说明 —— **不能**把"这轮没抽到"当成失败。
// ⚠️ 必须挑一个**与 ⑤ 不同的词**：同一道题会被反复提交，若与 ⑤ 撞词，
// 后面的 newCount / 已学数全部对不上（那些断言数的是"几个不同的词"）。
const spellCard = cards.find((c) => c.type === 'spelling' && c.wordId !== card.wordId);
if (!spellCard) {
  console.log('   ⚠️ 本轮队列里没有（不同于首题的）拼写题，跳过');
  console.log('      —— 题型由 (词 id, 复习次数) 决定，抽不到是正常现象，不是失败');
} else {
  // ① 全错
  const wrong = await call('POST', '/vocab/answer', {
    token,
    body: { wordId: spellCard.wordId, text: 'zzzzzz' },
  });
  check(wrong.body?.data?.correct === false, '拼错的判错');
  check(wrong.body?.data?.nearMiss === false, '完全不像 → nearMiss=false');
  const right = wrong.body?.data?.answerText ?? '';
  check(right.length > 0, `正确答案可从响应里取到（${right}）`);

  // ② ⭐ 差一点（编辑距离 = 1）：必须判错、但标 nearMiss（SM-2 记 vague，间隔涨得慢）。
  //    这条是"拼写题专属"的判卷分支，用别的方式构造不出来 —— 少了它，
  //    整条 nearMiss 链路就只有单测覆盖，真实请求可能根本没走到。
  if (right.length >= 4) {
    // 删掉倒数第二个字符，构造一个距离恰好为 1 的串（保证与原词不同）
    const near = right.slice(0, -2) + right.slice(-1);
    if (near !== right) {
      const nearRes = await call('POST', '/vocab/answer', {
        token,
        body: { wordId: spellCard.wordId, text: near },
      });
      check(nearRes.body?.data?.correct === false, `差一个字母（${near}）不算答对`);
      check(nearRes.body?.data?.nearMiss === true, '差一个字母 → nearMiss=true');
    }
  }

  // ③ 正确（故意改大小写与首尾空格）—— 必须判对
  //    ⚠️ 这里必须再确认**题型没漂移**：题型由 `(词 id, repetitions)` 决定，
  //    而每一次提交都会推进 repetitions。若漂到别的题型，这个词就不再接受 `text` 提交，
  //    于是"判错"其实是"提交字段用错了"，看起来像判卷 bug。
  const again = await call('POST', '/vocab/answer', {
    token,
    body: { wordId: spellCard.wordId, text: `  ${right.toUpperCase()}  ` },
  });
  const ag = again.body?.data;
  check(ag?.type === 'spelling', `第 ③ 次提交时题型仍是拼写（实际 ${ag?.type}）`);
  check(ag?.correct === true, `大小写与首尾空格不影响判对（提交 "${ag?.submitted}"，正确 "${ag?.answerText}"）`);
}

console.log('\n⑥ 同一题重复提交：不再算"新学"，但按新答案重新判卷');
const second = buildSubmission(card2);
const ans2 = await call('POST', '/vocab/answer', { token, body: { wordId: card2.wordId, ...second } });
// ⑥ 答的是第二个词，此刻已学数 = 2（⑤ 的首题）+（⑤b 的拼写题）+ 这一题
const afterSecond = 2 + (spellCard ? 1 : 0);
check(
  ans2.body?.data?.today?.newCount === afterSecond,
  `答完第二题后已学 ${ans2.body?.data?.today?.newCount} 个词（预期 ${afterSecond}）`,
);
// 重复提交同一道题，换一个**必然错误**的答案：
// 必须按新提交重新判卷，而不是记着上次的结果、也不是"同一题只判一次"。
// ⚠️ 这里刻意不追求"换一个 key 还能答对" —— 选择题的正确项由服务端给（客户端事先不知道），
// 所以只断言"换答案后结果跟着变"。拼写题同理：正确答案就是词形，随便写必然错。
let repeat;
if (card.type === 'spelling' || card.type === 'cloze') {
  repeat = await call('POST', '/vocab/answer', { token, body: { wordId: card.wordId, text: 'definitely_wrong' } });
} else {
  const other = a.answerKey === 'a' ? 'b' : 'a';
  repeat = await call('POST', '/vocab/answer', { token, body: { wordId: card.wordId, choice: other } });
}
const r = repeat.body?.data;
check(r?.correct === false, `重复提交按新答案判卷 correct=${r?.correct}`);

// 这一轮一共答过几个**不同的词**：⑤ 的首题 +（⑤b 的拼写题）+ ⑥ 的第二题。
// ⚠️ 新学数 = 不同词的数量，不是提交次数 —— 拿它当"提交次数"数会一直差一个，
// 而这个差值正好等于"有一次重复提交"，是这条断言存在的意义。
const distinctWords = new Set([card.wordId, card2.wordId, ...(spellCard ? [spellCard.wordId] : [])]);
const expectedNew = distinctWords.size;
check(
  r?.today?.newCount === expectedNew,
  `已学 ${r?.today?.newCount} 个不同词（预期 ${expectedNew}）`,
);
const answered = (r?.today?.correctCount ?? 0) + (r?.today?.wrongCount ?? 0);
// ⑤ 1 次 +（⑤b 拼写题额外 3 次：错 / 差一点 / 对）+ ⑥ 1 次新题 + ⑥ 1 次重复提交
const expectedAnswered = 3 + (spellCard ? 3 : 0);
check(answered === expectedAnswered, `当天作答数 ${answered}（预期 ${expectedAnswered}）`);
// ⭐ 重复提交同一个词**不能**再算一次新学 —— newCount 必须严格小于作答次数
check(
  (r?.today?.newCount ?? 0) < answered,
  `重复提交没有把学过的词再算一次新学（学 ${r?.today?.newCount} 个 / 答 ${answered} 次）`,
);

console.log('\n⑦ 统计 GET /vocab/stats');
const stats = await call('GET', '/vocab/stats', { token });
const s = stats.body?.data;
check(stats.status === 200, `HTTP ${stats.status}`);
check((s?.calendar?.length ?? 0) === 30, `日历 ${s?.calendar?.length} 条（含没学的那几天）`);
check(s?.streak === 1, `连续天数 ${s?.streak}`);
check(s?.totalLearned === expectedNew, `已学 ${s?.totalLearned} 个不同的词（预期 ${expectedNew}）`);
// 正确率口径：服务端用**全时段** `correct/(correct+wrong)`（见 vocab-stats.service.ts），
// 本次运行是新用户，所以"全时段"恰好等于"今天"。这里按今天的日志反推，
// 能同时验证 correctCount/wrongCount 落库正确、且 accuracy 的除法没写错。
const dayLog = s?.calendar?.[29] ?? {};
const dayAnswered = (dayLog.correctCount ?? 0) + (dayLog.wrongCount ?? 0);
check(dayAnswered === answered, `日历今天的作答数 ${dayAnswered} 与提交次数一致`);
check(
  s?.accuracy === Math.round(((dayLog.correctCount ?? 0) / Math.max(dayAnswered, 1)) * 100),
  `正确率 ${s?.accuracy}%（今天 ${dayLog.correctCount} 对 / ${dayLog.wrongCount} 错）`,
);
check(dayLog.newCount === expectedNew, `日历最后一格（今天）新学 ${dayLog.newCount} 个词（预期 ${expectedNew}）`);
// 刚答完的词都排到"明天"，此刻应当零到期 —— 一次抓住间隔/到期日/时区三类错
check(s?.dueToday === 0, `此刻到期数 ${s?.dueToday}（新学的词明天才到期）`);

console.log('\n⑧ 发音 GET /vocab/words/:id/audio');
const audio = await call('GET', `/vocab/words/${card.wordId}/audio`, { token });
const au = audio.body?.data;
check(audio.status === 200, `HTTP ${audio.status}`);
check((au?.audioBase64?.length ?? 0) > 1000, `base64 ${au?.audioBase64?.length} 字符`);
check(['mp3', 'wav'].includes(au?.format), `格式 ${au?.format}`);
check(!String(au?.provider ?? '').startsWith('mock'), `provider=${au?.provider}（真实链路，非演示音频）`);
const again = await call('GET', `/vocab/words/${card.wordId}/audio`, { token });
check(again.body?.data?.cached === true, `同词同音色第二次命中缓存（provider=${again.body?.data?.provider}）`);

console.log('\n⑨ 未登录访问应被拒');
const noAuth = await call('GET', '/vocab/today');
check(noAuth.status === 401, `HTTP ${noAuth.status}`);

console.log(`\n${failures ? `❌ ${failures} 项未通过` : '✅ 全部通过'}\n`);
process.exit(failures ? 1 : 0);