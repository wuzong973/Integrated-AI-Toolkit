/**
 * 静态守卫：文档里的「工具条目数」口径必须与 seed.ts 一致
 *
 * ## 为什么需要它
 *
 * 2026-09-18 交付可用性排查报告把 `GET /api/v1/tools` 返回的 **33** 条
 * 写成了「seed 实测 33 条」—— 而 33 其实是**用户可见**口径
 *（接口默认 `where: { visible: true }`，见 `tool.service.ts`），
 * seed 里实际有 **41** 条（33 可见 + 8 个 Agent 内部工具）。
 *
 * 这个错数字随后被抄进 README、任务清单、设计文档和排查面板，
 * 而**没有任何机制能发现** —— 文档不参与编译，也没有测试覆盖。
 * 更糟的是它还被当成结论用：「缺 9 个工具会外键失败，必须先补分类行」，
 * 而 `campus` / `system` 分类在 seed.ts 里**早就定义了**（`visible: false`）。
 *
 * 所以本守卫做一件很窄的事：**把 seed.ts 当唯一权威，文档里凡是在说
 * "工具总数"的数字都必须与它一致。**
 *
 * ## 为什么判定范围刻意收窄
 *
 * 只匹配"在说总数"的措辞（`共 N 个工具` / `N 个工具条目` / `工具总数 N` …）。
 * **不匹配** `注册 6 个工具` 这类"某批次的数量"—— 那是另一个语义，
 * 强行统一反而会把对的数字改错。守卫宁可漏报，不可误报。
 *
 * ## 豁免
 *
 * 设计文档里的 `共 37 个工具` 说的是**设计清单**（37 个规划项），
 * 与"平台现有工具数"是两回事 —— 这类必须进 ALLOWLIST 并写清原因。
 * 若某条豁免已不在文档中出现，本守卫会反向提示"豁免已失效"，防止清单腐化。
 *
 * ## 用法
 *
 *   node scripts/dev/check-doc-counts.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

// ---------- ① 从 seed.ts 取权威口径 ----------
const seedSrc = readFileSync(resolve(ROOT, 'apps/api/prisma/seed.ts'), 'utf8');

/** 只取 TOOLS 数组那一段，避免误匹配 TOOL_CATEGORIES / DEMO_USERS */
function sliceArray(src, decl) {
  const start = src.indexOf(decl);
  if (start === -1) throw new Error(`seed.ts 里找不到 ${decl}`);
  const end = src.indexOf('\nconst ', start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

const toolsSrc = sliceArray(seedSrc, 'const TOOLS = [');
const toolCatsSrc = sliceArray(seedSrc, 'const TOOL_CATEGORIES = [');

/**
 * 工具条目：每个 `{ ... }` 是一块，逐块取 name / status / visible。
 * ⚠️ 换行必须用 `\r?\n` —— 本仓库在 Windows 上编辑，文件是 CRLF，
 * 只写 `\n` 会切不出任何一块（实测踩到：工具数解析成 0）。
 */
function parseTools(src) {
  const blocks = src.split(/\r?\n {2}\{\r?\n/).slice(1);
  return blocks
    .map((b) => ({
      name: (b.match(/name: '([a-z_]+)'/) ?? [])[1],
      status: (b.match(/status: '(active|planned)'/) ?? [])[1],
      internal: /visible: false/.test(b),
    }))
    .filter((t) => t.name);
}

const tools = parseTools(toolsSrc);
const CANON = {
  total: tools.length,
  visible: tools.filter((t) => !t.internal).length,
  internal: tools.filter((t) => t.internal).length,
  active: tools.filter((t) => t.status === 'active').length,
  planned: tools.filter((t) => t.status === 'planned').length,
  categories: (toolCatsSrc.match(/^\s*\{ id: '/gm) ?? []).length,
  visibleCategories: (toolCatsSrc.match(/visible: false/g) ?? []).length,
};
CANON.visibleCategories = CANON.categories - CANON.visibleCategories;

/**
 * 权威口径只认一个数：`total`。
 * 其余（visible / internal / active / planned）是它的分解，仅供错误提示时说明。
 */
const CANONICAL = CANON.total;

// ---------- ② 判定规则：只在"说总数"的措辞上生效 ----------
const RULES = [
  { id: '共N个工具', re: /共\s*(\d+)\s*个工具/g },
  { id: 'N个工具条目', re: /(\d+)\s*(?:个|条)工具条目/g },
  { id: '工具总数N', re: /工具总数[^0-9\n]{0,8}(\d+)/g },
  { id: 'N个工具可浏览', re: /(\d+)\s*个工具可浏览/g },
  { id: '工具数N', re: /工具数[^0-9\n]{0,10}?(\d+)\s*个/g },
  { id: 'N个工具中', re: /(\d+)\s*个工具中/g },
];

// ---------- ③ 扫描范围 ----------
/** 归档文档按仓库规范不改，故不扫 */
const SKIP_DIRS = ['docs/product/archive'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = full.replace(/\\/g, '/').replace(`${ROOT.replace(/\\/g, '/')}/`, '');
    if (SKIP_DIRS.some((d) => rel.startsWith(d))) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(md|html)$/.test(entry)) out.push({ rel, full });
  }
  return out;
}

const targets = [{ rel: 'README.md', full: resolve(ROOT, 'README.md') }, ...walk(resolve(ROOT, 'docs'))];

// ---------- ④ 豁免清单 ----------
/**
 * 每条必须写清"为什么这个数字和 seed 不一致是对的"。
 * 一旦文档里不再出现该片段，守卫会提示"豁免已失效"—— 防止清单腐化。
 */
const ALLOWLIST = [
  {
    file: 'docs/product/青智校园_小程序详细设计文档_V2.md',
    snippet: '共 37 个工具',
    reason: '描述的是**设计清单**（37 个规划项），不是平台现有工具数；实际以 seed.ts 为准',
  },
  {
    file: 'docs/product/青智校园_小程序详细设计文档_V2.md',
    snippet: '工具数少，37 个',
    reason: '同上：论证"前端本地检索够用"时引用的设计清单规模',
  },
  {
    file: 'docs/dev/AI-CAPABILITY-DISPATCH.md',
    snippet: '共 6 个工具',
    reason:
      '说的是 **`campus` 这一个分类**下的工具条数（`seed.ts` 的 `TOOL_CATEGORIES` 分类计数），' +
      '不是平台工具总数 —— 该分类共 6 个、其中只接了 2 个能力，正是这段话要论证的点。' +
      '两侧数字都随实现变化，无法用"改成本行的权威值 41"来修（那会把分类数说成总数，制造新的错误）。',
  },
];

const isAllowed = (file, snippet) =>
  ALLOWLIST.some((a) => a.file === file && snippet.includes(a.snippet));

// ---------- ⑤ 比对 ----------
const problems = [];
const hitAllow = new Set();

for (const { rel, full } of targets) {
  const lines = readFileSync(full, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (const m of line.matchAll(rule.re)) {
        const n = Number(m[1]);
        if (n === CANONICAL) continue;
        if (isAllowed(rel, line)) {
          for (const a of ALLOWLIST) if (a.file === rel && line.includes(a.snippet)) hitAllow.add(a);
          continue;
        }
        problems.push(
          `${rel}:${i + 1}  [${rule.id}] 写的是 ${n}，权威口径是 ${CANONICAL}\n` +
            `      ${line.trim().slice(0, 120)}`,
        );
      }
    }
  });
}

// 5.1 豁免失效反查
for (const a of ALLOWLIST) {
  if (!hitAllow.has(a)) {
    problems.push(
      `豁免已失效：${a.file} 里已找不到「${a.snippet}」—— ` +
        '说明文档改过了，请从 ALLOWLIST 删掉这一条（不要留着让清单腐化）',
    );
  }
}

// ---------- ⑥ 输出 ----------
if (problems.length === 0) {
  console.log(
    `✅ 文档口径与 seed 一致：工具 ${CANON.total} 条` +
      `（用户可见 ${CANON.visible} / Agent 内部 ${CANON.internal}；` +
      `active ${CANON.active} / planned ${CANON.planned}）、` +
      `工具分类 ${CANON.categories} 个（可见 ${CANON.visibleCategories}）；` +
      `另有 ${ALLOWLIST.length} 处已登记的"不同语义"豁免`,
  );
  process.exit(0);
}

console.log(`❌ 发现 ${problems.length} 处口径问题：\n`);
for (const p of problems) console.log(`  · ${p}`);
console.log(
  `\n权威口径来自 apps/api/prisma/seed.ts：工具 ${CANON.total} 条` +
    `（可见 ${CANON.visible} + 内部 ${CANON.internal}）、分类 ${CANON.categories} 个。\n` +
    '改法：把文档里的数字改成 seed 的真实值；若那个数字**本来就不是**在说平台工具总数，\n' +
    '      请登记到 ALLOWLIST 并写清原因（不要为了让体检变绿而直接删条目）。',
);
process.exit(1);
