#!/usr/bin/env node
/**
 * 下线词书：删除 `books.json` 里已经不再声明的词书，及其全部关联数据
 *
 * ## 为什么需要这个脚本
 *
 * 词书定义只在 `scripts/db/data/books.json` 一处（见 `gen-words.mjs` 文件头）。
 * 但从 `BOOKS` 里删掉一本，**数据库里的那本不会跟着消失**：
 * 界面读的是数据库，小程序会继续显示它，而词库守卫又会因为
 * "库里有清单外的词书"而报错 —— **两头都报，但没有一行提示说该怎么修**。
 *
 * 所以下线的完整动作是两步：
 *   ① 从 `fetch-wordlists.mjs` 的 BOOKS 里删（→ 重新生成 books.json）
 *   ② 跑本脚本，把库里多出来的那几本连同数据一起清掉
 *
 * ## 连带删除哪些数据（这是本脚本的核心）
 *
 * 一本词书删掉，下面三张表会留有它的痕迹，**少清一张就会留下垃圾**：
 *
 * | 表 | 清什么 | 不清会怎样 |
 * |---|---|---|
 * | `word_book` | 词书本体 | 小程序继续显示这本（界面读的是库，不是 BOOKS） |
 * | `word_book_word` | 该书与词的关联 | 词条"悬空"，守卫统计的关联数对不上 |
 * | `user_word_book` | 用户的选书记录 | "我的词书"里留着一条指向不存在的书 |
 * | `user_word_progress` | 在该书首学的词的进度 | 统计"已学 N 词"包含用户看不到的词 |
 *
 * ### ⚠️ `word_study_log` **不在删除范围内**（这是刻意的）
 *
 * 它只有 `(userId, day)` 一个唯一键，**不带 `bookId`** —— 即"某人某天学了几个词"
 * 这个事实**无法归因到具体哪本书**。所以：
 *   - 想删"这本书带来的打卡记录"在数据上做不到（没有这个维度）；
 *   - 硬要按"删掉的那几天"来清，会把用户在**保留的词书上**的学习记录一起抹掉。
 *
 * 结论：**保留打卡日志**。它记的是用户真实花过的时间，不该因为词书下线而消失。
 * 代价是"日历上的历史数字"可能略大于"当前词书能解释的量"—— 这是诚实的，
 * 而不是把它清成好看的数字。
 *
 * ## ⚠️ 词条本体（`word`）**不删**
 *
 * 一个词可能同时属于多本词书（`cet4` 与 `cet6` 有大量重叠）。删词书时
 * 顺手删词会造成**无法挽回的连带损失**：删掉"小学三年级"会把 `cet4` 里
 * 同名的 `apple` 一起删掉。所以只删关联，词条留给"孤儿清理"另行处理
 * （见末尾的孤儿统计，只**报告**不删）。
 *
 * ## 用法
 *
 *   node scripts/db/prune-books.mjs              # 只报告要删什么（安全）
 *   node scripts/db/prune-books.mjs --apply      # 真正执行删除
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';

const ROOT = resolve(import.meta.dirname, '../..');
const MANIFEST = resolve(ROOT, 'scripts/db/data/books.json');

/** 保留哪些词书 —— 与 `gen-words.mjs` 同源，避免两处清单漂移 */
function keepCodes() {
  const parsed = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const books = Array.isArray(parsed) ? parsed : parsed.books;
  if (!Array.isArray(books) || books.length === 0) {
    // 清单为空/坏掉时**必须中止**：否则"要删的" = 全部词书，
    // 一次误操作能把 2 万多个词的关联全清掉，而且没有任何二次确认。
    throw new Error(`books.json 里没有词书清单（${MANIFEST}），拒绝执行以免误删全部词书`);
  }
  return books.map((b) => b.code);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const keep = keepCodes();
  const prisma = new PrismaClient();

  try {
    const doomed = await prisma.wordBook.findMany({
      where: { code: { notIn: keep } },
      select: { id: true, code: true, name: true, wordCount: true },
      orderBy: { code: 'asc' },
    });

    console.log(`\n保留 ${keep.length} 本：${keep.join(', ')}`);
    if (doomed.length === 0) {
      console.log('✅ 数据库里没有需要下线的词书，无需清理\n');
      return;
    }

    const ids = doomed.map((b) => b.id);
    console.log(`\n待下线 ${doomed.length} 本：`);
    for (const b of doomed) console.log(`  ${b.code.padEnd(14)} ${b.name}（${b.wordCount} 词）`);

    // 先数清楚会牵连多少数据 —— 让执行者在下决定前看得到代价
    const [links, members, progress] = await Promise.all([
      prisma.wordBookWord.count({ where: { bookId: { in: ids } } }),
      prisma.userWordBook.count({ where: { bookId: { in: ids } } }),
      prisma.userWordProgress.count({ where: { bookId: { in: ids } } }),
    ]);
    console.log(`\n连带删除：词书关联 ${links} · 选书记录 ${members} · 学习进度 ${progress}`);
    console.log('（⚠️ 打卡日志 word_study_log 保留：它没有 bookId，无法归因到具体词书）');

    if (!apply) {
      console.log('\n（这是预演，未改动任何数据。确认无误后加 --apply 执行）\n');
      return;
    }

    // 顺序：**必须串行**，且先子表后父表。
    //
    // ⚠️ 曾经用 `Promise.all` 并发删这四张表 → 报
    // `Transaction failed due to a write conflict or a deadlock`。
    // 原因是 `word_book_word` 与 `user_word_progress` 之间、
    // 以及它们与 `word_book` 之间的外键约束会让并发事务互相等锁
    // （Cascade 在删父表时要回查子表）。串行的代价是几秒，换来确定性。
    //
    // ⚠️ 另外：**Cascade 不能代替显式删除**。Cascade 只在"删父行"那一刻触发，
    // 而这里要的是"精确按 bookId 清"。显式删还能给出每张表的准确影响行数（可核对）。
    const dProg = await prisma.userWordProgress.deleteMany({ where: { bookId: { in: ids } } });
    const dMember = await prisma.userWordBook.deleteMany({ where: { bookId: { in: ids } } });
    const dLink = await prisma.wordBookWord.deleteMany({ where: { bookId: { in: ids } } });
    const dBook = await prisma.wordBook.deleteMany({ where: { id: { in: ids } } });
    console.log(
      `\n✅ 已删除：进度 ${dProg.count} · 选书 ${dMember.count} · ` +
        `关联 ${dLink.count} · 词书 ${dBook.count}`,
    );

    // 词条本体不删（见文件头）。但要如实报告"有多少词已经不属于任何词书"，
    // 否则这些孤儿会一直躺在库里、被统计口径算进去而没人知道。
    const orphans = await prisma.word.count({ where: { books: { none: {} } } });
    const left = await prisma.wordBook.count();
    console.log(`\n词条总数 ${await prisma.word.count()}，其中不属于任何词书的 ${orphans} 个`);
    console.log(`剩余词书 ${left} 本：`);
    const rest = await prisma.wordBook.findMany({
      select: { code: true, name: true, wordCount: true },
      orderBy: { code: 'asc' },
    });
    for (const b of rest) console.log(`  ${b.code.padEnd(14)} ${b.name}（${b.wordCount} 词）`);
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}\n`);
  process.exit(1);
});
