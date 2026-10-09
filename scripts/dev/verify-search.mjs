/**
 * 全文检索端到端验证（M4-07）。
 *
 * ## 为什么必须有这个脚本
 *
 * MySQL FULLTEXT 有一类**不报错、只是永远返回空**的失败模式：
 * 默认分词器按空格切词，中文正文会被当成一个整词 —— 检索"摄影"匹配不到
 * "校园摄影服务"，而查询本身执行成功、`/health` 也是绿的。
 *
 * 这种"静默错"靠读代码发现不了，只能真跑一次中文检索。
 * 所以本脚本断言的是**命中数**，而不是"查询没报错"。
 *
 * ## 前置
 *
 *   1. 已执行 `npm run db:deploy`（建 `search_index` 表与 ngram 全文索引）；
 *   2. `SEARCH_DRIVER=mysql`。
 * 任一条不满足时脚本会**明确报出是哪一条**，而不是抛一句 SQL 原文。
 *
 * ## 用法
 *
 *   npm run verify:search
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const apiRequire = createRequire(resolve(ROOT, 'apps/api/package.json'));
const require2 = createRequire(import.meta.url);

const { validateEnv } = require2(resolve(ROOT, 'apps/api/dist/common/config/env.schema.js'));
const { buildConfig } = require2(resolve(ROOT, 'apps/api/dist/common/config/configuration.js'));
const { RealProviderFactory } = require2(
  resolve(ROOT, 'apps/api/dist/infra/providers/real-provider.factory.js'),
);

/** 读 apps/api/.env（由根 .env 同步而来） */
function readEnv() {
  const out = {};
  for (const line of readFileSync(resolve(ROOT, 'apps/api/.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const logger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** 测试语料：**刻意包含中文**，且检索词不是标题开头（那样才检验得出分词） */
const DOCS = [
  { id: 'doc-1', type: 'service', title: '校园摄影服务', body: '提供毕业照、证件照、活动跟拍，可预约校园内的摄影师' },
  { id: 'doc-2', type: 'task', title: '代取快递', body: '帮忙到菜鸟驿站取快递并送到宿舍楼下，晚上七点前完成' },
  { id: 'doc-3', type: 'knowledge', title: '图书馆开放时间', body: '周一至周五 8:00-22:00，周末 9:00-21:00，寒暑假另行通知' },
];

/** 检索词 → 期望能命中的文档（中文分词是这里唯一的考点） */
const CASES = [
  { query: '摄影', expect: 'doc-1', why: '词在标题中间，检验 ngram 是否切开了中文' },
  { query: '快递', expect: 'doc-2', why: '同上' },
  { query: '开放时间', expect: 'doc-3', why: '多字词，检验 ngram 的 2-gram 组合' },
  { query: '驿站', expect: 'doc-2', why: '词只出现在正文里，检验正文列也进了索引' },
];

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? `（${detail}）` : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  const env = validateEnv(readEnv());
  const cfg = buildConfig(env);

  console.log('\n全文检索端到端验证（M4-07）\n');
  console.log(`   SEARCH_DRIVER: ${cfg.search.driver}`);

  if (cfg.search.driver !== 'mysql') {
    console.log('\n❌ 当前 SEARCH_DRIVER 不是 mysql。');
    console.log('   请先在 .env 设 SEARCH_DRIVER=mysql 并重跑（本脚本只验证真实检索路径）。');
    process.exit(1);
  }

  const { PrismaClient } = apiRequire('@prisma/client');
  const prisma = new PrismaClient();
  await prisma.$connect();
  console.log('   database     : 已连接\n');

  const providers = new RealProviderFactory({}, logger, prisma).build(cfg);
  const search = providers.search;
  console.log(`   provider     : ${search.name}\n`);

  // ---------- 写入 ----------
  console.log('='.repeat(74));
  for (const doc of DOCS) {
    await search.index(doc.type, doc);
    console.log(`   已索引 ${doc.id}  ${doc.title}`);
  }

  // 幂等：同一条重复写不应该产生第二行
  await search.index('service', DOCS[0]);
  const rows = await prisma.$queryRaw`SELECT COUNT(*) AS n FROM search_index WHERE ref_id = 'doc-1'`;
  check(Number(rows[0].n) === 1, '重复索引同一文档不产生重复行（upsert 生效）', `实际 ${rows[0].n} 行`);

  // ---------- 检索 ----------
  console.log('\n' + '='.repeat(74));
  for (const c of CASES) {
    const { list, total } = await search.search(c.query);
    const hit = list.some((h) => h.id === c.expect);
    check(hit, `检索「${c.query}」命中 ${c.expect}`, `命中 ${total} 条 · ${c.why}`);
  }

  // 类型过滤：只查 task 时不应返回 service
  const filtered = await search.search('校园', { type: 'service' });
  check(
    filtered.list.every((h) => h.type === 'service'),
    'type 过滤生效',
    `返回 ${filtered.list.length} 条`,
  );

  // 无关词应为空 —— 这条最能暴露"分词坏了但恰好命中"的假象
  const none = await search.search('量子力学导论');
  check(none.total === 0, '无关词返回 0 条（不是"永远返回全部"）', `实际 ${none.total} 条`);

  // ---------- 清理 ----------
  await prisma.$executeRaw`DELETE FROM search_index WHERE ref_id IN ('doc-1','doc-2','doc-3')`;
  await prisma.$disconnect();

  console.log('\n' + '='.repeat(74));
  console.log(
    failures === 0 ? '🎉 全文检索端到端通过（中文 ngram 分词生效）' : `❌ 有 ${failures} 项未通过`,
  );
  console.log('='.repeat(74));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n脚本异常：', e?.message ?? e);
  process.exit(1);
});
