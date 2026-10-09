#!/usr/bin/env node
/**
 * 拉取四六级句子练习语料 → `scripts/db/data/sentences.jsonl`
 *
 * ## 数据源：Tatoeba（https://tatoeba.org）
 *
 * 用的是官方导出里的**中英句对**，三个文件拼起来：
 *
 * | 文件 | 内容 |
 * |---|---|
 * | `per_language/cmn/cmn-eng_links.tsv.bz2` | 中英句子**配对关系**（`中文id \t 英文id`）|
 * | `per_language/cmn/cmn_sentences.tsv.bz2` | 中文句子（`id \t cmn \t 文本`）|
 * | `per_language/eng/eng_sentences.tsv.bz2` | 英文句子（`id \t eng \t 文本`）|
 *
 * ## ⚠️ 授权：CC-BY 2.0 FR（**必须署名**）
 *
 * 实测语料 79,993 对，过滤后可用约 2.3 万对。授权是
 * **Creative Commons Attribution 2.0 France** —— 允许商用与改编，
 * **但要求署名**。所以：
 *   ① 每条句子落库时带 `source: 'tatoeba'`（可追溯到具体来源）；
 *   ② `OPEN_SOURCE_LICENSES.md` 必须登记（作者 Tatoeba 贡献者 + 许可 + 链接）；
 *   ③ 上线界面需有"语料来自 Tatoeba（CC-BY 2.0 FR）"的署名入口。
 * **漏掉第 ③ 项就是许可证违规**，不是"以后再说"的问题。
 *
 * ## 为什么必须过滤（不过滤会有近一半是繁体）
 *
 * 实测：中文字段里 **57% 是繁体**（`我們試試看`）。直接入库的话，
 * 用户会在"中译英"题面上看到繁体字 —— 对四六级考生是明显的违和。
 * 本脚本用**繁简差异字表**做筛选，只保留简体。
 *
 * 其余过滤条件与理由：
 * - 英文 5~20 词 —— 太短没练习价值，太长超出一次练习的耐心预算；
 * - 英文必须是纯 ASCII —— 混入 `é`/`naïve` 会让"逐词对齐"评分与键盘输入都出问题；
 * - 中文字段必须含汉字 —— 排除 `Muiriel` 这类纯音译/纯英文的"中文"；
 * - 排除含 `[` `]` `{` `}` `<` `>` 的句子 —— 上游那些是标注残缺（如 `[audio]`）；
 * - **按英文小写去重** —— 上游同一句常有多条中文翻译，留着会让"同一句话练三遍"。
 *
 * ## 分级怎么定（`level` 1~3）
 *
 * 没有现成的"四六级难度"标注，用**词数 + 是否含从句/连接词**推：
 *   1 基础（≤7 词且无从句）/ 2 进阶（8~12 词或含从句）/ 3 挑战（≥13 词）。
 * 这是启发式，**不是权威分级** —— 界面文案按"句长"描述，不要写成"四级难度"。
 *
 * ## 用法
 *
 *   npm run db:fetch-sentences              # 拉取并写出 sentences.jsonl
 *   npm run db:fetch-sentences -- --limit 20000   # 只要前 N 条（调试用）
 *   npm run db:fetch-sentences -- --dry-run       # 只统计不写文件
 *
 * ⚠️ 需要先把三个 `*.bz2` 下到 `scripts/db/.cache/sentences/`。
 * 节点原生不解 bz2，所以下载与解压交给 `curl` + `python -c "bz2..."`，
 * 本脚本只做**解析与筛选**（这样它不需要任何新依赖）。
 */
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { hasTraditional } from './traditional-chars.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const DATA_DIR = resolve(ROOT, 'scripts/db/data');
const CACHE_DIR = resolve(ROOT, 'scripts/db/.cache/sentences');

/** 上游文件（`--download` 时用 curl 取到 CACHE_DIR） */
const SOURCES = {
  links: {
    url: 'https://downloads.tatoeba.org/exports/per_language/cmn/cmn-eng_links.tsv.bz2',
    file: 'cmn-eng_links.tsv.bz2',
  },
  cmn: {
    url: 'https://downloads.tatoeba.org/exports/per_language/cmn/cmn_sentences.tsv.bz2',
    file: 'cmn_sentences.tsv.bz2',
  },
  eng: {
    url: 'https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2',
    file: 'eng_sentences.tsv.bz2',
  },
};



const RE_ASCII = /^[\x20-\x7E]+$/;
const RE_HAN = /[\u4e00-\u9fff]/;
const RE_WORD = /[A-Za-z][A-Za-z'-]*/g;
const RE_BAD = /[[\]{}<>|]/;
/** 从句/连接词 —— 用来把"有结构的句子"识别成进阶以上 */
const RE_CLAUSE =
  /\b(because|although|though|however|therefore|moreover|furthermore|in order to|according to|as a result|not only|whether|while|which|whose|unless|despite|since|so that|even if)\b/i;

/**
 * 引号包裹 / 对话碎片 —— 上游这类条目**看起来像句子但不是**。
 *
 * 实测样例：`"American?" "Canadian." "Where from?" "Newfoundland."`、
 * `"Anyone can be a legend."`。它们是**对话片段或引文**，放进"中译英"
 * 题面会让人无从下手（要打几个引号？打哪一句？）。
 *
 * 判据（任一命中即丢，且要能解释得清）：
 *   - 以引号开头**且**结尾（整句被引号包着）；
 *   - 句中出现 `?` 或 `.` 之后**又**跟着引号 —— 即"多段对话拼接"；
 *   - 句子含两个以上的引号对（`"` 出现 ≥4 次）。
 */
function isQuotedFragment(en) {
  const quotes = (en.match(/"/g) ?? []).length;
  if (quotes >= 4) return true;
  const t = en.trim();
  if (/^["']/.test(t) && /["']$/.test(t)) return true;
  // 句号/问号/叹号 后面紧跟引号 → 多句拼接
  if (/[.?!]\s*["']/.test(t)) return true;
  return false;
}

/**
 * 专有名词占比过高 —— `'Hayastan' is Armenia's name in Armenian.`
 * 这类句子练的是地名音译，对四六级写作与口语没有迁移价值。
 *
 * 判据：**首字母大写的实词占全部实词的比例 > 0.5**（不含句首那个）。
 * 正常句子（`Students should learn to manage their time.`）只有 1 个大写词；
 * 专有名词堆砌（`Hayastan` / `Armenia` / `Armenian`）会超过一半。
 */
function isProperNounHeavy(en) {
  const words = en.match(RE_WORD) ?? [];
  if (words.length < 5) return false;
  // 跳过句首词；其余首字母大写且不是常见的 "I" 的算专有名词
  const rest = words.slice(1);
  const props = rest.filter((w) => /^[A-Z]/.test(w) && w !== 'I').length;
  return props / rest.length > 0.5;
}

function wordCount(s) {
  return (s.match(RE_WORD) ?? []).length;
}


/**
 * "元语言"句子 —— 句子**在谈论某个词本身**，而不是在用这个语言表达意思。
 *
 * 实测样例：`'Four' is an unlucky number in Japan.`、
 * `"Bracelet" is the same in French.`、`"Having a clear conscience" is an idiom.`
 *
 * 为什么必须丢：这类句子的中文是**解释性的**（"4 在日本是一个不幸的数字"），
 * 中译英时用户没有任何线索该不该加引号、该不该保留原词 ——
 * 题面变成"猜出题人在想什么"，而不是"用英语表达"。
 *
 * 判据：句子里**任何位置**出现引号，且引号内是单个词/短语（≤3 词）。
 * 这比"整句被引号包住"宽，能把上面三条全拦住。
 */
function isMetaLinguistic(en) {
  const m = en.match(/["']([^"']{1,40})["']/g);
  if (!m) return false;
  return m.some((q) => wordCount(q) <= 3);
}

/**
 * 过滤规则表（**表驱动，不写 if 链**）。
 *
 * 写成表而不是一串 `if` 有两个具体好处：
 *   ① 每条规则自带名字，而那个名字就是 `dropped` 统计里的键 ——
 *      统计口径与规则列表**不可能对不上**（写 if 链时曾出现过"删了规则、
 *      统计里还留着一个永远为 0 的键"）；
 *   ② 圈复杂度不随规则数增长，加第 12 条规则不会让 lint 变红。
 *
 * 顺序有意义：先判"字段缺失"再判内容，否则 `en` 为 null 时
 * `RE_ASCII.test(null)` 会把 null 转成字符串 "null" 而**误判为通过**。
 */
const RULES = [
  ['empty', (en, zh) => !en || !zh],
  ['en-not-ascii', (en) => !RE_ASCII.test(en)],
  ['en-annotation', (en) => RE_BAD.test(en)],
  ['en-quote-fragment', (en) => isQuotedFragment(en)],
  ['en-meta-linguistic', (en) => isMetaLinguistic(en)],
  ['zh-no-han', (_en, zh) => !RE_HAN.test(zh)],
  ['zh-annotation', (_en, zh) => RE_BAD.test(zh)],
  ['zh-traditional', (_en, zh) => hasTraditional(zh)],
  ['too-short', (en) => wordCount(en) < 5],
  ['too-long', (en) => wordCount(en) > 20],
  ['proper-noun-heavy', (en) => isProperNounHeavy(en)],
];

/** 英文/中文都过一遍，任何一条不过就丢 —— 丢的原因要计数，不能静默 */
function judge(en, zh) {
  for (const [why, test] of RULES) {
    if (test(en, zh)) return why;
  }
  return null;
}

/** 词数 + 从句 → 1/2/3（见文件头"分级怎么定"） */
function grade(en) {
  const n = wordCount(en);
  if (n >= 13) return 3;
  if (n <= 7 && !RE_CLAUSE.test(en)) return 1;
  return 2;
}

/**
 * 读 bz2 里的 TSV。
 *
 * ⚠️ **不用 Node 解 bz2**（原生不支持，引 `unbzip2-stream` 又是新依赖）。
 * 走 `python -c` 流式解压 —— Python 是项目既有运行时（见 `services/`），
 * 不新增任何东西。解出来的就是纯文本，按行 split 即可。
 */
function readBz2(file) {
  const out = execFileSync(
    'python',
    ['-c', 'import bz2,sys;sys.stdout.write(bz2.open(sys.argv[1],"rt",encoding="utf-8").read())', file],
    { maxBuffer: 1024 * 1024 * 512, encoding: 'utf8' },
  );
  return out.split(/\r?\n/);
}

function parseTsv(lines, minCols) {
  const map = new Map();
  for (const line of lines) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < minCols) continue;
    map.set(parts[0], parts[2]);
  }
  return map;
}

function ensureCached() {
  mkdirSync(CACHE_DIR, { recursive: true });
  for (const src of Object.values(SOURCES)) {
    const dst = resolve(CACHE_DIR, src.file);
    if (existsSync(dst) && statSync(dst).size > 1024) {
      console.log(`  已缓存 ${src.file}`);
      continue;
    }
    console.log(`  下载 ${src.file} …`);
    execFileSync('curl', ['-sSL', '-m', '300', '-o', dst, src.url], { stdio: 'inherit' });
    if (!existsSync(dst) || statSync(dst).size < 1024) {
      throw new Error(`${src.file} 下载失败或体积异常（${src.url}）`);
    }
  }
}

function parseArgs(argv) {
  const out = { limit: 0, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--limit') out.limit = Number(argv[(i += 1)]);
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

/**
 * 遍历链接表，逐条判定并收集。
 *
 * 拆成独立函数不是为了好看：这段在 `main` 里占了 20 多行且带 3 个分支，
 * 合在一起时圈复杂度直接到 13（lint 红线 10）。
 */
function collect(links, cmn, eng) {
  const dropped = new Map();
  const seen = new Set();
  const kept = [];
  const drop = (why) => dropped.set(why, (dropped.get(why) ?? 0) + 1);

  for (const line of links) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const zh = cmn.get(parts[0]);
    const en = eng.get(parts[1]);
    const why = judge(en, zh);
    if (why) {
      drop(why);
      continue;
    }
    const key = en.toLowerCase();
    if (seen.has(key)) {
      drop('en-duplicate');
      continue;
    }
    seen.add(key);
    kept.push({ en, zh, level: grade(en) });
  }

  // 稳定排序：先按难度，再按英文（保证"同样输入得到同样顺序"，可复现）
  kept.sort((a, b) => a.level - b.level || a.en.localeCompare(b.en));
  return { kept, dropped };
}

/**
 * 打印过滤统计与样例。
 *
 * ⚠️ 统计必须**打全**（包括计数为 0 的规则）：它是"哪些规则真的在起作用"
 * 的唯一可见性。某条规则突然开始砍掉 80% 的语料时，只有这一屏能看出来 ——
 * 而少了它，表现只会是"入库数变少了"，看起来像上游数据源的问题。
 */
function report(linkCount, kept, dropped, out) {
  const byLevel = { 1: 0, 2: 0, 3: 0 };
  for (const s of out) byLevel[s.level] += 1;

  console.log(`\n配对成功 ${linkCount} 行`);
  console.log('过滤统计：');
  for (const [why] of RULES) {
    console.log(`  ${why.padEnd(18)} ${dropped.get(why) ?? 0}`);
  }
  console.log(`  ${'en-duplicate'.padEnd(18)} ${dropped.get('en-duplicate') ?? 0}`);
  console.log(`\n可用句子 ${kept.length} 条`);
  console.log(`  基础 ${byLevel[1]} · 进阶 ${byLevel[2]} · 挑战 ${byLevel[3]}`);
  console.log('样例：');
  for (const s of out.slice(0, 5)) console.log(`  [L${s.level}] ${s.en}  |  ${s.zh}`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log('\n拉取 Tatoeba 中英句对（CC-BY 2.0 FR）\n');
  ensureCached();

  console.log('\n解析句子表 …');
  const cmn = parseTsv(readBz2(resolve(CACHE_DIR, SOURCES.cmn.file)), 3);
  const eng = parseTsv(readBz2(resolve(CACHE_DIR, SOURCES.eng.file)), 3);
  console.log(`  中文 ${cmn.size} 条 · 英文 ${eng.size} 条`);

  const links = readBz2(resolve(CACHE_DIR, SOURCES.links.file));
  const { kept, dropped } = collect(links, cmn, eng);
  const out = opts.limit > 0 ? kept.slice(0, opts.limit) : kept;
  report(links.length, kept, dropped, out);

  if (opts.dryRun) {
    console.log('\n（dry-run，未写文件）\n');
    return;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const dst = resolve(DATA_DIR, 'sentences.jsonl');
  writeFileSync(dst, out.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
  console.log(`\n✅ 已写出 ${dst}（${out.length} 条，${(statSync(dst).size / 1024 / 1024).toFixed(1)} MB）`);
  console.log('   ⚠️ 这是中间产物，由 `db:gen-sentences` 读入数据库，**不要手改**\n');
}

main();
