#!/usr/bin/env node
/**
 * 直拉完整词书 → `scripts/db/data/<code>.jsonl`
 *
 * ## 为什么从"只取词形"改成"直拉完整内容"
 *
 * 第一版只用了上游的**乱序 txt**（`单词\t释义`，仅词形），释义/音标/例句全靠 LLM 生成 ——
 * 代价是每批 4 词、20~32s，**三万词要跑十几小时**。
 *
 * 后来发现同一个仓库还有 `full_line_jsonl/sentence/正序/<词书>.jsonl`，
 * **已经带美/英音标、释义、词组搭配、例句**（实测四级 7508 词：
 * 音标 98% / 释义 100% / 例句 97% / 词组 83%）。这就把"十几小时"变成"几分钟"。
 *
 * ## 但仍然**逐条校验**，不因为是"成品"就直接入库
 *
 * 上游是社区维护的词典，脏数据（`word` 是短语、释义混进乱码、
 * 例句没有中文）确实存在。校验不过的条目**丢弃并计数**，
 * 而不是"反正有释义就写进去"—— 那些脏数据会直接变成用户看到的题面。
 *
 * ## 失败必须看得见
 *
 * 单本词书下载失败会**抛错退出**（除非 `--keep-going`）。静默跳过的后果是
 * "这本词书只有一半的词"，而没有任何人会知道 —— 那正是本项目反复踩过的那类坑。
 *
 * ## 用法
 *
 *   npm run db:fetch-words                    # 拉取全部词书
 *   npm run db:fetch-words -- --book cet4     # 只拉一本
 *   npm run db:fetch-words -- --list          # 只列出可拉取的词书清单
 *   npm run db:fetch-words -- --force         # 忽略本地缓存重新下载
 *   npm run db:fetch-words -- --dry-run       # 只统计，不写文件
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const DATA_DIR = resolve(ROOT, 'scripts/db/data');
const CACHE_DIR = resolve(ROOT, 'scripts/db/.cache/books');

/**
 * 词书定义。
 *
 * - `code`   前后端与脚本对齐的唯一标识（不要用 name 对齐）
 * - `remote` 上游文件名（`full_line_jsonl/sentence/正序/<remote>.jsonl`）
 * - `category` 界面分组用：exam 考试 / school 教材 / abroad 出国 / career 职业 / foundation 基础
 * - `level`  同族排序（越小越基础）
 */
const BOOKS = [
  // ---------- 教材（⚠️ 只保留两本北师大版）----------
  //
  // 2026-09-21 精简：小学（primary3~6）、初中（junior / junior7~9）、
  // 高中（highschool / highschool_rj）共 10 本**已下线**，只留
  // `junior_bnu` 与 `highschool_bs`。理由是这两本是唯一被实际使用的学段词书，
  // 其余学段留着只让选书列表变长、并让"我该选哪本"变成一道无谓的选择题。
  //
  // ⚠️ **删词书不能只删这一处**：`word_book` / `word_book_word` /
  // `user_word_progress` / `user_study_log` 里的行也要清（见
  // `scripts/db/prune-books.mjs`）。只在 BOOKS 里删掉的话，数据库里那 10 本
  // 会**继续出现在小程序上**（因为界面读的是数据库，不是这个文件），
  // 而词库守卫又会因为"清单里没有它"而报错 —— 两头都对不上，没有一行提示。
  { code: 'junior_bnu', name: '初中词汇（北师大）', category: 'school', level: -1, remote: '外研社初中', desc: '外研社版初中英语课本词汇' },
  { code: 'highschool_bs', name: '高中词汇（北师大）', category: 'school', level: 0, remote: '北师高中', desc: '北师大版高中英语课本词汇' },

  // ---------- 考试 ----------
  { code: 'cet4', name: '四级核心词汇', category: 'exam', level: 1, remote: '四级', desc: '全国大学英语四级考试大纲词表' },
  { code: 'cet6', name: '六级核心词汇', category: 'exam', level: 2, remote: '六级', desc: '全国大学英语六级考试大纲词表' },
  { code: 'tem4', name: '英语专业四级词汇', category: 'exam', level: 3, remote: '专四', desc: '英语专业四级考试（TEM-4）词表' },
  { code: 'tem8', name: '英语专业八级词汇', category: 'exam', level: 4, remote: '专八', desc: '英语专业八级考试（TEM-8）词表' },
  { code: 'kaoyan', name: '考研核心词汇', category: 'exam', level: 3, remote: '考研', desc: '硕士研究生入学考试英语（一/二）词表' },

  // ---------- 出国 ----------
  { code: 'ielts', name: '雅思核心词汇', category: 'abroad', level: 5, remote: '雅思', desc: 'IELTS 学术/培训类高频词' },
  { code: 'toefl', name: '托福核心词汇', category: 'abroad', level: 5, remote: '托福', desc: 'TOEFL iBT 学术场景高频词' },
  { code: 'sat', name: 'SAT 核心词汇', category: 'abroad', level: 6, remote: 'SAT', desc: 'SAT 阅读理解高频词' },
  { code: 'gre', name: 'GRE 核心词汇', category: 'abroad', level: 7, remote: 'GRE', desc: 'GRE 填空与阅读高频词' },
  { code: 'gmat', name: 'GMAT 核心词汇', category: 'abroad', level: 7, remote: 'GMAT', desc: 'GMAT 逻辑与阅读高频词' },

  // ---------- 职业 ----------
  { code: 'business', name: '商务英语词汇', category: 'career', level: 4, remote: '商务英语', desc: '职场与商务场景常用词' },
];

/** 上游 raw 地址。⚠️ `raw.githubusercontent.com` 在本机常被断流，优先走镜像（见下） */
const RAW = (remote) =>
  `https://raw.githubusercontent.com/KyleBing/english-vocabulary/master/full_line_jsonl/sentence/${encodeURIComponent('正序')}/${encodeURIComponent(remote)}.jsonl`;

/**
 * 镜像前缀。项目记忆里记着"GitHub release 直连常断 → 用 ghproxy.net"，
 * 这里沿用同一策略：**依次尝试，第一个拿到完整文件的即用**。
 * 直连放在最后 —— 它最快，但最容易在中途被掐断（表现为"文件只有几十 KB"）。
 */
const MIRRORS = [(u) => u, (u) => `https://ghproxy.net/${u}`, (u) => `https://gh-proxy.com/${u}`];

/** 一份文件至少要多大才认为"下全了"。最小的词书（小学三年级）约 160KB */
const MIN_BYTES = 100 * 1024;

function parseArgs(argv) {
  const out = {
    books: [],
    dryRun: false,
    force: false,
    keepGoing: false,
    list: false,
    manifestOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--keep-going') out.keepGoing = true;
    else if (a === '--list') out.list = true;
    else if (a === '--manifest-only') out.manifestOnly = true;
    else if (a === '--book') out.books.push(String(argv[(i += 1)]));
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

/* ==================== 校验（不通过就丢，绝不凑数） ==================== */

/**
 * 词形校验。
 *
 * ⚠️ 上游 `word` 字段里混着**短语**（`have access to`）、**带标点的**、甚至**中文**。
 * 这些一旦入库：拼写题没法出（答案是空格）、四选一会出现"选一个词组"。
 * 所以只在**纯英文单词**（允许词内连字符/撇号）时保留。
 */
const WORD_RE = /^[a-z]+(?:[-'’][a-z]+)*$/;

function cleanWord(raw) {
  const w = String(raw ?? '')
    .replace(/[\uFEFF\u200B-\u200D]/g, '')
    .trim()
    .toLowerCase();
  if (!w || w.length > 30) return null;
  if (!WORD_RE.test(w)) return null;
  // 全大写缩写（`CCTV`）不是要背的词
  if (String(raw).trim() === String(raw).trim().toUpperCase() && w.length > 1) return null;
  return w;
}

/** 音标：去掉斜杠与首尾空白；`tɔk` 与 `/tɔk/` 两种写法都收 */
function cleanPhonetic(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim().replace(/^\/+|\/+$/g, '').trim();
  return s.length > 60 ? s.slice(0, 60) : s;
}

/** 词性：上游是 `v` / `adj` / `n`，补上点号与 `@qz/core` 的 POS 口径对齐 */
const POS_OK = /^(n|v|adj|adv|prep|conj|pron|num|art|int|vt|vi|aux)$/i;
function cleanPos(raw) {
  const p = String(raw ?? '').trim().replace(/\.$/, '');
  return POS_OK.test(p) ? `${p.toLowerCase()}.` : '';
}

/** 释义数组（上游 `translations`）→ 本项目的 `senses` 结构 */
function cleanSenses(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const meaning = String(item?.translation ?? '').trim();
    if (!meaning) continue;
    // 释义里的换行/多余空白会破坏选项文本的排版
    out.push({ pos: cleanPos(item?.type), meaning: meaning.replace(/\s+/g, ' ').slice(0, 120) });
  }
  return out.slice(0, 6);
}

/** 单条例句校验：中英双全、都不超长、英有字母、中有汉字 —— 通过则返回归一后的对象 */
function cleanExample(item) {
  const en = String(item?.sentence ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  const zh = String(item?.translation ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!en || !zh) return null;
  if (!/[a-zA-Z]/.test(en) || !/[\u4e00-\u9fa5]/.test(zh)) return null;
  if (en.length > 200 || zh.length > 200) return null;
  return { en, zh };
}

/** 例句（上游 `sentences`）→ `examples`。**中英双全才收**（只有英文对学习者没价值） */
function cleanExamples(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const one = cleanExample(item);
    if (one) out.push(one);
  }
  return out.slice(0, 3);
}

/** 单个词组校验：英中双全、不超长、词组必须是英文、不能是标点堆 —— 通过则返回归一对象 */
function cleanPhrase(item) {
  const phrase = String(item?.phrase ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  const zh = String(item?.translation ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!phrase || !zh || phrase.length > 80 || zh.length > 120) return null;
  if (!/^[a-zA-Z][a-zA-Z\s'’\-.,()/]*$/.test(phrase)) return null;
  return { phrase, zh };
}

/** 词组搭配（上游 `phrases`）→ `phrases`。这是"不背单词"式的内容支柱之一 */
function cleanPhrases(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const one = cleanPhrase(item);
    if (!one || seen.has(one.phrase)) continue;
    seen.add(one.phrase);
    out.push(one);
  }
  return out.slice(0, 8);
}

/**
 * 难度 1-5。
 *
 * 上游**不给难度**，所以这里按一个可解释的规则推：
 * 年级/考试级别越高的词书，基线越高；再用"词长 + 义项数 + 是否有多义"微调。
 * ⚠️ 它只影响"今日新学的取词顺序"与"四选一的干扰项窗口"，
 * 不参与正确性判定，所以用启发式是安全的（不会悄悄判错题）。
 */
function deriveDifficulty(level, word, senseCount) {
  const base = level <= -2 ? 1 : level <= 0 ? 2 : level <= 2 ? 3 : level <= 4 ? 4 : 5;
  let d = base;
  if (word.length >= 11) d += 1;
  else if (word.length <= 4) d -= 1;
  if (senseCount >= 4) d += 1;
  return Math.max(1, Math.min(5, d));
}

/** 一条上游记录 → 本项目词条，或 `{ reason }` 说明为什么丢掉 */
function convert(raw, level) {
  const spelling = cleanWord(raw?.word);
  if (!spelling) return { reason: `词形不合规：${String(raw?.word ?? '').slice(0, 30)}` };
  const senses = cleanSenses(raw?.translations);
  if (!senses.length) return { reason: `${spelling}: 没有可用的释义` };
  return {
    value: {
      spelling,
      // 上游字段是 `us` / `uk`，本项目存"美音优先"，英音另存一列
      phonetic: cleanPhonetic(raw?.us) || cleanPhonetic(raw?.uk),
      ukPhonetic: cleanPhonetic(raw?.uk),
      senses,
      examples: cleanExamples(raw?.sentences),
      phrases: cleanPhrases(raw?.phrases),
      difficulty: deriveDifficulty(level, spelling, senses.length),
    },
  };
}

/* ==================== 下载 ==================== */

function cachePath(book) {
  return resolve(CACHE_DIR, `${book.code}.jsonl`);
}

/** 依次试各镜像，返回**第一个下全了的**内容 */
async function download(book) {
  const url = RAW(book.remote);
  const errors = [];
  for (const wrap of MIRRORS) {
    const target = wrap(url);
    try {
      process.stdout.write(`   · 下载 ${book.remote} … `);
      const res = await fetch(target, { signal: AbortSignal.timeout(90_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length < MIN_BYTES) throw new Error(`只拿到 ${text.length} 字节（疑似被截断）`);
      const lines = text.split('\n').filter((l) => l.trim()).length;
      console.log(`${(text.length / 1024 / 1024).toFixed(1)}MB / ${lines} 行`);
      return text;
    } catch (err) {
      console.log(`失败（${err.message}），换下一个源`);
      errors.push(`${target.slice(0, 50)}…: ${err.message}`);
    }
  }
  throw new Error(`所有源都失败：\n     ${errors.join('\n     ')}`);
}

/** 取一份词书内容（优先本地缓存） */
async function loadBook(book, force) {
  const cached = cachePath(book);
  if (!force && existsSync(cached) && readFileSync(cached).length >= MIN_BYTES) {
    console.log(`   · 用本地缓存 ${book.code}.jsonl`);
    return readFileSync(cached, 'utf8');
  }
  const text = await download(book);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cached, text, 'utf8');
  return text;
}

/* ==================== 主流程 ==================== */

async function runBook(book, args) {
  const text = await loadBook(book, args.force);
  const good = [];
  const bad = [];
  const seen = new Set();
  let dup = 0;
  let raw = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    raw += 1;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      bad.push('JSON 解析失败');
      continue;
    }
    const res = convert(parsed, book.level);
    if (!res.value) {
      bad.push(res.reason);
      continue;
    }
    // 同一本书内去重（上游偶有重复行）
    if (seen.has(res.value.spelling)) {
      dup += 1;
      continue;
    }
    seen.add(res.value.spelling);
    good.push(res.value);
  }

  if (bad.length) {
    console.log(`   ⚠️ ${bad.length} 条未通过：${bad.slice(0, 3).join(' / ')}${bad.length > 3 ? ' …' : ''}`);
  }
  if (dup) console.log(`   （书内重复 ${dup} 条，已去重）`);

  const coverage = {
    phonetic: good.filter((w) => w.phonetic).length,
    examples: good.filter((w) => w.examples.length).length,
    phrases: good.filter((w) => w.phrases.length).length,
  };
  return { book, words: good, raw, bad: bad.length, dup, coverage };
}

/**
 * 写盘：**JSONL**（一行一条），不是纯词形 txt。
 *
 * 改成 JSONL 是因为现在每条词带有 音标/释义/例句/词组 —— 用 txt 就得自定义分隔符，
 * 而释义与例句里含制表符、竖线、引号都是常事（自造格式必然有一天被某个字符打破）。
 * JSON 每行独立解析，脏一行只坏一行。
 *
 * ⚠️ **文件里带 `source` 与 `fetchedAt`**：将来要追"这条释义是哪来的"时靠它。
 */
function renderJsonl(book, words) {
  const fetchedAt = new Date().toISOString().slice(0, 10);
  return words
    .map((w) =>
      JSON.stringify({
        spelling: w.spelling,
        phonetic: w.phonetic,
        ukPhonetic: w.ukPhonetic,
        senses: w.senses,
        examples: w.examples,
        phrases: w.phrases,
        difficulty: w.difficulty,
        source: 'curated',
        book: book.code,
        fetchedAt,
      }),
    )
    .join('\n')
    .concat('\n');
}

/**
 * 只读本地 `<code>.jsonl`，不下载 —— 供 `--manifest-only` 用。
 *
 * ⚠️ **不加"文件不存在就当成 0 词"的兜底**：那会让清单里出现
 * `wordCount: 0` 的词书，而 `gen-words` 读到 0 会直接把书建成"建设中"。
 * 少了文件就必须**立刻报错**，并指出该跑哪条命令。
 */
function readLocalJsonl(book) {
  const p = resolve(DATA_DIR, `${book.code}.jsonl`);
  if (!existsSync(p)) {
    throw new Error(
      `词书数据不存在：${p}\n  先跑 npm run db:fetch-words -- --book ${book.code}`,
    );
  }
  let n = 0;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (line.trim()) n += 1;
  }
  return new Array(n).fill(null);
}

/** 词书清单（写进 books.json，供 gen-words 与守卫读取，避免三处各写一份） */
function renderManifest(rows) {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: 'KyleBing/english-vocabulary · full_line_jsonl/sentence/正序',
      note: '本清单由 scripts/db/fetch-wordlists.mjs 生成；gen-words.mjs 与 check-vocab-books 都读它',
      books: rows.map((r) => ({
        code: r.book.code,
        name: r.book.name,
        desc: r.book.desc,
        category: r.book.category,
        level: r.book.level,
        wordCount: r.words.length,
      })),
    },
    null,
    2,
  ).concat('\n');
}

/** `--list`：只列出可拉取的词书 */
function printList() {
  console.log('\n可拉取的词书：\n');
  for (const b of BOOKS) {
    console.log(
      `  ${b.code.padEnd(14)} L${String(b.level).padStart(3)}  ${b.category.padEnd(10)} ${b.name}`,
    );
  }
  console.log(`\n共 ${BOOKS.length} 本\n`);
}

/** 单本词书的结果一行（含各项覆盖率） */
function printBookResult(r, dryRun, book) {
  const c = r.coverage;
  const pct = (n) => `${Math.round((n / Math.max(1, r.words.length)) * 100)}%`;
  console.log(
    `   ✅ ${r.words.length} 词（原始 ${r.raw}，丢弃 ${r.bad}）· 音标 ${pct(c.phonetic)} · 例句 ${pct(c.examples)} · 词组 ${pct(c.phrases)}`,
  );
  if (!dryRun) {
    writeFileSync(resolve(DATA_DIR, `${book.code}.jsonl`), renderJsonl(book, r.words), 'utf8');
  }
  console.log('');
}

/**
 * 汇总。
 *
 * ⚠️ **总量与去重后总量是两个数**：一个词可同属多本词书（`word_book_word` 是关联表），
 * 所以"词条总数"要按 spelling 去重后再报，否则会重复计数（曾把 3 万词报成 5 万）。
 */
function printSummary(rows, dryRun) {
  const allSpellings = new Set();
  for (const r of rows) for (const w of r.words) allSpellings.add(w.spelling);

  console.log('合计：');
  for (const r of rows) {
    console.log(`   ${r.book.code.padEnd(14)} ${String(r.words.length).padStart(6)} 词`);
  }
  const total = rows.reduce((a, r) => a + r.words.length, 0);
  console.log(`   ${'词条总量'.padEnd(12)} ${String(total).padStart(6)}（含跨词书重复）`);
  console.log(`   ${'去重后'.padEnd(13)} ${String(allSpellings.size).padStart(6)} 个不同单词\n`);

  if (!dryRun) {
    writeFileSync(resolve(DATA_DIR, 'books.json'), renderManifest(rows), 'utf8');
    console.log(`✅ 已写入 scripts/db/data/（${rows.length} 本 + books.json 清单）\n`);
  }
}

/**
 * `--manifest-only`：只按 BOOKS 重写 books.json，不下载、不碰 jsonl。
 *
 * 用途是**下线词书**：BOOKS 里删掉几本之后，清单（与守卫读的"应有词书"）
 * 必须跟着变小，但把没删的那几本重新下载一遍是纯浪费（尤其是 tem8 那种大书）。
 *
 * ⚠️ 它**只改清单，不动数据库** —— 库里多出来的那几本要靠
 *    `node scripts/db/prune-books.mjs --apply` 清（否则小程序仍会显示它们）。
 */
function writeManifestOnly() {
  const rows = BOOKS.map((b) => ({ book: b, words: readLocalJsonl(b) }));
  writeFileSync(resolve(DATA_DIR, 'books.json'), renderManifest(rows), 'utf8');
  console.log(`\n✅ 已按 BOOKS 重写 books.json（${rows.length} 本）：`);
  for (const r of rows) {
    console.log(`  ${r.book.code.padEnd(14)} ${r.book.name}（${r.words.length} 词）`);
  }
  console.log('\n⚠️ 下一步：node scripts/db/prune-books.mjs --apply（清库里已下线的词书）\n');
}

/**
 * 逐本拉取（串行）。
 *
 * ⚠️ **串行而不是 `Promise.all`**：这些书都从同一个源站下载，
 * 并发只会撞限流；而且串行能让"第几本失败"直接体现在日志顺序里。
 * 单本失败时按 `--keep-going` 决定继续还是立刻抛（默认抛 —— 一个静默缺书的
 * 词库比一次失败的运行难查得多）。
 */
async function fetchAll(books, args) {
  const rows = [];
  const failures = [];
  for (const book of books) {
    console.log(`=== ${book.name}（${book.code}）===`);
    try {
      const r = await runBook(book, args);
      rows.push(r);
      printBookResult(r, args.dryRun, book);
    } catch (err) {
      failures.push(`${book.code}: ${err.message}`);
      console.log(`   ❌ ${err.message}\n`);
      if (!args.keepGoing) throw err;
    }
  }
  return { rows, failures };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    printList();
    return;
  }
  if (args.manifestOnly) {
    writeManifestOnly();
    return;
  }

  const books = BOOKS.filter((b) => !args.books.length || args.books.includes(b.code));
  if (!books.length) throw new Error(`--book 只能取：\n  ${BOOKS.map((b) => b.code).join(' / ')}`);

  mkdirSync(DATA_DIR, { recursive: true });
  console.log(`\n词书 ${books.length} 本${args.dryRun ? '（dry-run）' : ''}\n`);

  const { rows, failures } = await fetchAll(books, args);
  if (!rows.length) throw new Error('一本词书都没拉到');
  printSummary(rows, args.dryRun);

  if (failures.length) {
    console.error(
      `⚠️ ${failures.length} 本失败 —— 词库会缺书，请重跑（已下好的走本地缓存，不会重复下载）`,
    );
    process.exitCode = 1;
  }
}

await main();
