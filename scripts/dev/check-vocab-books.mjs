#!/usr/bin/env node
/**
 * 词书定义一致性守卫
 *
 * ## 拦的是哪一类"不报错"
 *
 * 词书定义曾经散在**三处**，任何一处单独改都会静默出错：
 *
 *   ① `scripts/db/gen-words.mjs` 的 `BOOKS` —— 决定"往库里建哪几本词书、灌哪些词"（已删）
 *   ② `scripts/db/fetch-wordlists.mjs` 的 `BOOKS` —— 决定"从外部拉哪些词书、写哪个文件"
 *   ③ `scripts/db/data/*.txt` —— 真正的词形来源（已换成 `*.jsonl`）
 *
 * 现在改成**单一来源**：② 生成 `data/books.json`，`gen-words.mjs` 与
 * `check:vocab-books` 都读它。定义只有一份，漂移在结构上就不可能发生 ——
 * 所以本守卫要盯的不再是"两份 BOOKS 是否一致"，而是：
 *
 *   ① `books.json` 与 `fetch-wordlists.mjs` 的 BOOKS 是否一致
 *      （清单是上一次跑脚本的产物，BOOKS 改了但没重跑就会漂移 ——
 *       症状是"我加了新词书，界面却看不到"）；
 *   ② 每本词书**是不是真有对应的非空 `.jsonl` 数据文件**；
 *   ③ `.jsonl` 里**不能只有坏行** —— `gen-words` 对空文件**不报错**
 *      （循环零次），于是词书建出来 `wordCount=0`、`status` 停在 `planned`，
 *      界面显示"建设中"，而没有任何一步提示"是你文件写坏了"；
 *   ④ 清单里记的 `wordCount` 与**实际文件条数**是否对得上
 *      （对不上说明数据被改过而没重跑，或清单是旧的）。
 *
 * ## 用法
 *
 *   npm run check:vocab-books
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const DATA_DIR = resolve(ROOT, 'scripts/db/data');
const MANIFEST = resolve(DATA_DIR, 'books.json');

const failures = [];
const fail = (msg) => {
  failures.push(msg);
  console.log(`   ❌ ${msg}`);
};
const ok = (msg) => console.log(`   ✅ ${msg}`);

/**
 * 从 `fetch-wordlists.mjs` 里抠出 `const BOOKS = [...]` 的 code 列表。
 *
 * 刻意**不 import**：那个脚本顶层就 `await main()`（跑起来会连网下载），
 * 静态守卫绝不能执行它。用正则抽 code 是这里唯一可行的读法。
 */
function extractFetchCodes() {
  const rel = 'scripts/db/fetch-wordlists.mjs';
  const text = readFileSync(resolve(ROOT, rel), 'utf8');
  const start = text.indexOf('const BOOKS = [');
  if (start < 0) throw new Error(`${rel} 里找不到 'const BOOKS = ['`);
  const end = text.indexOf('\n];', start);
  if (end < 0) throw new Error(`${rel} 的 BOOKS 数组没有正常结束`);
  const codes = [...text.slice(start, end).matchAll(/code:\s*'([^']+)'/g)].map((m) => m[1]);
  if (!codes.length) throw new Error(`${rel} 的 BOOKS 里一个 code 都没解析出来`);
  return codes;
}

/** 读一份 `.jsonl`：返回 { total, bad }，不存在则返回 null */
function countJsonl(code) {
  const p = resolve(DATA_DIR, `${code}.jsonl`);
  if (!existsSync(p)) return null;
  let total = 0;
  let bad = 0;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec?.spelling) total += 1;
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  return { total, bad };
}

console.log('\n词书定义一致性（fetch-wordlists ↔ books.json ↔ data/*.jsonl）\n');

if (!existsSync(MANIFEST)) {
  fail('清单不存在：scripts/db/data/books.json（先跑 npm run db:fetch-words）');
  console.log('\n❌ 1 项未通过\n');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const mBooks = manifest?.books ?? [];
if (!mBooks.length) {
  fail('books.json 里没有 books 数组或为空');
  console.log('\n❌ 1 项未通过\n');
  process.exit(1);
}

// ---------- ① 清单 ↔ fetch-wordlists 的 BOOKS ----------
console.log('① 清单与 fetch-wordlists 的 BOOKS 一致');
const fetchCodes = extractFetchCodes();
const mCodes = mBooks.map((b) => b.code);
const onlyManifest = mCodes.filter((c) => !fetchCodes.includes(c));
const onlyFetch = fetchCodes.filter((c) => !mCodes.includes(c));
if (onlyManifest.length) {
  fail(
    `只在 books.json 里有：${onlyManifest.join(', ')} —— 多半是 fetch-wordlists 的 BOOKS 删了但没重跑`,
  );
}
if (onlyFetch.length) {
  fail(
    `只在 fetch-wordlists 里有：${onlyFetch.join(', ')} —— ` +
      'BOOKS 加了新词书但没重跑 db:fetch-words，清单还是旧的（界面看不到这本）',
  );
}
if (!onlyManifest.length && !onlyFetch.length) ok(`${mCodes.length} 本两侧一致`);

// ---------- ② 每本词书都有非空数据文件 ----------
console.log('\n② 每本词书都有非空 .jsonl');
for (const b of mBooks) {
  const c = countJsonl(b.code);
  if (c === null) {
    fail(`scripts/db/data/${b.code}.jsonl 不存在（先跑 npm run db:fetch-words）`);
  } else if (c.total === 0) {
    fail(
      `scripts/db/data/${b.code}.jsonl 里没有可用词条（只有坏行 ${c.bad}）—— ` +
        '词书会以"建设中"的状态建出来',
    );
  } else if (c.bad) {
    fail(`scripts/db/data/${b.code}.jsonl 有 ${c.bad} 行解析失败（先修数据再导库）`);
  } else {
    ok(`${b.code.padEnd(14)} ${String(c.total).padStart(6)} 词`);
  }
}

// ---------- ③ 清单记的 wordCount 要等于实际条数 ----------
console.log('\n③ 清单 wordCount 与实际条数一致');
let drift = 0;
for (const b of mBooks) {
  const c = countJsonl(b.code);
  if (!c) continue; // ② 已报过
  if (typeof b.wordCount === 'number' && b.wordCount !== c.total) {
    fail(
      `${b.code}: 清单记 ${b.wordCount}，文件里 ${c.total} —— ` +
        '数据改过而没重跑 db:fetch-words（清单是旧的）',
    );
    drift += 1;
  }
}
if (!drift) ok('全部一致');

// ---------- ④ 全局总量下限 ----------
console.log('\n④ 全局词条总量');
const total = mBooks.reduce((a, b) => a + (countJsonl(b.code)?.total ?? 0), 0);
// 这个下限是"词书系统没退化"的底线，不是目标值（当前实际约 7.1 万条 / 2.2 万不重复词）。
// 调低它 = 接受了"词库又变回几百词"，那是要被拦住的。
//
// ⚠️ 词书数量本身**不作为判据**：M4-16 按需求把小学/初中/高中的通用词书删掉，
// 只留 `junior_bnu` 与 `highschool_bs` 两本教材词书，总数从 23 本降到 13 本 ——
// 这是**有意的内容调整**，不是退化。若把"23 本"写死成断言，这次调整就会被误报成故障，
// 而下次真的要精简时又得先改守卫（守卫变成改动的阻力而不是保护）。
// 真正该守住的是"每本都有非空数据"（②）与"总量不至于退化成起步词表"（④）。
const MIN_TOTAL = 10000;
if (total < MIN_TOTAL) {
  fail(`词条总量 ${total} 低于下限 ${MIN_TOTAL} —— 词库退化成了"起步词表"`);
} else {
  ok(`合计 ${total} 条（下限 ${MIN_TOTAL}）`);
}

console.log('');
if (failures.length) {
  console.log(`❌ ${failures.length} 项未通过\n`);
  process.exit(1);
}
console.log('✅ 全部通过\n');
