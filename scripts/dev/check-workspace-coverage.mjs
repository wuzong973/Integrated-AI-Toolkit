#!/usr/bin/env node
/**
 * 工作区覆盖守卫（排查报告 P2-8）
 *
 * ## 为什么需要它
 *
 * `apps/admin`（管理后台）目前只有 1 个文件（README），而根 `build` / `typecheck`
 * 脚本只覆盖 core / sdk / api —— **不含 admin**。
 * 这本身没问题（还没开工），问题在于：等它开工后，如果忘了把它加进去，
 * **这个缺口永远不会被自动化发现** —— 因为"没被包含"恰恰意味着"不会被检查"。
 *
 * 这类"沉默的遗漏"是 CI 最典型的盲区，所以用两条显式断言把它变成可查的失败：
 *
 * 1. **已开工就必须纳入门禁**：任何有 `package.json` 的工作区，
 *    都必须出现在根 `typecheck` 与 `build` 链里（`-w <name>` 或直接引用其目录）。
 * 2. **有测试就必须能跑到**：工作区里存在 `*.spec.ts`，但 `vitest.config.ts`
 *    的 `include` 模式匹配不到它的目录 → 那些测试**永远不会执行**，
 *    而 `npm test` 依然全绿（因为根本没收集到）。这比失败更危险。
 *
 * ## 用法
 *
 *   node scripts/dev/check-workspace-coverage.mjs [--json]
 *
 * 退出码非 0 表示存在"已开工但未纳入构建 / 测试跑不到"的工作区。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

/** 收集 `apps/*` 与 `packages/*` 下真正有 package.json 的工作区 */
function listWorkspaces() {
  const out = [];
  for (const group of ['apps', 'packages']) {
    const dir = join(ROOT, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const pkgPath = join(dir, name, 'package.json');
      if (!existsSync(pkgPath) || !statSync(pkgPath).isFile()) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      out.push({ dir: `${group}/${name}`, name: pkg.name ?? `${group}/${name}` });
    }
  }
  return out;
}

/** 递归找出目录下所有 spec 文件（跳过 node_modules / dist） */
function findSpecs(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) findSpecs(p, out);
    else if (name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {};
/** 只看这两条用 `-w` 组织的门禁；`lint` 是全仓库 eslint 扫描，天然覆盖 */
const GATES = ['typecheck', 'build'];

/**
 * 该工作区是否被某个门禁覆盖。
 *
 * 判据放宽到"脚本文本里出现包名或目录名" —— 因为项目里存在两种合法写法：
 *   · `npm run typecheck -w @qz/core`（包名）
 *   · `npm run typecheck:mp` → `tsc -p apps/mp/tsconfig.json`（目录）
 * 只认其中一种会把另一种误报成缺口。
 */
function coveredBy(gate, ws) {
  const src = scripts[gate] ?? '';
  // 门禁可能指向子脚本（typecheck:mp），把子脚本正文也算进来
  const expanded = src.replace(/npm run ([\w:-]+)/g, (m, k) => `${m} ${scripts[k] ?? ''}`);
  return expanded.includes(ws.name) || expanded.includes(ws.dir);
}

/** 该工作区的 spec 文件是否能被 vitest 的 include 模式收集到 */
function vitestCovers(ws) {
  const cfg = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
  const m = /include:\s*\[([^\]]*)\]/.exec(cfg);
  if (!m) return null; // 解析不到就不下结论，避免误报
  const patterns = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const specs = findSpecs(join(ROOT, ws.dir));
  if (!specs.length) return true; // 没有测试文件，无所谓
  // 用一个"必然存在的相对路径"去比对模式前缀（只做前缀/目录级判断，不引入 glob 依赖）
  return patterns.some((p) => {
    const prefix = p.split('*')[0]; // 例如 'apps/api/src/' 或 'packages/'
    return `${ws.dir}/`.startsWith(prefix) || prefix.startsWith(`${ws.dir}/`);
  });
}

const problems = [];
const rows = [];

for (const ws of listWorkspaces()) {
  const missingGates = GATES.filter((g) => !coveredBy(g, ws));
  const vitest = vitestCovers(ws);
  rows.push({ ...ws, missingGates, vitestOk: vitest });

  if (missingGates.length) {
    problems.push(
      `${ws.dir}（${ws.name}）已开工，但未被门禁覆盖：${missingGates.join(' / ')}。` +
        `请在根 package.json 的对应脚本里加上它（\`-w ${ws.name}\` 或引用其目录）—— ` +
        '漏掉后这个工作区**永远不会被检查**，且不会有任何报错',
    );
  }
  if (vitest === false) {
    problems.push(
      `${ws.dir} 下有 spec 文件，但 vitest.config.ts 的 include 模式收集不到它 → ` +
        '这些测试**永远不会执行**，而 `npm test` 依然全绿（因为根本没收集到）。' +
        `请在 include 里补上 \`${ws.dir}/**/*.spec.ts\``,
    );
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rows, problems }, null, 2));
} else if (problems.length === 0) {
  console.log(
    `✅ 工作区覆盖完整：${rows.length} 个已开工工作区均已纳入 ${GATES.join(' / ')}，` +
      '且测试目录能被 vitest 收集到',
  );
} else {
  console.log(`❌ 存在"已开工但未纳入构建 / 测试跑不到"的工作区（${problems.length} 处）：\n`);
  for (const p of problems) console.log(`  · ${p}`);
}

process.exit(problems.length === 0 ? 0 : 1);
