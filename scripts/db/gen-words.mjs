#!/usr/bin/env node
/**
 * 把 `scripts/db/data/*.jsonl` 导入数据库（记单词 · 第 2 步）
 *
 * ## 从"LLM 生成"改成"直接导入"的原因
 *
 * 这个脚本原本是"读纯词形 txt → 调 LLM 补音标/释义/例句 → 落库"。
 * 那条路每批 4 词、20~32s，**两万多词要跑十几个小时**。
 *
 * 后来发现上游仓库的 `full_line_jsonl/sentence/正序/` **本身就带
 * 美/英音标、释义、词组搭配、例句** —— 内容已经是现成的，
 * 再让 LLM 重新生成一遍，等于花十几个小时把已有的东西再编一遍
 * （而且 LLM 产出还会漂移、会编造词源）。
 *
 * 所以现在这个脚本**只做三件事**：读清单 → 读 JSONL → 写库。
 * **它不联网、不调 LLM、没有 `.env` 依赖**，几十秒跑完。
 *
 * ## 词书定义的唯一来源是 `books.json`
 *
 * 词书曾在**三处**各写一份（本脚本的 BOOKS / fetch-wordlists 的 BOOKS / data 文件名），
 * 任何一处单独改都会静默出错。现在改成：`fetch-wordlists.mjs` 生成
 * `data/books.json`，**本脚本与 `check-vocab-books` 都读它** ——
 * 定义只有一份，drift 在结构上就不可能发生。
 *
 * ## 失败必须看得见
 *
 * 某本词书的 jsonl 缺失或为空 → **报错退出**（除非 `--keep-going`）。
 * 静默跳过的后果是"这本词书只有一半的词"，而没有任何人会知道 ——
 * 那正是本项目反复踩过的那类坑。
 *
 * ## 可重跑
 *
 * 词条与关联都用 `upsert`：重复跑不会插重复行，也不会覆盖用户进度
 * （`UserWordProgress` 是另一张表，本脚本完全不动它）。
 * 每次跑完会按实际关联数**回写 `wordCount`**，
 * 并把有词的词书置为 `active`、空词书留在 `planned`（界面才敢说"建设中"）。
 *
 * ## 用法
 *
 *   npm run db:gen-words                        # 导入全部词书
 *   npm run db:gen-words -- --book cet4         # 只导一本
 *   npm run db:gen-words -- --dry-run           # 只统计，不写库
 *   npm run db:gen-words -- --keep-going        # 单本失败不中断
 *   npm run db:gen-words -- --prune-traditional # 只清理库中已有的繁体中文（不导入）
 *
 * ## 前置
 *
 *   MySQL 可连（走 Prisma，与后端同一份 `DATABASE_URL`）。
 *   ⚠️ 不需要 LLM 凭据 —— 本脚本不联网。
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// 繁体字表与句子语料**共用同一张**（判据见该文件头）——
// 两处各写一份必然漂移，而漂移只表现为"某一处的繁体又漏出来了"，不报错
import { hasTraditional, findTraditional } from './traditional-chars.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const require = createRequire(resolve(ROOT, 'apps/api/package.json'));
const { PrismaClient } = require('@prisma/client');

const DATA_DIR = resolve(ROOT, 'scripts/db/data');
const MANIFEST = resolve(DATA_DIR, 'books.json');

/** 每批写多少个词条（批量事务，减少往返；太大则单次事务过久） */
const BATCH = 200;

function parseArgs(argv) {
  const out = { books: [], dryRun: false, keepGoing: false, pruneTraditional: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--keep-going') out.keepGoing = true;
    else if (a === '--prune-traditional') out.pruneTraditional = true;
    else if (a === '--book') out.books.push(String(argv[(i += 1)]));
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

/**
 * 清掉库里**已经存在**的繁体内容（释义 / 例句中译 / 词组中译）。
 *
 * ## 为什么必须单独一趟
 *
 * `stripTraditional()` 只作用于**本次要写入的记录**，而本脚本对已存在的词条
 * （按 `spelling` 唯一）走 `update` 时会**覆盖**对应字段 —— 看起来"重跑就好"。
 * 但有两个口子：
 *
 *   ① `--book` 只导一本时，**没被指定那几本根本不会被读到**，
 *      它们里面的繁体原封不动；
 *   ② 前端拿到的可能是**缓存过**的结果，重跑完不重灌则看不到变化。
 *
 * 实测（2026-09-21）在完整重灌之后，库里仍剩下 3 条：
 * `真核細胞`（词组）/ `悠閒的日光浴`（例句）/ `結合蛋白`（词组）——
 * 说明"重跑导入"不等于"库是干净的"，必须有一步**以库为对象**的清理，
 * 且它的判据要与筛语料、查界面文案**同一张表**。
 */
/** 留下「该字段不含繁体」的那些项 */
function withoutTraditional(list, field) {
  return (Array.isArray(list) ? list : []).filter((x) => !hasTraditional(x?.[field] || ''));
}

/**
 * 把一条词条的三个中文数组各自分成「含繁体的」与「干净的」两拨。
 *
 * 抽成纯函数有两个理由：① `pruneTraditional` 的圈复杂度顶到上限了；
 * ② 这里的"哪个字段用哪种判据"与 `stripTraditional()`（导入时用）是**同一个判断**，
 * 放在一处才不会出现"导入时剔了、清理时漏了某个字段"。
 *
 * 返回 `all`（原始三个数组）与筛出的 `bad` —— 前者用于"整体覆盖"时保留好数据，
 * 后者用于报告。**两者都要**：只给 bad 会导致 update 把好数据一起冲掉。
 */
function splitByTraditional(row) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const senses = arr(row.senses);
  const examples = arr(row.examples);
  const phrases = arr(row.phrases);
  const badOf = (list, field) => list.filter((x) => hasTraditional(x?.[field] || ''));
  const badSenses = badOf(senses, 'meaning');
  const badExamples = badOf(examples, 'zh');
  const badPhrases = badOf(phrases, 'zh');
  return {
    id: row.id,
    spelling: row.spelling,
    all: { senses, examples, phrases },
    senses: badSenses,
    examples: badExamples,
    phrases: badPhrases,
    chars: [
      ...badSenses.flatMap((x) => findTraditional(x.meaning)),
      ...badExamples.flatMap((x) => findTraditional(x.zh)),
      ...badPhrases.flatMap((x) => findTraditional(x.zh)),
    ],
    count: badSenses.length + badExamples.length + badPhrases.length,
  };
}

async function pruneTraditional(prisma, dryRun) {
  const rows = await prisma.word.findMany({
    select: { id: true, spelling: true, senses: true, examples: true, phrases: true },
  });
  const hits = rows.map(splitByTraditional).filter((h) => h.count > 0);
  const chars = new Set(hits.flatMap((h) => h.chars));

  console.log(`\n【清理繁体·词库】词条 ${rows.length} 条，受影响 ${hits.length} 条`);
  if (!hits.length) {
    console.log('   ✅ 无需清理\n');
    return;
  }
  console.log(`   涉及 ${chars.size} 个繁体字：${[...chars].join('')}`);
  console.log('   样例：');
  for (const h of hits.slice(0, 8)) {
    const sample = h.senses[0]?.meaning ?? h.examples[0]?.zh ?? h.phrases[0]?.zh ?? '';
    console.log(`     · ${h.spelling} →「${sample}」`);
  }

  if (dryRun) {
    console.log('\n   （dry-run，未写库）\n');
    return;
  }

  // 按字段剔除而不是删整个词条 —— 词条本身是好的（`eukaryotic` 是好词），
  // 只有中译带繁体。删词条会连带删掉 WordBookWord 关联与用户进度。
  //
  // ⚠️ 每个字段是**整列覆盖**（JSON 列不做深合并），所以要传"原数组剔掉坏项"
  //    的完整结果，而不是只传坏项、也不是传空数组。
  for (const h of hits) {
    await prisma.word.update({
      where: { id: h.id },
      data: {
        senses: withoutTraditional(h.all.senses, 'meaning'),
        examples: withoutTraditional(h.all.examples, 'zh'),
        phrases: withoutTraditional(h.all.phrases, 'zh'),
      },
    });
  }
  console.log(`\n   ✅ 已清理 ${hits.length} 条（按字段剔除，未删词条）\n`);
}

/** 读 books.json 清单 —— 词书定义的唯一来源 */
function loadManifest() {
  if (!existsSync(MANIFEST)) {
    throw new Error(
      `词书清单不存在：${MANIFEST}\n   请先跑 npm run db:fetch-words 生成词书数据`,
    );
  }
  const parsed = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  if (!Array.isArray(parsed?.books) || !parsed.books.length) {
    throw new Error(`${MANIFEST} 里没有 books 数组或为空`);
  }
  for (const b of parsed.books) {
    if (!b.code || !b.name || typeof b.level !== 'number') {
      throw new Error(`清单条目缺字段（需要 code/name/level）：${JSON.stringify(b)}`);
    }
  }
  return parsed.books;
}

/** 一本词书的 jsonl 路径 */
const dataPath = (code) => resolve(DATA_DIR, `${code}.jsonl`);

/**
 * 读一本词书的 JSONL。
 *
 * **一行解析失败只坏一行**（这正是当初从 txt 换成 JSONL 的原因）——
 * 解析不了的条目计入 `bad` 而**不中断**，因为上游是社区维护的词典，
 * 偶发脏行不该让整本书导不进去。
 */
function loadWords(code) {
  const p = dataPath(code);
  if (!existsSync(p)) throw new Error(`词书数据不存在：${p}（先跑 npm run db:fetch-words）`);
  const total = [];
  let bad = 0;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    if (!rec?.spelling || typeof rec.spelling !== 'string') {
      bad += 1;
      continue;
    }
    total.push(rec);
  }
  if (!total.length) throw new Error(`${p} 里一个词条都没有（词书会以"建设中"建出来）`);
  return { words: total, bad };
}

/**
 * 剔除**中文字段**里的繁体内容。
 *
 * ## ⚠️ 为什么是"剔除而不是丢掉整个词条"
 *
 * 上游是社区维护的词典，混进来的繁体只在**中译**里（`悠閒的日光浴`、
 * `結合蛋白`、`真核細胞`），而**英文词条本身是好的** ——
 * 因为一条例句的中译有繁体就把 `binding` 整个词删掉，代价远大于收益。
 *
 * 所以按字段处理：
 *   · `senses[].meaning` 有繁体 → 该释义整个丢掉（宁可少一条释义，也不要给繁体）
 *   · `examples[]` / `phrases[]` 的中文有繁体 → 丢掉那一条
 *   · `spelling` / `phonetic` 不动（它们不含中文）
 *
 * ## ⚠️ 没有过滤时是什么样
 *
 * 这个过滤是**后补的**。在此之前 `gen-words` 完全没有繁简检查，
 * 上游 116,953 条里的 87 条繁体一路带进了数据库 ——
 * 用户在「记单词」的词组/例句里看到 `真核細胞`，而**没有任何报错**。
 * 判据与字表见 `traditional-chars.mjs`（与句子语料**共用同一张表**）。
 */
function stripTraditional(rec) {
  const stat = { meaning: 0, example: 0, phrase: 0 };
  const senses = optArr(rec.senses).filter((s) => {
    if (s && typeof s.meaning === 'string' && hasTraditional(s.meaning)) {
      stat.meaning += 1;
      return false;
    }
    return true;
  });
  const examples = optArr(rec.examples).filter((e) => {
    if (e && typeof e.zh === 'string' && hasTraditional(e.zh)) {
      stat.example += 1;
      return false;
    }
    return true;
  });
  const phrases = optArr(rec.phrases).filter((f) => {
    if (f && typeof f.zh === 'string' && hasTraditional(f.zh)) {
      stat.phrase += 1;
      return false;
    }
    return true;
  });
  return { rec: { ...rec, senses, examples, phrases }, stat };
}

/** 可选文本：非空字符串才保留，否则 null（Json 列里塞空串不如不塞） */
const optText = (v) => (typeof v === 'string' && v ? v : null);

/** 可选数组：不是数组就退化成空数组（读侧 `toSenses` 也会二次过滤） */
const optArr = (v) => (Array.isArray(v) ? v : []);

/** 难度必须落在 1-5，越界退回 3（默认值，不是"猜一个"） */
const normDifficulty = (v) => (Number.isInteger(v) && v >= 1 && v <= 5 ? v : 3);

/**
 * 一条 JSONL 记录 → 落库字段。
 *
 * 只取**白名单字段**，不整条 `...rec` 展开 —— 上游可能新增我们没预期的键，
 * 无脑展开会把它们塞进 Json 列（下次读出来形状就变了）。
 */
function toRow(rec) {
  return {
    spelling: rec.spelling,
    phonetic: optText(rec.phonetic),
    ukPhonetic: optText(rec.ukPhonetic),
    senses: optArr(rec.senses),
    examples: optArr(rec.examples),
    phrases: optArr(rec.phrases),
    difficulty: normDifficulty(rec.difficulty),
    // ⚠️ 上游是**人工整理的词典数据**，不是 LLM 产出 —— 如实标 curated。
    // 标成 llm 会让"内容可信度"这条判断整个失真。
    source: 'curated',
  };
}

/** 建/更新词书本体（此时还不知道词数，先不碰 wordCount） */
async function ensureBook(prisma, book) {
  return prisma.wordBook.upsert({
    where: { code: book.code },
    update: {
      name: book.name,
      desc: book.desc ?? null,
      category: book.category ?? 'exam',
      level: book.level,
    },
    create: {
      code: book.code,
      name: book.name,
      desc: book.desc ?? null,
      category: book.category ?? 'exam',
      level: book.level,
      status: 'planned',
    },
  });
}

/**
 * 写一批词条 + 词书关联。
 *
 * `seq` 用**词书内的行号**（JSONL 的顺序是上游的字母序，稳定），
 * 这样"今日新学"的取词顺序可复现，而不是依赖数据库返回顺序。
 */
async function persistBatch(prisma, bookId, rows, offset) {
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const word = await prisma.word.upsert({
      where: { spelling: row.spelling },
      update: {
        phonetic: row.phonetic,
        ukPhonetic: row.ukPhonetic,
        senses: row.senses,
        examples: row.examples,
        phrases: row.phrases,
        difficulty: row.difficulty,
        source: row.source,
      },
      create: row,
    });
    await prisma.wordBookWord.upsert({
      where: { bookId_wordId: { bookId, wordId: word.id } },
      update: { seq: offset + i },
      create: { bookId, wordId: word.id, seq: offset + i },
    });
  }
}

/**
 * 回写词条数，并据此定 `status`。
 *
 * ⚠️ 口径是**实际关联数**（`wordBookWord.count`），不是 jsonl 的行数 ——
 * 两者在"词条已存在但关联没建"时有差异，而界面看的是关联。
 */
async function refreshBookCount(prisma, bookId) {
  const wordCount = await prisma.wordBookWord.count({ where: { bookId } });
  await prisma.wordBook.update({
    where: { id: bookId },
    data: { wordCount, status: wordCount > 0 ? 'active' : 'planned' },
  });
  return wordCount;
}

async function runBook(prisma, book, args) {
  const { words, bad } = loadWords(book.code);
  console.log(`\n=== ${book.name}（${book.code}）=== 清单 ${book.wordCount}，文件 ${words.length}`);
  if (bad) console.log(`   ⚠️ ${bad} 行解析失败，已跳过`);

  // 繁体中译剔除。统计必须**打全**（含 0）：它是"上游又混进繁体了"的唯一可见性 ——
  // 少了它，表现只会是"某些例句莫名其妙不见了"，看起来像上游少给了数据。
  const cleaned = words.map(stripTraditional);
  const trad = cleaned.reduce(
    (acc, c) => ({
      meaning: acc.meaning + c.stat.meaning,
      example: acc.example + c.stat.example,
      phrase: acc.phrase + c.stat.phrase,
    }),
    { meaning: 0, example: 0, phrase: 0 },
  );
  const tradTotal = trad.meaning + trad.example + trad.phrase;
  const affected = cleaned.filter((c) => c.stat.meaning + c.stat.example + c.stat.phrase > 0).length;
  console.log(
    `   繁体剔除：影响 ${affected} 个词条（释义 ${trad.meaning} · 例句 ${trad.example} · 词组 ${trad.phrase}）`,
  );

  if (args.dryRun) return { imported: 0, wordCount: 0, skipped: true, tradTotal };

  const row = await ensureBook(prisma, book);
  const rows = cleaned.map((c) => toRow(c.rec));
  for (let i = 0; i < rows.length; i += BATCH) {
    await persistBatch(prisma, row.id, rows.slice(i, i + BATCH), i);
    process.stdout.write(`\r   已写入 ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  process.stdout.write('\n');

  const wordCount = await refreshBookCount(prisma, row.id);
  return { imported: words.length, wordCount, skipped: false, tradTotal };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // `--prune-traditional` 是**独立模式**：只清库，不导入。
  // 与 `gen-sentences.mjs` 的同名参数保持一致（两处行为不一时最容易误判"跑过了"）。
  if (args.pruneTraditional) {
    const prisma = new PrismaClient();
    try {
      await pruneTraditional(prisma, args.dryRun);
    } finally {
      await prisma.$disconnect();
    }
    return;
  }

  const manifest = loadManifest();
  const books = manifest.filter((b) => !args.books.length || args.books.includes(b.code));
  if (!books.length) {
    throw new Error(
      `--book 只能取清单里的：\n  ${manifest.map((b) => b.code).join(' / ')}`,
    );
  }

  console.log(
    `词书 ${books.length}/${manifest.length} 本${args.dryRun ? '（dry-run，不写库）' : ''}` +
      '\n来源清单：scripts/db/data/books.json',
  );

  const prisma = new PrismaClient();
  const failures = [];
  let importedTotal = 0;
  let wordsTotal = 0;

  try {
    for (const book of books) {
      try {
        const r = await runBook(prisma, book, args);
        importedTotal += r.imported;
        wordsTotal += r.wordCount;
        if (!r.skipped) console.log(`   ✅ 关联 ${r.wordCount} 词`);
      } catch (err) {
        failures.push(`${book.code}: ${err.message}`);
        console.log(`   ❌ ${err.message}`);
        if (!args.keepGoing) throw err;
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(`\n合计：写入 ${importedTotal} 条词书关联，覆盖 ${wordsTotal} 词次`);
  if (args.dryRun) console.log('（dry-run 未写库）');

  if (failures.length) {
    console.error(
      `⚠️ ${failures.length} 本失败 —— 词库会缺书：\n  ${failures.join('\n  ')}\n` +
        '  请重跑（已导入的部分用 upsert，不会重复也不会丢用户进度）',
    );
    process.exitCode = 1;
  }
}

await main();
