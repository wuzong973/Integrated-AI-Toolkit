/**
 * AI 产出质量评分器
 *
 * 与 `standard.ts` 同源：这里不重新定义任何阈值，只做"把产出量成数字"。
 * 三个维度各自独立可测，最后按 `QUALITY_WEIGHTS` 合成综合分 —— 这样
 * "文案太短"和"图表太单一"不会混成一个说不清的数字，改进措施才能对得上。
 *
 * 纯函数、无 IO、无端侧 API，因此提示词侧、执行器侧、守卫脚本与单测能共用同一份结论。
 */
import {
  ACCEPTANCE,
  MIN_DEPTH_LEVELS,
  MIN_ITEMS_PER_SECTION,
  MIN_PHRASE_DIVERSITY_RATIO,
  MIN_SENTENCE_LENGTH_STDDEV,
  gradeOf,
  minCharsFor,
  ratioTo,
  requiredSectionsFor,
  type QualityGrade,
} from './standard';

export interface ContentQualityReport {
  score: number;
  /** 是否达到完整性验收线 */
  passed: boolean;
  grade: QualityGrade;
  chars: number;
  minChars: number;
  sectionsFound: string[];
  sectionsMissing: string[];
  sectionCoverage: number;
  depthLevels: number;
  /** 文本专属指标：PPT deck 内容评分不适用，故可选 */
  sentenceLengthStdDev?: number;
  phraseDiversityRatio?: number;
  issues: string[];
}

export interface VisualQualityReport {
  score: number;
  layoutKinds: string[];
  layoutDiversityRate: number;
  maxAdjacentRepeat: number;
  bodyAreaRatio: number;
  issues: string[];
}

export interface ChartQualityReport {
  chartKindCount: number;
  chartDiversityRate: number;
  colorCount: number;
  issues: string[];
}

/** 去掉 Markdown 语法后统计正文字符数，避免"用标题符号凑字数" */
export function countContentChars(markdown: string): number {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[|>`*_~]/g, '')
    .replace(/\s+/g, '')
    .length;
}

/** 句子长度标准差：全篇句长一个样，读起来就是"单调" */
export function sentenceLengthStdDev(text: string): number {
  const sentences = text
    .split(/[。！？!?；;\n]+/)
    .map((s) => s.replace(/\s/g, ''))
    .filter((s) => s.length >= 2);
  if (sentences.length < 2) return 0;
  const lens = sentences.map((s) => s.length);
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
  return Math.sqrt(variance);
}

/**
 * 二元词组去重率：越低说明越像在复读同一批词。
 *
 * 统计连续两个字组成的词组有多少比例是"新出现"的。比单字去重率稳健：
 * 中文单字集合小，正常长文也会迅速饱和；词组能真实反映表达的多样性。
 */
export function phraseDiversityRatio(text: string): number {
  const s = text.replace(/[\s|>`*_~#-]/g, '');
  if (s.length < 2) return 0;
  const grams: string[] = [];
  for (let i = 0; i < s.length - 1; i += 1) grams.push(s.slice(i, i + 2));
  return new Set(grams).size / grams.length;
}

/** 结构深度：一级标题 / 二级标题 / 列表 / 表格四类信号各记一层 */
export function depthLevelsOf(markdown: string): number {
  const signals = [
    /^#\s+/m.test(markdown),
    /^#{2,6}\s+/m.test(markdown),
    /^\s*([-*+]|\d+[.)])\s+/m.test(markdown),
    /^\s*\|.*\|\s*$/m.test(markdown),
  ];
  return signals.filter(Boolean).length;
}

/** 必备要素覆盖：先看标题行，标题没命中再全文兜底（防止同义改写被误判缺项） */
export function sectionCoverageOf(
  markdown: string,
  required: readonly string[],
): { found: string[]; missing: string[] } {
  const headings = markdown
    .split('\n')
    .filter((l) => /^\s*#{1,6}\s+/.test(l))
    .join('\n');
  const found: string[] = [];
  const missing: string[] = [];
  for (const key of required) {
    if (headings.includes(key) || markdown.includes(key)) found.push(key);
    else missing.push(key);
  }
  return { found, missing };
}

/** 每节实质信息条数（段落 / 列表项 / 表格行）——用于判断"只有标题没有内容" */
export function itemsPerSectionOf(markdown: string): number {
  const items = markdown
    .split('\n')
    .filter((l) => /^\s*([-*+]|\d+[.)])\s+/.test(l) || /^\s*\|.*\|\s*$/.test(l));
  const sections = markdown.split(/^\s*#{1,6}\s+/m).length - 1;
  if (sections <= 0) return items.length;
  return items.length / sections;
}

export function scoreContent(markdown: string, docType?: string): ContentQualityReport {
  const chars = countContentChars(markdown);
  const minChars = minCharsFor(docType);
  const required = requiredSectionsFor(docType);
  const { found, missing } = sectionCoverageOf(markdown, required);
  const stddev = sentenceLengthStdDev(markdown);
  const diversity = phraseDiversityRatio(markdown);
  const depth = depthLevelsOf(markdown);
  const itemsPerSection = itemsPerSectionOf(markdown);

  const lengthScore = ratioTo(chars, minChars);
  const coverageScore = ratioTo(found.length, required.length);
  const depthScore = ratioTo(depth, MIN_DEPTH_LEVELS);
  const detailScore = ratioTo(itemsPerSection, MIN_ITEMS_PER_SECTION);
  const rhythmScore = ratioTo(stddev, MIN_SENTENCE_LENGTH_STDDEV);
  const vocabScore = ratioTo(diversity, MIN_PHRASE_DIVERSITY_RATIO);

  const score = Math.round(
    (lengthScore * 0.3 +
      coverageScore * 0.3 +
      depthScore * 0.12 +
      detailScore * 0.16 +
      rhythmScore * 0.06 +
      vocabScore * 0.06) *
      100,
  );

  const issues: string[] = [];
  if (lengthScore < 1) issues.push(`篇幅不足：${chars}/${minChars} 字`);
  if (missing.length) issues.push(`缺少必备要素：${missing.join('、')}`);
  if (depth < MIN_DEPTH_LEVELS) issues.push('结构层级不足（缺二级标题 / 列表 / 表格）');
  if (itemsPerSection < MIN_ITEMS_PER_SECTION) issues.push('章节细节不足：每节实质信息偏少');
  if (stddev < MIN_SENTENCE_LENGTH_STDDEV) issues.push('表达单调：句长趋同');
  if (diversity < MIN_PHRASE_DIVERSITY_RATIO) issues.push('表达重复度偏高：句式或用词高度雷同');

  const hardFailed = chars < minChars || missing.length > 0;
  return {
    score,
    // ## 为什么不能只看加权总分（2026-09-20 实测踩坑）
    //
    // 一次真实生成得到 **90 分**，但篇幅只有 **2231/3000 字**，且每节细节不足 ——
    // 加权算法让"字数差 25%"被要素覆盖、结构层级等项补平了，于是 passed=true，
    // self-refine 因此**没有被触发**，用户拿到一份偏短的文档。
    //
    // 结论：**篇幅与必备要素是硬下限，不是可加权抵消的项**。
    // 用户要"一份 3000 字的计划书"，给他 2231 字就是没做到，
    // 不该因为"章节起得挺全"而算达标。表达节奏、用词多样性这类"锦上添花"项
    // 才适合参与加权。
    passed: score >= ACCEPTANCE.minCompleteness && !hardFailed,
    grade: gradeOf(score),
    chars,
    minChars,
    sectionsFound: found,
    sectionsMissing: missing,
    sectionCoverage: coverageScore,
    depthLevels: depth,
    sentenceLengthStdDev: Number(stddev.toFixed(2)),
    phraseDiversityRatio: Number(diversity.toFixed(3)),
    issues,
  };
}
