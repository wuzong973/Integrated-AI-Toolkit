#!/usr/bin/env node
/**
 * 静态守卫：采样参数不得散落（Q9）
 *
 * ## 它拦的是哪一类问题
 *
 * 改造前 `temperature` 以字面量散落在 10 个调用点（0.1/0.2/0.3/0.4/0.6/0.7），
 * 而 `top_p` 全仓零使用。散落造成的不是"不好看"，而是三个具体问题：
 *
 * 1. **同类任务取值不一致** —— 意图识别在 `os.service` 用 0.1、
 *    在 `station-parse` 用 0.2，两者都是"结构化抽取"，差异没人解释过；
 * 2. **调优无法一次生效** —— 想把"抽取类"整体调稳，得翻遍全仓改 5 处；
 * 3. **新调用点无从参考** —— 下一个写工具的人只能猜"我该填几"。
 *
 * 现在参数集中在 `packages/core/src/providers/sampling.ts` 的档位表，
 * 调用方写 `sampling('create')` —— 表达的是**意图**（这是创作任务），
 * 而不是两个谜之数字。
 *
 * ## 检查项
 *
 *   ① `sampling.ts` 存在且含档位表（参数有唯一来源）；
 *   ② 除该文件外，源码里**不得出现 `temperature:` / `top_p:` 字面量**；
 *   ③ 每个档位都必须有 `topP`（只有 temperature 时采样长尾未截断）。
 *
 * ## 用法
 *
 *   node scripts/dev/check-sampling.mjs
 *
 * 退出码非 0 表示参数又散落了。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const SAMPLING_FILE = 'packages/core/src/providers/sampling.ts';

const failures = [];
const ok = (m) => console.log(`✅ ${m}`);
const fail = (m) => {
  failures.push(m);
  console.error(`❌ ${m}`);
};

/** 递归收集 .ts 文件（跳过测试与构建产物） */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// ---------- ① 档位表存在 ----------
let samplingSrc = '';
try {
  samplingSrc = readFileSync(resolve(ROOT, SAMPLING_FILE), 'utf8');
} catch {
  fail(`缺少 ${SAMPLING_FILE}：采样参数没有唯一来源`);
}
if (samplingSrc) {
  const profiles = ['extract', 'classify', 'grounded', 'plan', 'chat', 'create'];
  const missing = profiles.filter((p) => !new RegExp(`${p}:\\s*\\{`).test(samplingSrc));
  if (missing.length) fail(`sampling.ts 缺少档位：${missing.join('、')}`);
  else ok(`档位表完整（${profiles.length} 档）`);

  // ③ 每档必须有 topP
  const noTopP = profiles.filter((p) => {
    const m = new RegExp(`${p}:\\s*\\{([^}]*)\\}`).exec(samplingSrc);
    return m && !m[1].includes('topP');
  });
  if (noTopP.length) fail(`档位缺少 topP（长尾未截断）：${noTopP.join('、')}`);
  else ok('每档都配了 topP（与 temperature 配合才是完整的"稳"）');
}

// ---------- ② 源码不得散落字面量 ----------
const roots = ['apps/api/src', 'packages/core/src', 'apps/mp'];
const offenders = [];
for (const r of roots) {
  let files;
  try {
    files = collect(resolve(ROOT, r));
  } catch {
    continue;
  }
  for (const f of files) {
    const rel = f.replace(ROOT + '\\', '').replace(ROOT + '/', '').replace(/\\/g, '/');
    if (rel === SAMPLING_FILE) continue;
    const src = readFileSync(f, 'utf8');
    // 只认"赋值形态"的字面量：`temperature: 0.7` / `top_p: 0.9`
    // 注释与类型声明（`temperature?: number`）不受影响
    if (/\btemperature:\s*\d/.test(src) || /\btop_?[pP]:\s*0?\.\d/.test(src)) {
      offenders.push(rel);
    }
  }
}
if (offenders.length) {
  fail(
    `采样参数散落在 ${offenders.length} 个文件（应改用 sampling('档位')）：\n` +
      offenders.map((f) => `     - ${f}`).join('\n'),
  );
} else {
  ok('源码中无散落的 temperature / top_p 字面量');
}

// ---------- 结果 ----------
console.log('');
if (failures.length) {
  console.error(`❌ 采样参数守卫失败：${failures.length} 项`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('✅ 采样参数守卫通过：参数集中在档位表，调用方表达意图而非数字');