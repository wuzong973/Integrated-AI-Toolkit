/**
 * 静态守卫：小程序界面里不得出现"积分"字样
 *
 * ## 为什么需要它
 *
 * 免费开放期积分不参与任何扣费，界面上出现"积分"只会让用户困惑
 *（"我有 120 积分，为什么显示免费？"）。需求是**全站不出现"积分"二字**。
 *
 * 但"人肉搜一遍"是不可靠的：价格角标、费用行、失败提示、空态文案、
 * 账户页标题……散在十几个文件里，改漏一处就要等用户截图才能发现。
 * 所以把它做成机器可查的红线。
 *
 * ## 允许的例外
 *
 * `apps/mp/utils/billing.ts` —— 含"积分"二字的文案**唯一出口**。
 * 免费期这些文案所在的分支不渲染（`showPoints()` 为 false），
 * 而计费模式下它们必须存在。集中在这里还能让本脚本的断言足够简单。
 *
 * ## 注释不算
 *
 * 注释里出现"积分"不影响用户，且说明性注释提到它是必要的
 * （例如"免费期不能说'积分已退回'"）。所以按行过滤掉纯注释行。
 *
 * ## 用法
 *
 *   node scripts/dev/check-no-points-copy.mjs
 *
 * 退出码非 0 表示发现用户可见的"积分"字样。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const MP = join(ROOT, 'apps/mp');

/** 唯一允许出现"积分"字样的文件（相对仓库根） */
const ALLOWED = new Set(['apps/mp/utils/billing.ts']);

/** 纯注释行（不影响用户，允许出现"积分"） */
const COMMENT_ONLY = /^\s*(\/\/|\/\*|\*|<!--)/;

const NEEDLE = '积分';
const EXTS = ['.ts', '.wxml'];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      walk(p, out);
    } else if (EXTS.some((e) => name.endsWith(e))) {
      out.push(p);
    }
  }
  return out;
}

const hits = [];

for (const file of walk(MP)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (ALLOWED.has(rel)) continue;

  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (COMMENT_ONLY.test(line)) return;
    if (line.includes(NEEDLE)) {
      hits.push({ file: rel, line: i + 1, text: line.trim().slice(0, 110) });
    }
  });
}

if (hits.length === 0) {
  console.log('✅ 界面无"积分"字样（唯一出口：apps/mp/utils/billing.ts）');
  process.exit(0);
}

console.log(`❌ 发现 ${hits.length} 处用户可见的"积分"字样：\n`);
for (const h of hits) console.log(`  ${h.file}:${h.line}\n     ${h.text}`);
console.log(
  '\n改法：把文案挪到 apps/mp/utils/billing.ts（免费期不渲染的分支），' +
    '页面通过 showPoints() 控制显隐，不要直接在页面里写字面量。',
);
process.exit(1);
