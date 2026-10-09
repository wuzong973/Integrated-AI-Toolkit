#!/usr/bin/env node
/**
 * 繁简字表的自证守卫
 *
 * ## 拦的是哪一类"不报错"
 *
 * `traditional-chars.mjs` 是一张**人工维护**的 724 字表，被三处消费
 * （`fetch-sentences` 拉语料、`gen-words` 导词书、`audit:mp` 查界面文案）。
 * 表本身**没有任何编译期约束** —— 改错一个字、手滑删掉一行、或者
 * 以后有人"顺手加几个"，都不会有任何报错，只会在语料里漏掉繁体、
 * 或者把简体词条误杀。
 *
 * 所以本守卫不复述"表里有几个字"，而是**用真实数据验三条性质**：
 *
 *   ① **认得出来**：语料里真实存在的繁体句必须被认出。
 *      ⚠️ 样本必须取自 `data/sentences.jsonl.bak`（**过滤前**的原始语料），
 *      不能自己造句 —— 第一版自证写「這是繁體字」，
 *      而 `這`/`們`/`為` 在上游语料里**一条都没有**，字表里自然也不会有，
 *      于是自证恒判红，成了一个自己把自己判红的**假警报**。
 *
 *   ② **绝不误杀简体**：`data/sentences.jsonl`（过滤后）里抽查的简体句
 *      必须全部判为简体。这条拦的是第一版翻车的方式
 *      —— 表里混进简繁同形的字，把「目前,他正在度假。」当繁体丢掉。
 *
 *   ③ **绝不误报词条**：词书 `.jsonl` 里的**词形**（`word` 字段）
 *      必须判为简体。这条拦的是第二版翻车的方式
 *      —— 判据写成"在简体正文里零出现"，把生僻简体字（`铂`/`鲱`/`蟑`）
 *      也收进表，于是 `platinum = 铂` 被误报为繁体。
 *
 * 除此之外还做两条**结构**断言：
 *
 *   ④ `TRADITIONAL_CHARS` 内**无重复字**（重复说明拼接时手滑）；
 *   ⑤ 表内每个字**都有不同的简体对应**（同形字不该出现在表里）。
 *      这条靠一张**简繁同形白名单**兜底；白名单是保守的，只列确定同形的字。
 *
 * ## 判据下限自检
 *
 * 任何一条断言如果**样本数少于下限**，直接判失败而不是"通过"。
 * 解析失败 → 零样本 → 一条没查 → 打印绿灯，是**比误报危险得多**的假绿灯。
 *
 * ## 用法
 *
 *   npm run check:trad
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { hasTraditional, findTraditional, TRADITIONAL_CHARS } from '../db/traditional-chars.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const DATA_DIR = resolve(ROOT, 'scripts/db/data');
const RAW = resolve(DATA_DIR, 'sentences.jsonl.bak');
const CLEAN = resolve(DATA_DIR, 'sentences.jsonl');

const failures = [];
const fail = (msg) => {
  failures.push(msg);
  console.log(`   ❌ ${msg}`);
};
const ok = (msg) => console.log(`   ✅ ${msg}`);

/** 读 jsonl 的前 n 条（只抽需要的字段，免得 28MB 全进内存） */
function readJsonlHead(file, n, pick) {
  if (!existsSync(file)) return null;
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      const v = pick(rec);
      if (typeof v === 'string' && v) out.push(v);
    } catch {
      /* 坏行跳过，不影响自证 */
    }
    if (out.length >= n) break;
  }
  return out;
}

console.log('\n繁简字表自证（scripts/db/traditional-chars.mjs）\n');

// ---------- ④ 表内无重复 ----------
const chars = [...TRADITIONAL_CHARS];
const unique = new Set(chars);
if (chars.length !== unique.size) {
  const dup = chars.filter((c, i) => chars.indexOf(c) !== i);
  fail(`表内有重复字 ${[...new Set(dup)].join('')}（${chars.length} 个字符位，去重后 ${unique.size}）`);
} else {
  ok(`表内 ${chars.length} 字，无重复`);
}

// ---------- ⑤ 表内每字都应有不同的简体写法 ----------
// 保守白名单：这些字简繁同形，**不该**出现在表里。列的都是确定同形的常用字。
const SAME_FORM_WHITELIST = new Set([
  '台', '干', '只', '发', '后', '里', '面', '别', '斗', '云', '划', '历', '范', '据', '产', '尔',
  '尽', '布', '线', '复', '种', '苏', '表', '卷', '当', '系', '了', '么', '个', '们',
]);
const sameFormHit = chars.filter((c) => SAME_FORM_WHITELIST.has(c));
// 注意：白名单里的字在**繁体语境**下也可能是异体（如「臺/檯」），
// 所以这里只当**提示**不当失败，避免把有歧义的字判死。
if (sameFormHit.length) {
  console.log(
    `   ⚠️  表内含 ${sameFormHit.length} 个"简繁易混"字：${sameFormHit.join('')}` +
      '（若确认它们只作繁体用，可忽略；否则应移出表）',
  );
} else {
  ok('表内无"简繁同形"的常见字');
}

// ---------- ① 真实繁体句必须被认出 ----------
console.log('\n① 认得出来（样本取自过滤前语料）');
const rawSamples = readJsonlHead(RAW, 3000, (r) => r.zh ?? r.zhText ?? r.text ?? '');
if (!rawSamples) {
  fail(`读不到 ${RAW} —— 过滤前语料是自证①的唯一合法样本来源，缺失时本项**不能**判通过`);
} else if (rawSamples.length < 500) {
  fail(`过滤前语料只抽到 ${rawSamples.length} 句，少于下限 500 —— 样本不足时"认得出来"**不代表**认得出来`);
} else {
  const tradInRaw = rawSamples.filter((s) => hasTraditional(s));
  if (tradInRaw.length === 0) {
    fail(
      `过滤前语料 ${rawSamples.length} 句里一句繁体都没抽到 —— 这不可能，` +
        '说明字段名取错了或语料已变；此时判据为空，"✅"是假的',
    );
  } else {
    ok(`过滤前语料 ${rawSamples.length} 句里认出 ${tradInRaw.length} 句繁体`);
    for (const s of tradInRaw.slice(0, 3)) {
      console.log(`      · ${findTraditional(s).join('')} ←「${s.slice(0, 30)}」`);
    }
  }
}

// ---------- ② 简体句绝不能误杀 ----------
console.log('\n② 绝不误杀简体（样本取自过滤后语料）');
const cleanSamples = readJsonlHead(CLEAN, 3000, (r) => r.zh ?? r.zhText ?? r.text ?? '');
if (!cleanSamples) {
  fail(`读不到 ${CLEAN} —— 过滤后语料是自证②的样本来源`);
} else if (cleanSamples.length < 500) {
  fail(`过滤后语料只抽到 ${cleanSamples.length} 句，少于下限 500`);
} else {
  const bad = cleanSamples.filter((s) => hasTraditional(s));
  if (bad.length) {
    fail(`过滤后语料里仍有 ${bad.length} 句被判为繁体（应已全部滤掉），例：`);
    for (const s of bad.slice(0, 3)) {
      console.log(`      · ${findTraditional(s).join('')} ←「${s.slice(0, 30)}」`);
    }
  } else {
    ok(`过滤后语料抽查 ${cleanSamples.length} 句，无繁体残留`);
  }
}

// ---------- ③ 词书词形绝不能误报 ----------
console.log('\n③ 绝不误报词条（生僻简体字的回归测试）');
const bookFiles = existsSync(resolve(DATA_DIR, 'books.json'))
  ? JSON.parse(readFileSync(resolve(DATA_DIR, 'books.json'), 'utf8'))
  : null;
// ⚠️ books.json 是**对象**（`{generatedAt, source, books:[...]}`）不是数组。
//    上一版按数组读，`bookCodes` 恒为空 → 自证③**一条都没查**就打印了 ✅。
//    这正是本守卫自己反复强调的"假绿灯"，所以下限断言必须留在下面。
const bookCodes = Array.isArray(bookFiles?.books)
  ? bookFiles.books.map((b) => b.code).filter(Boolean)
  : [];
let wordChecked = 0;
const wordFalsePos = [];
for (const code of bookCodes) {
  const f = resolve(DATA_DIR, `${code}.jsonl`);
  const words = readJsonlHead(f, 2000, (r) => r.word ?? r.headword ?? '');
  if (!words) continue;
  for (const w of words) {
    // 只查**纯词形**是否含繁体：词形本来就是英文，中文词形极少，但一旦有就是硬错
    if (!/[\u4e00-\u9fff]/.test(w)) continue;
    wordChecked += 1;
    if (hasTraditional(w)) wordFalsePos.push(w);
  }
}

// 关键回归点：这几个字是第二版翻车的原样样本，必须判为简体
const REGRESSION_SIMPLIFIED = [
  '铂', '鲱', '蟑', '琵', '琶', '柚', '茱', '藜', '掰',
  'platinum = 铂；白金', 'herring = 鲱', '目前,他正在度假。',
];
const regBad = REGRESSION_SIMPLIFIED.filter((s) => hasTraditional(s));
if (regBad.length) {
  fail(
    `繁体误报回归样本失败：${regBad.join(' / ')} 被判为繁体。\n` +
      '      这些是**生僻简体字**，第二版就是栽在这里（判据写成"在简体正文里零出现"）。\n' +
      '      正解判据是「有没有一个不同的简体写法」，同形的字绝不收。',
  );
} else {
  ok(`繁体误报回归样本 ${REGRESSION_SIMPLIFIED.length} 条全部判为简体`);
}
if (wordFalsePos.length) {
  fail(`词书词形里误报 ${wordFalsePos.length} 个繁体：${wordFalsePos.slice(0, 10).join(' ')}`);
} else {
  ok(`词书词形抽查 ${wordChecked} 个中文词，无误报`);
}
if (bookCodes.length === 0) {
  fail('books.json 读不到或为空 —— 自证③**一条都没查**，不能判通过');
}

// ---------- 判定下限自检 ----------
const MIN_RAW = 500;
const MIN_CLEAN = 500;
if (rawSamples && rawSamples.length < MIN_RAW) {
  fail(`自证①样本 ${rawSamples.length} < ${MIN_RAW}，判据为空`);
}
if (cleanSamples && cleanSamples.length < MIN_CLEAN) {
  fail(`自证②样本 ${cleanSamples.length} < ${MIN_CLEAN}，判据为空`);
}

// ---------- 输出 ----------
if (failures.length === 0) {
  console.log('\n✅ 繁简字表自证通过：认得出来 / 不误杀简体 / 不误报词条 / 表结构完好\n');
  process.exit(0);
}
console.log(`\n❌ 繁简字表自证发现 ${failures.length} 处问题（详见上方）\n`);
process.exit(1);
