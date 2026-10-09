#!/usr/bin/env node
/**
 * 静态守卫：AI 能力目录必须与「真的能跑的东西」一致
 *
 * ## 它拦的是哪一类问题
 *
 * 助手的"能力清单"以前是**手写的散文**（系统提示词里那句
 * "平台当前真正可用的能力只有这些"）。写的时候是对的，但没有任何机制保证它继续对 ——
 * 2026-09-17 核对出"18 个 active 里 9 个跑不通"，而提示词当时还在向用户承诺它们。
 * **助手会一本正经地告诉用户一个不存在的功能**，而且不报错。
 *
 * 现在清单来自 `ai-capability.catalog.ts`，本脚本做五方对账：
 *
 *   ① 目录里的每个工具能力 → 必须在 seed 里登记，且 `status: 'active'`
 *   ② 目录里的每个工具能力 → 必须已在执行器里注册（真的能跑）
 *   ③ 目录里每个 entry 的 intent → 必须是 `OS_INTENTS` 里的取值
 *   ④ `invocation: 'guided'` 必须有文件要求与引导语；`'auto'` 不能需要文件
 *   ⑤ 反过来：**已经能跑、却没进目录**的工具 → 漏网之鱼（能力白白藏着，助手不知道）
 *   ⑥ 内部能力（`source: 'internal'`）→ 名字必须在**某个 os-*-tool.ts** 里真有实现，
 *      且在 os-tools.ts 里分流
 *
 * ⑤ 是最容易被忽略、也最有价值的一条：前四条保证"不许吹牛"，
 * 只有 ⑤ 保证"不许藏着"。以前助手只能查校规，而工具箱里躺着 20 个能跑的 AI 能力 ——
 * **不是没实现，是没接线**，而那种状态在前四条里完全查不出来。
 *
 * ## 为什么静态解析而不加载 dist
 *
 * 与 `check-tool-status.mjs` 同一个理由：加载 `apps/api/dist` 需要先 build，
 * 跑守卫前还要等构建，很容易被跳过。这里直接读源码文本，零依赖、秒级完成。
 *
 * ## 用法
 *
 *   node scripts/dev/check-ai-capabilities.mjs
 *
 * 退出码非 0 表示目录与真实可运行状态存在漂移。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// ---------- ① seed.ts：工具名 → status ----------
const seedSrc = read('apps/api/prisma/seed.ts');
const seedTools = new Map();
{
  const start = seedSrc.indexOf('const TOOLS = [');
  const end = seedSrc.indexOf('\nconst ', start + 1);
  const block = seedSrc.slice(start, end === -1 ? undefined : end);
  // ⚠️ 换行必须是 `\r?\n`（本仓库文件是 CRLF），只写 `\n` 会切不出任何一块
  for (const b of block.split(/\r?\n {2}\{\r?\n/).slice(1)) {
    const name = (b.match(/name: '([a-z_]+)'/) ?? [])[1];
    const status = (b.match(/status: '(active|planned)'/) ?? [])[1];
    if (name && status) seedTools.set(name, status);
  }
}

// ---------- ② 执行器：已注册的 handler 键 ----------
const executorSrc = read('apps/api/src/modules/job/tool-executor.service.ts');
const runnable = new Set();
{
  const start = executorSrc.indexOf('this.handlers = {');
  const end = executorSrc.indexOf('\n    };', start);
  for (const m of executorSrc.slice(start, end).matchAll(/^\s{6}([a-z_]+):/gm)) {
    runnable.add(m[1]);
  }
}

// ---------- ③ core：合法的意图取值 ----------
const coreSrc = read('packages/core/src/validators/index.ts');
const intents = new Set();
{
  const start = coreSrc.indexOf('export const OS_INTENTS = [');
  const end = coreSrc.indexOf('] as const', start);
  for (const m of coreSrc.slice(start, end).matchAll(/'([a-z_]+)'/g)) intents.add(m[1]);
}

// ---------- ④ 目录：逐块解析 ----------
// 目录拆成了主表 + 若干按能力域拆分的子表（都是为了守住单文件 300 行红线）。
// ⚠️ 解析时必须把子表**展开进主表**：目录是"唯一真相源"，少读一份
// 就会变成"能跑却没登记"的假漂移（拆分当天就真实发生过）。
const CATALOG_DIR = 'apps/api/src/modules/os';
const CATALOG_MAIN = `${CATALOG_DIR}/ai-capability.catalog.ts`;

/**
 * 把主表里**所有** `...XXX,` 展开成对应子表的数组体。
 *
 * ⚠️ 必须通用处理，不能硬编码子表文件名：目录按能力域继续拆表是常态，
 * 硬编码的写法会让"新拆一个子表"直接变成"守卫读不到它" ——
 * 然后报出一堆假漂移，而照着提示去改目录的人会发现怎么改都不对
 *（这个坑在加第三个子表时又踩了一次，所以改成从 import 反查文件名）。
 */
function expandCatalog(src) {
  return src.replace(/^ {2}\.\.\.([A-Za-z_]+),$/gm, (line, name) => {
    const rel = src.match(new RegExp(`import \\{ ${name} \\} from '\\./([^']+)'`))?.[1];
    if (!rel) return line;
    const child = read(`${CATALOG_DIR}/${rel}.ts`);
    return child.slice(child.indexOf('=[') + 1, child.lastIndexOf('];'));
  });
}

const catalogSrc = expandCatalog(read(CATALOG_MAIN));
const entries = [];
{
  const start = catalogSrc.indexOf('export const AI_CAPABILITY_CATALOG');
  const block = catalogSrc.slice(start);
  // 每块以 `  {\n` 开头（数组元素缩进 2 空格）
  for (const b of block.split(/\r?\n {2}\{\r?\n/).slice(1)) {
    const pick = (re) => (b.match(re) ?? [])[1];
    const toolName = pick(/toolName: '([a-z_]+)'/);
    if (!toolName) continue;
    entries.push({
      toolName,
      source: pick(/source: '(tool|internal)'/) ?? 'tool',
      intent: pick(/intent: '([a-z_]+)'/),
      invocation: pick(/invocation: '(auto|guided)'/),
      needsFile: pick(/needsFile: '(\w+)'/) ?? (/(\bneedsFile: false)/.test(b) ? 'false' : ''),
      hasGuideHint: /guideHint:/.test(b),
      // 描述是给模型的，太短说明没写清"什么时候调"
      sceneLen: (pick(/scene:\s*\r?\n?\s*'([^']*)'/) ?? '').length,
    });
  }
}

const problems = [];
const notes = [];

// 重名检查
{
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.toolName)) problems.push(`AI 能力目录里出现重复能力：${e.toolName}`);
    seen.add(e.toolName);
  }
}

for (const e of entries) {
  // ①② 工具能力必须真的能跑
  if (e.source === 'tool') {
    const status = seedTools.get(e.toolName);
    if (!status) {
      problems.push(
        `${e.toolName} 在 AI 能力目录里，但 seed.ts 的 TOOLS 里没有它 —— 注册表会把它丢掉`,
      );
    } else if (status !== 'active') {
      problems.push(
        `${e.toolName} 在 AI 能力目录里，但 seed 里是 ${status} —— 助手会向用户承诺一个未上线的能力`,
      );
    }
    if (!runnable.has(e.toolName)) {
      problems.push(
        `${e.toolName} 在 AI 能力目录里，但执行器没注册 —— 模型调用后必然报"尚未接入执行器"`,
      );
    }
  }

  // ③ 意图取值必须合法
  if (!e.intent) {
    problems.push(`${e.toolName} 没写 intent —— 小程序的路由按钮与文档分组都靠它`);
  } else if (!intents.has(e.intent)) {
    problems.push(
      `${e.toolName} 的 intent 是「${e.intent}」，不在 OS_INTENTS（${[...intents].join(' / ')}）里 —— ` +
        '不会报错，但界面永远匹配不上，属于静默失效',
    );
  }

  // ④ 调用形态自洽
  if (e.invocation === 'guided') {
    if (!e.needsFile || e.needsFile === 'false') {
      problems.push(`${e.toolName} 是 guided，但没写 needsFile —— 调度层就不知道"缺什么文件"`);
    }
    if (!e.hasGuideHint) {
      problems.push(`${e.toolName} 是 guided，但没写 guideHint —— 缺文件时用户不知道该做什么`);
    }
  }
  if (e.invocation === 'auto' && e.needsFile && e.needsFile !== 'false') {
    problems.push(
      `${e.toolName} 是 auto 却要求文件（${e.needsFile}）—— 模型会在用户没传文件时直接调用然后失败`,
    );
  }
  if (e.sceneLen < 8) {
    problems.push(`${e.toolName} 的 scene 太短 —— 它是模型的工具描述，写不清模型就会乱调`);
  }
}

// ⑤ 反向：能跑却没进目录（"能力白白藏着"）
for (const [name, status] of seedTools) {
  if (status !== 'active') continue;
  if (!runnable.has(name)) continue; // 这类由 check-tool-status.mjs 负责报
  if (!entries.some((e) => e.toolName === name)) {
    problems.push(
      `「${name}」已经能跑，却没登记进 AI 能力目录 —— 助手不知道它存在，` +
        '用户说"帮我做这个"时助手只能回答"我做不到"',
    );
  }
}

// ⑥ 内部能力必须真有实现
const internalEntries = entries.filter((e) => e.source === 'internal');
const osToolsSrc = read('apps/api/src/modules/os/os-tools.ts');
// 扫描**所有**内部实现文件：早先只读一个文件，于是第二个实现文件里的能力全被判"未定义"。
// 这与目录子表当年的坑同源 —— 守卫硬编码文件名，新增文件就不被认。
const internalDir = 'apps/api/src/modules/os';
const internalImplSrc = readdirSync(resolve(ROOT, internalDir))
  .filter((f) => /^os-.*-tool\.ts$/.test(f))
  .map((f) => read(`${internalDir}/${f}`))
  .join('\n');
for (const e of internalEntries) {
  // 能力名常量形如 `export const PARSE_REQUIREMENT = 'parse_requirement';`
  const constRe = /export const (\w+) = '([a-z_]+)'/g;
  let constName;
  for (const m of internalImplSrc.matchAll(constRe)) {
    if (m[2] === e.toolName) {
      constName = m[1];
      break;
    }
  }
  const declared = !!constName;
  // 分流分支：`invocation.name === SEARCH_KNOWLEDGE`
  const routed = constName
    ? new RegExp(`invocation\\.name === ${constName}`).test(osToolsSrc)
    : false;
  if (!declared || !routed) {
    problems.push(
      `内部能力「${e.toolName}」在目录里声明了，但 ${!declared ? '没有任何 os-*-tool.ts 定义它' : '未在 os-tools.ts 分流'} —` +
        '模型调用时会走到工具执行器，然后报"尚未接入"（内部能力不走作业链路）',
    );
  }
}

// ---------- 输出 ----------
console.log('\n' + '='.repeat(74));
console.log('AI 能力目录对账（目录 × seed × 执行器 × 意图表 × 内部实现）');
console.log('='.repeat(74));

const byIntent = {};
for (const e of entries) (byIntent[e.intent] ??= []).push(e.toolName);
for (const [intent, names] of Object.entries(byIntent)) {
  console.log(`  ${intent.padEnd(16)} ${names.length} 项  ${names.join(', ')}`);
}
const autoCount = entries.filter((e) => e.invocation === 'auto').length;
console.log(
  `\n  共 ${entries.length} 项能力：模型可直接执行 ${autoCount} 项，需先上传文件 ${entries.length - autoCount} 项`,
);
console.log(`  seed 里 active 且有执行器实现的工具：${[...runnable].filter((n) => seedTools.get(n) === 'active').length} 个`);

for (const n of notes) console.log(`  ℹ️  ${n}`);

if (problems.length) {
  console.log('\n❌ 发现 ' + problems.length + ' 处漂移：\n');
  for (const p of problems) console.log(`   · ${p}`);
  console.log('\n修复方式：改 ai-capability.catalog.ts（或在 seed / 执行器里补齐），三者必须一致。');
  process.exit(1);
}

console.log('\n✅ AI 能力目录与真实可运行状态一致。\n');
