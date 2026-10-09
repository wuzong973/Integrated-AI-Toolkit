#!/usr/bin/env node
/**
 * 静态守卫：AI 产出质量标准的"防漂移"检查
 *
 * ## 它拦的是哪一类问题
 *
 * 质量标准很容易变成"文档里写 A、提示词写 B、渲染器做 C"的三份漂移：
 * 文档承诺 3000 字，提示词没提，模型写 800 字，用户在结果页才发现太短 ——
 * 而**没有任何一步报错**。本脚本把三处对账，让漂移在 CI 阶段就失败。
 *
 * ## 检查项
 *
 *   ① 质量标准文件存在，且阈值与文档描述一致（字数下限被文档引用）
 *   ② 五类文档的 system prompt 都调用了 contentRules（字数/要素约束真的注入了）
 *   ③ PPT 提示词引用了 chartGuideText 与图表类型清单（图表选用逻辑真的注入了）
 *   ④ 执行器接入了 analyzeContent / analyzeDeck（生成后有质检，不是"写完就算"）
 *   ⑤ 图表类型枚举包含多样性的最小集合（bar/line/pie 之外确有扩充）
 *
 * 静态解析源码，零依赖、秒级完成；退出码非 0 表示标准与实现漂移。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const failures = [];
const ok = (msg) => console.log(`✅ ${msg}`);
const fail = (msg) => {
  failures.push(msg);
  console.error(`❌ ${msg}`);
};

// ---------- ① 标准与文档 ----------
const standard = read('packages/core/src/quality/standard.ts');
const docPath = 'docs/dev/AI-OUTPUT-QUALITY-STANDARD.md';
let doc = '';
try {
  doc = read(docPath);
} catch {
  fail(`缺少质量标准文档：${docPath}`);
}
if (doc) {
  for (const key of ['3000', '2200', '1200', '900', '2000']) {
    if (!doc.includes(key)) fail(`文档未写明字数下限 ${key}`);
  }
  if (!doc.includes('85')) fail('文档未写明综合分验收线 85');
  ok('质量标准文档覆盖字数下限与验收线');
}
for (const name of [
  'CONTENT_MIN_CHARS',
  'REQUIRED_SECTIONS',
  'MIN_LAYOUT_KINDS',
  'MIN_CHART_KINDS',
  'MAX_CHART_COLORS',
  'ACCEPTANCE',
]) {
  if (!standard.includes(name)) fail(`quality/standard.ts 缺少 ${name}`);
}
ok('核心标准常量为单一事实来源');

// ---------- ② 文档提示词真的注入了约束 ----------
const docSpecs = read('apps/api/src/modules/job/document-specs.ts');
if (!docSpecs.includes('contentRules(')) {
  fail('document-specs.ts 未调用 contentRules，字数与要素约束不会进提示词');
}
const systemHits = (docSpecs.match(/contentRules\('/g) ?? []).length;
if (systemHits < 5) fail(`只有 ${systemHits} 类文档注入 contentRules，应为 5 类`);
else ok(`${systemHits} 类文档提示词均已注入字数与要素约束`);
if (!docSpecs.includes("from '@qz/core'")) {
  fail('document-specs.ts 未从 @qz/core 取标准，存在两套阈值漂移风险');
}

// ---------- ③ PPT 提示词注入了图表选用逻辑 ----------
const executor = read('apps/api/src/modules/job/tool-executor.service.ts');
if (!executor.includes('chartGuideText(')) {
  fail('tool-executor.service.ts 未引用 chartGuideText，模型不知道图表选用逻辑');
} else {
  ok('PPT 提示词已注入图表选用逻辑');
}
if (!executor.includes('PPT_CHART_GUIDE')) {
  fail('PPT 提示词与 core 的图表指南未同源');
}
if (!executor.includes('analyzeDeck(')) {
  fail('generate_ppt 未接入 analyzeDeck，版式与图表质量无质检');
} else {
  ok('PPT 生成已接入视觉与图表质检');
}

// ---------- ④ 文本链路接入了内容质检 ----------
// 扫描**整条链路**而不是某个固定文件：质检与自修复的调用点在 2026-09-20
// 从 llm-tool-runner.ts 移到了 content-refine.ts / llm-run-chain.ts。
// 硬编码单个文件与 check-ai-capabilities 第 ⑥ 项是同一个毛病 ——
// 代码一重构，守卫就误报「未接入」，而链路其实是通的。
const LLM_CHAIN_FILES = [
  'apps/api/src/modules/job/llm-tool-runner.ts',
  'apps/api/src/modules/job/llm-run-chain.ts',
  'apps/api/src/modules/job/content-refine.ts',
];
const llmChain = LLM_CHAIN_FILES.map((f) => read(f)).join('\n');
// analyzeContent 是质检本体：任一文件出现即可（编排在 refine、调用在 run-chain）
const hasQc = LLM_CHAIN_FILES.some((f) => read(f).includes('analyzeContent('));
if (!hasQc) {
  fail('文本链路未接入 analyzeContent（质检与自修复），短文案不会被发现');
} else {
  ok('文本链路已接入内容质检与自修复');
}
if (!llmChain.includes('qualityDocType')) {
  fail('文本链路缺少 qualityDocType，质检维度无法按文档类型区分');
}
// 自修复闭环：必须真的把扣分项回灌给模型（只有判定没有反馈提示词就是半截）
if (!llmChain.includes('buildRefinePrompt')) {
  fail('缺少 buildRefinePrompt：质检不达标时无法把扣分项回灌重写');
} else {
  ok('质检不达标时会带反馈重写（self-refine 闭环完整）');
}

// ---------- ⑤ 图表类型确有扩充 ----------
// 图表类型已从 types.ts 拆到 ppt.types.ts（两者都读，避免拆分后守卫失效）
const types = read('packages/core/src/providers/types.ts') + read('packages/core/src/providers/ppt.types.ts');
const requiredTypes = ['bar', 'line', 'pie', 'area', 'radar', 'scatter', 'bubble', 'doughnut'];
const missing = requiredTypes.filter((t) => !new RegExp(`'${t}'`).test(types));
if (missing.length) fail(`图表类型缺少：${missing.join('、')}`);
else ok(`图表类型已覆盖 ${requiredTypes.length} 种以上`);

const style = read('apps/api/src/infra/providers/ppt/ppt-chart-style.ts');
if (!style.includes('typeOptions')) fail('图表样式未按类型差异化，样式仍单一');
else ok('图表渲染已按类型差异化');

// ---------- ⑥ 真实数据链路（上传表格 → 真实图表）----------
const dataSource = read('apps/api/src/modules/job/ppt-data-source.ts');
const tableChart = read('apps/api/src/modules/job/table-chart.ts');
if (!executor.includes('loadPptDataSource(')) {
  fail('generate_ppt 未接入 loadPptDataSource，上传的表格不会进图表');
} else {
  ok('PPT 生成已接入真实数据源');
}
if (!executor.includes('numericColumnNames(')) {
  fail('提示词未拿到真实数值列名，模型仍可能编数字');
}
// 诚实性：没有 caption 时必须仍标示例数据（真实与示例必须可辨）
if (!style.includes("meta.caption?.trim() || '示例数据")) {
  fail('图表标注未按 caption 区分来源，真实数据与示例数据可能被混淆');
} else {
  ok('图表标注按来源区分（真实数据标来源，其余标示例数据）');
}
if (!tableChart.includes('chartFromTable(')) {
  fail('表格 → 图表抽取函数缺失或改名，守卫需同步');
}
if (!dataSource.includes('return undefined')) {
  fail('数据源加载缺少降级分支，可能因附件问题让整个 PPT 失败');
} else {
  ok('真实数据链路可降级（画不出图时回落文字页，不阻断生成）');
}
// ---------- 结果 ----------
console.log('');
if (failures.length) {
  console.error(`❌ AI 产出质量守卫失败：${failures.length} 项`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('✅ AI 产出质量守卫通过：标准 / 提示词 / 质检 / 图表类型四处一致');
