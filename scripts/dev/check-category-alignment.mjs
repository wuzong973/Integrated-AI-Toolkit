#!/usr/bin/env node
/**
 * 服务分类「前后端枚举对齐」守卫（排查报告 P2-4）
 *
 * ## 为什么需要它
 *
 * 服务分类的 id 同时存在于**两个地方**，且**没有任何机制保证它们一致**：
 * - 后端：`apps/api/prisma/seed.ts` 的 `SERVICE_CATEGORIES`（落库到 `service_category` 表）
 * - 前端：`apps/mp/pages/station/index.ts` 的 `CATEGORIES`（分类横滑的写死列表）
 *
 * 后果很隐蔽：**改了一边不会报错**。用户在界面上点「摄影摄像」，
 * 前端拿 `photo` 去查，而后端表里可能已经是 `photography` ——
 * 结果是"这个分类下没有任务"，看起来像"还没人发布"，而不是"枚举没对齐"。
 *
 * ## 为什么用"读文本比对"而不是共享一个常量
 *
 * seed 只依赖 `@prisma/client`（见其 import），引入 `@qz/core` 会让
 * `prisma db seed` 的构建链多一层依赖；而这条一致性**只在改动时**需要校验，
 * 静态检查的成本远低于运行期耦合。这与 `audit:api`（读 api.ts 文本比对后端路由）
 * 是同一套思路。
 *
 * ## 用法
 *
 *   node scripts/dev/check-category-alignment.mjs [--json]
 *
 * 退出码非 0 表示两侧枚举不一致。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const SEED = 'apps/api/prisma/seed.ts';
const MP_PAGE = 'apps/mp/pages/station/index.ts';

/** 取出 `const NAME = [ ... ];` 这段数组字面量 */
function arrayLiteral(src, constName) {
  const start = src.indexOf(`const ${constName} = [`);
  if (start < 0) return null;
  const open = src.indexOf('[', start);
  // 从 `[` 开始做括号配平，取到与之配对的 `]`
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * 从数组字面量里抽 `{ id: 'x', name: 'y' }` 形式的条目。
 *
 * 按 `{ ... }` 分块解析而不是全局正则 —— 全局正则会把相邻条目的
 * id 与 name 交叉配对（例如把下一条的 name 配到上一条的 id 上）。
 */
function parseEntries(literal) {
  const entries = new Map();
  for (const chunk of literal.split('{').slice(1)) {
    const body = chunk.split('}')[0];
    const id = /\bid:\s*'([^']*)'/.exec(body)?.[1];
    const name = /\bname:\s*'([^']*)'/.exec(body)?.[1];
    // ⚠️ 必须用 `!== undefined` 而不是真值判断：前端的「全部」项 id 是**空串**，
    //    用 `if (id)` 会把它整条丢掉，于是"缺少「全部」"这条断言永远误报。
    if (id !== undefined) entries.set(id, name ?? '');
  }
  return entries;
}

function load(file, constName) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const literal = arrayLiteral(src, constName);
  if (literal === null) return null;
  return parseEntries(literal);
}

const problems = [];
const report = (msg) => problems.push(msg);

const backend = load(SEED, 'SERVICE_CATEGORIES');
const frontend = load(MP_PAGE, 'CATEGORIES');

if (!backend) {
  report(`${SEED} 里找不到 SERVICE_CATEGORIES —— 守卫失效，请同步更新本脚本`);
} else if (!frontend) {
  report(`${MP_PAGE} 里找不到 CATEGORIES —— 守卫失效，请同步更新本脚本`);
} else {
  // 前端多一个「全部」（id 为空串）是**正常**的：它是筛选 UI 的伪分类，不入库
  const frontendReal = new Map([...frontend].filter(([id]) => id !== ''));

  for (const [id, name] of backend) {
    if (!frontendReal.has(id)) {
      report(
        `后端分类「${name}」(${id}) 在前端 CATEGORIES 里不存在 —— ` +
          '用户在界面上选不到这个分类，该分类下的任务永远查不到',
      );
    } else if (frontendReal.get(id) !== name) {
      report(
        `分类 ${id} 的名称不一致：后端「${name}」 vs 前端「${frontendReal.get(id)}」—— ` +
          '同一分类在两边显示成不同名字，用户会以为是两个分类',
      );
    }
  }

  for (const [id, name] of frontendReal) {
    if (!backend.has(id)) {
      report(
        `前端分类「${name}」(${id}) 在后端 SERVICE_CATEGORIES 里不存在 —— ` +
          '点进去必然查不到任何任务（外键也对不上），且看起来像"还没人发布"',
      );
    }
  }

  // 前端缺「全部」伪分类时，筛选栏会没有"取消筛选"的入口
  if (!frontend.has('')) {
    report(`${MP_PAGE} 的 CATEGORIES 缺少 id 为空串的「全部」项 —— 筛选栏将无法取消筛选`);
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ backend: [...(backend ?? [])], frontend: [...(frontend ?? [])], problems }, null, 2));
} else if (problems.length === 0) {
  console.log(
    `✅ 服务分类前后端一致：后端 ${backend.size} 个 / 前端 ${frontend.size} 个（含「全部」伪分类）`,
  );
} else {
  console.log(`❌ 服务分类前后端不一致（${problems.length} 处）：\n`);
  for (const p of problems) console.log(`  · ${p}`);
}

process.exit(problems.length === 0 ? 0 : 1);
