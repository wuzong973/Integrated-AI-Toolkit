#!/usr/bin/env node
/**
 * 把 `scripts/db/data/sentences.jsonl` 导入数据库（练习中心 · 第 2 步）
 *
 * 与 `gen-words.mjs` 同构：**只做三件事** —— 读 JSONL → 切语块 → 写库。
 * 不联网、不调 LLM、不需要 `.env` 里的 AI 凭据。
 *
 * ## ⭐ 语块拆分在这里做，不在请求时算
 *
 * 连词成句的"砖块"是**预先切好落库**的（`chunks` 列）。理由：
 *
 * ① 请求时切的话，同一句话两次练到的砖块可能不同（切分依赖随机或外部服务）；
 * ② 切分规则将来要调（比如把"介词短语"整块保留），调完**必须能重跑**，
 *    而"重跑"意味着切分是个可重复的确定性过程 —— 请求时算是无法重跑的。
 *
 * ## 切分规则（无外部依赖，纯规则）
 *
 * 目标不是"语言学上正确的短语划分"，而是**对初学者友好的拼图块**：
 *
 * | 规则 | 效果 |
 * |---|---|
 * | 先切标点分句 | `Well, I think so.` → 不让逗号把 `Well` 孤立成一块 |
 * | 保护**固定搭配** | `in order to` / `as a result` 等整体成块（拆开就失去意义）|
 * | 保护**动词短语** | `give up` / `look forward to` 整体成块 |
 * | 剩余按 2~3 词合并 | 避免"一个词一块"导致砖块过多（20 词的句子切成 20 块没法拼）|
 *
 * ## 幂等
 *
 * 按 `en`（小写）upsert。已存在的句子**默认只新增、不改动**；
 * 只有加 `--rechunk` 才更新语块；本脚本**完全不碰 `PracticeProgress`**
 * —— 用户进度是另一张表。
 *
 * ⚠️ 正因为"已存在的不改中译"，`sentences.jsonl` 后来被重新过滤干净之后，
 * **重跑本脚本不会清掉库里的旧繁体**。那个必须用 `--prune-traditional`（见下）。
 *
 * ## 用法
 *
 *   npm run db:gen-sentences                        # 全量导入
 *   npm run db:gen-sentences -- --limit 500         # 只导前 500 条（调试）
 *   npm run db:gen-sentences -- --dry-run           # 只统计不写库
 *   npm run db:gen-sentences -- --rechunk           # 只重切语块（不新增句子）
 *   npm run db:gen-sentences -- --prune-traditional # 只清理库中已有的繁体句
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { hasTraditional, findTraditional } from './traditional-chars.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const require = createRequire(resolve(ROOT, 'apps/api/package.json'));
const { PrismaClient } = require('@prisma/client');

const DATA_DIR = resolve(ROOT, 'scripts/db/data');
const SENTENCES = resolve(DATA_DIR, 'sentences.jsonl');

/**
 * 固定搭配：**必须整体成块**。
 *
 * 判据是"拆开之后每一块都不是完整意思"：
 * `in order to` 拆成 `in order` + `to` 之后，前一块是"按顺序"（另一个意思）。
 *
 * ⚠️ 只收**高频且歧义大**的。收太多会把句子切成越来越长的块，
 * 最后退化成"整句一块"—— 那时连词成句就变成了默写，没有提示作用。
 */
const PHRASES = [
  'in order to',
  'as a result',
  'as well as',
  'according to',
  'because of',
  'instead of',
  'in front of',
  'at the same time',
  'on the other hand',
  'as soon as',
  'so that',
  'such as',
  'would like to',
  'be able to',
  'look forward to',
  'take care of',
  'pay attention to',
  'make sure',
  'find out',
  'give up',
  'put off',
  'carry out',
  'take part in',
  'get along with',
  'come up with',
  'look after',
  'deal with',
  'depend on',
  'belong to',
  'consist of',
  'refer to',
  'focus on',
  'lead to',
  'result in',
  'a lot of',
  'plenty of',
  'a number of',
  'the number of',
];

/** 按长度倒序匹配 —— 否则 `in order to` 会先被更短的规则吃掉 */
const PHRASES_SORTED = [...PHRASES].sort((a, b) => b.length - a.length);

const WORD_RE = /[A-Za-z][A-Za-z'-]*/g;

function wordCount(text) {
  return (text.match(WORD_RE) ?? []).length;
}

/**
 * 把一句话切成"砖块"。
 *
 * 返回 `[{ text, zh }]`。**`zh` 一律留空** —— 逐块的译文需要 LLM 或词典，
 * 本项目没有那个数据源，**不能编**（编出来的"砖块释义"是用户会照着背的，
 * 错了比没有更糟）。界面在砖块上只显示英文，中文留给整句的 `zh`。
 */
function chunk(en) {
  const words = en.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const out = [];
  let i = 0;
  while (i < words.length) {
    // ① 先试固定搭配（大小写不敏感、允许词间多空格）
    const lower = words.map((w) => w.toLowerCase());
    let matched = null;
    for (const p of PHRASES_SORTED) {
      const parts = p.split(' ');
      if (i + parts.length > words.length) continue;
      if (parts.every((part, k) => lower[i + k].replace(/[^a-z']/g, '') === part.replace(/[^a-z']/g, ''))) {
        matched = words.slice(i, i + parts.length).join(' ');
        i += parts.length;
        break;
      }
    }
    if (matched) {
      out.push(matched);
      continue;
    }

    // ② 否则取 2~3 个词成块。
    //    为什么不是 1 个词：20 词的句子会切成 20 块，拼图变成折磨。
    //    为什么不是 4 个词：句子短的时候会变成只有 2~3 块，失去提示作用。
    const remain = words.length - i;
    const take = remain >= 3 ? 3 : remain;
    // 句末若只剩 1 个词，并入前一块（避免留下孤立的 `I.` / `it.`）
    if (remain === 1 && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1]} ${words[i]}`;
      i += 1;
      continue;
    }
    out.push(words.slice(i, i + take).join(' '));
    i += take;
  }
  return out.map((text) => ({ text, zh: '' }));
}

/**
 * 是否适合做**口语跟读**素材。
 *
 * 判据来自实际问题：不适合朗读的句子会让"读出来"变成一件别扭的事，
 * 而用户会以为是自己发音不好。
 *   - 过短（<4 词）：`Yes, he does.` 读一遍没有训练量；
 *   - 含**双引号**（引述对话）：要读两个人的话，语速没法定，且 ASR 会把引号吃掉。
 *     ⚠️ 同样只看双引号 —— 撇号是正常的（见 `isUsable` 的说明）。
 */
function isSpeakable(en) {
  const n = wordCount(en);
  if (n < 4) return false;
  if (en.includes('"')) return false;
  return true;
}

/**
 * 不适合**任何**练习模式的句子 —— 导入时直接跳过。
 *
 * ⚠️ **只拦双引号，不拦撇号。** 这是踩过的坑：第一版写成 `/["']/`，
 * 结果一次跳掉 3,960 条 —— 因为 `don't` / `it's` / `John's` 里的撇号
 * 也是 `'`。那些是**完全正常的句子**，误伤它们等于白扔近 20% 的语料。
 * 正确的判据是"有没有**对话引号**"，而对话在英文里一律是 `"`。
 *
 * 为什么在导入这一层拦，而不是回上游脚本改过滤条件：
 *   - `fetch-sentences.mjs` 已经跑完并产出了 `sentences.jsonl`（21,051 条，
 *     重新跑要约 2 分钟下载 + 解析），为十几条重跑一次不划算；
 *   - 更重要的是**过滤分层要清楚**：上游管"语料是否可用"（繁简、长度、
 *     去重），这里管"能否出成题目"。含引号的句子上游判它"可用"是对的
 *     （它是合法的中英句对），只是**不适合做练习**。
 */
function isUsable(en) {
  return !en.includes('"');
}

function loadSentences() {
  if (!existsSync(SENTENCES)) {
    throw new Error(`句子数据不存在：${SENTENCES}（先跑 npm run db:fetch-sentences）`);
  }
  const rows = [];
  let bad = 0;
  for (const line of readFileSync(SENTENCES, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    if (!rec?.en || !rec?.zh) {
      bad += 1;
      continue;
    }
    if (!isUsable(rec.en)) {
      bad += 1;
      continue;
    }
    rows.push(rec);
  }
  if (!rows.length) throw new Error(`${SENTENCES} 里一个句子都没有`);
  if (bad) console.log(`  ⚠️ 跳过 ${bad} 行（解析失败或含引号，不适合出题）`);
  return rows;
}

function parseArgs(argv) {
  const out = { limit: 0, dryRun: false, rechunk: false, pruneTraditional: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--limit') out.limit = Number(argv[(i += 1)]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--rechunk') out.rechunk = true;
    else if (a === '--prune-traditional') out.pruneTraditional = true;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

/**
 * 清掉库里**已经存在**的繁体句子。
 *
 * ## 为什么必须有这个模式（而不是"重跑一遍导入就好"）
 *
 * 本脚本对已存在的句子**只更新语块、不更新中译**（见文件头"幂等"一节），
 * 所以 `sentences.jsonl` 被重新过滤干净之后，**重跑导入不会清掉库里的旧繁体**
 * —— 它按 `en` 找到已有行，然后什么都不改就 `updated += 1` 走过去了。
 *
 * 症状极具迷惑性：**文件里 0 条繁体、守卫全绿、脚本打印成功**，
 * 但界面上照样看到「她用繩子把包裹緊緊綁好了。」—— 因为库里是过滤前的 3210 条。
 * 这个坑在 2026-09-21 实测踩到（用户截图里繁体就是这么来的）。
 *
 * 判据只认 `traditional-chars.mjs`，与筛语料、查词书**同一张表**，绝不另起一套。
 */
async function pruneTraditional(prisma, dryRun) {
  const rows = await prisma.practiceSentence.findMany({ select: { id: true, en: true, zh: true } });
  const bad = rows.filter((r) => hasTraditional(r.zh || ''));
  console.log(`\n【清理繁体】库中 ${rows.length} 条，含繁体 ${bad.length} 条`);
  if (bad.length === 0) {
    console.log('   ✅ 无需清理\n');
    return;
  }
  const chars = new Set();
  for (const b of bad) for (const c of findTraditional(b.zh)) chars.add(c);
  console.log(`   涉及 ${chars.size} 个繁体字：${[...chars].slice(0, 40).join('')}${chars.size > 40 ? '…' : ''}`);
  console.log('   样例：');
  for (const b of bad.slice(0, 5)) console.log(`     · ${b.zh}`);

  if (dryRun) {
    console.log('\n   （dry-run，未删除）\n');
    return;
  }
  const r = await prisma.practiceSentence.deleteMany({ where: { id: { in: bad.map((b) => b.id) } } });
  const total = await prisma.practiceSentence.count();
  console.log(`\n   ✅ 已删 ${r.count} 条，库中余 ${total} 条\n`);
}

/**
 * 模式分发：`--prune-traditional` 走独立路径，其余走导入。
 *
 * 抽成独立函数是为了让 `main` 的圈复杂度留在红线内（`main` 本来就在边界上，
 * 多一个 `if` 就 11 了）。顺带把"哪两个模式互斥"这件事写在一处。
 */
async function dispatch(args) {
  if (!args.pruneTraditional) return false;
  const prisma = new PrismaClient();
  try {
    await pruneTraditional(prisma, args.dryRun);
  } finally {
    await prisma.$disconnect();
  }
  return true;
}

/** 写库之前先打印切分统计 —— 让"切分规则改坏了"在动数据之前就看得见 */
function reportChunking(picked, chunksOf) {
  const sizes = chunksOf.map((c) => c.length);
  const avg = (sizes.reduce((a, b) => a + b, 0) / Math.max(1, sizes.length)).toFixed(1);
  const speakable = picked.filter((r) => isSpeakable(r.en)).length;
  console.log(`语块：平均 ${avg} 块/句，最少 ${Math.min(...sizes)} · 最多 ${Math.max(...sizes)}`);
  console.log(`适合朗读：${speakable} / ${picked.length}`);
  console.log('切分样例：');
  for (let i = 0; i < Math.min(4, picked.length); i += 1) {
    console.log(`  ${picked[i].en}`);
    console.log(`    → ${chunksOf[i].map((c) => `[${c.text}]`).join(' ')}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // `--prune-traditional` 是**独立模式**：只清库，不导入。
  // 刻意让它走早退路径 —— 否则"清完再导入"会在一次运行里做两件相反的事，
  // 日志里也分不清到底是哪一步改了多少。
  if (await dispatch(args)) return;

  const rows = loadSentences();
  const picked = args.limit > 0 ? rows.slice(0, args.limit) : rows;

  console.log(`\n句子 ${rows.length} 条${args.limit ? `（本次取前 ${picked.length} 条）` : ''}`);

  const chunksOf = picked.map((r) => chunk(r.en));
  reportChunking(picked, chunksOf);

  if (args.dryRun) {
    console.log('\n（dry-run，未写库）\n');
    return;
  }

  const prisma = new PrismaClient();
  try {
    let created = 0;
    let updated = 0;
    const t0 = Date.now();

    for (let i = 0; i < picked.length; i += 1) {
      const r = picked[i];
      const data = {
        en: r.en,
        zh: r.zh,
        chunks: chunksOf[i],
        level: r.level ?? 1,
        wordCount: wordCount(r.en),
        source: 'tatoeba',
        speakable: isSpeakable(r.en),
      };
      // 按 en 找已有的（en 没建唯一索引 —— 300 字符的 varchar 在 utf8mb4 下
      // 建唯一索引会超 MySQL 的 3072 字节上限，所以用 findFirst + update）
      const existing = await prisma.practiceSentence.findFirst({
        where: { en: r.en },
        select: { id: true },
      });
      if (existing) {
        if (args.rechunk) {
          // 只重切语块：`--rechunk` 的用途就是"改了切分规则之后刷一遍"
          await prisma.practiceSentence.update({
            where: { id: existing.id },
            data: { chunks: data.chunks, wordCount: data.wordCount, speakable: data.speakable },
          });
        }
        updated += 1;
      } else {
        await prisma.practiceSentence.create({ data });
        created += 1;
      }
      if ((i + 1) % 2000 === 0) {
        process.stdout.write(`  已处理 ${i + 1}/${picked.length}\r`);
      }
    }

    const total = await prisma.practiceSentence.count();
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n✅ 新增 ${created} · 已存在 ${updated} · 库中合计 ${total} 条（${secs}s）\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}\n`);
  process.exit(1);
});
