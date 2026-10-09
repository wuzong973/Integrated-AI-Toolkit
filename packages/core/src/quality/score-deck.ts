/**
 * PPT 内容质量评分（与文档内容评分分开）
 *
 * ## 为什么不能复用文档的 `scoreContent`
 *
 * 文档判据是"正文 ≥3000 字、覆盖九个章节"，而 PPT 一页正文上限只有几条要点：
 * 拿文档标准评 PPT，任何正常 deck 都会被打成 20 分，综合分永远不及格 ——
 * **指标本身错了，比没有指标更糟**，因为团队会开始无视它。
 *
 * PPT 内容的真实判据是另一套：
 * - 每个内容页是否有足够要点（≥3 条，否则是"标题页"而不是内容页）；
 * - 要点是否为完整句子（≥15 字，低于此值多是名词短语）；
 * - 是否有讲稿备注（交付级的 deck 需要能照着讲）；
 * - 是否有空页（空页占比过高说明结构注水）。
 */
import type { PptSlideSpec } from '../providers/types';

import {
  MAX_EMPTY_PAGE_RATIO,
  MIN_NOTES_COVERAGE,
  MIN_POINTS_PER_CONTENT_PAGE,
  MIN_POINT_LENGTH,
  gradeOf,
  ratioTo,
} from './standard';
import type { ContentQualityReport } from './score';

/** 内容页：排除章节过渡页 */
function contentPages(slides: readonly PptSlideSpec[]): PptSlideSpec[] {
  return slides.filter((s) => s.layout !== 'section');
}

/** 一页的"信息量"：要点数 + 图表按 1 条计 + 强调页数据按 1 条计 */
function informationCount(slide: PptSlideSpec): number {
  const bullets = (slide.bullets ?? []).filter((b) => b.trim()).length;
  const hasChart = (slide.chart?.series?.length ?? 0) > 0 ? 1 : 0;
  const hasStat = slide.stat?.value?.trim() ? 1 : 0;
  const hasQuote = slide.quote?.text?.trim() ? 1 : 0;
  return bullets + hasChart + hasStat + hasQuote;
}

/** 要点平均字数：过低通常是"名词短语堆砌" */
function averagePointLength(slides: readonly PptSlideSpec[]): number {
  const points = slides.flatMap((s) => (s.bullets ?? []).map((b) => b.trim()).filter(Boolean));
  if (points.length === 0) return 0;
  return points.reduce((a, b) => a + b.length, 0) / points.length;
}

/**
 * PPT 内容评分。
 *
 * 返回结构与文档版一致（都是 `ContentQualityReport`），这样调用方与日志格式统一，
 * 但判据完全不同 —— 这正是把它单独成函数的原因。
 */
export function scoreDeckContent(slides: readonly PptSlideSpec[]): ContentQualityReport {
  const pages = contentPages(slides);
  const joined = slides.map((s) => [s.title, ...(s.bullets ?? [])].join('\n')).join('\n');
  const chars = joined.replace(/\s/g, '').length;

  const infoCounts = pages.map(informationCount);
  const avgInfo = infoCounts.length
    ? infoCounts.reduce((a, b) => a + b, 0) / infoCounts.length
    : 0;
  const avgPointLen = averagePointLength(pages);
  const emptyPages = infoCounts.filter((c) => c === 0).length;
  const emptyRatio = pages.length ? emptyPages / pages.length : 0;
  const notesCoverage = pages.length
    ? pages.filter((s) => s.notes?.trim()).length / pages.length
    : 1;

  const infoScore = ratioTo(avgInfo, MIN_POINTS_PER_CONTENT_PAGE);
  const pointLenScore = ratioTo(avgPointLen, MIN_POINT_LENGTH);
  const notesScore = ratioTo(notesCoverage, MIN_NOTES_COVERAGE);
  const emptyScore = emptyRatio <= MAX_EMPTY_PAGE_RATIO ? 1 : ratioTo(MAX_EMPTY_PAGE_RATIO, emptyRatio);

  const score = Math.round(
    (infoScore * 0.4 + pointLenScore * 0.25 + notesScore * 0.2 + emptyScore * 0.15) * 100,
  );

  const issues: string[] = [];
  if (infoScore < 1) issues.push(`内容页信息量不足：平均 ${avgInfo.toFixed(1)} 条（目标 ≥${MIN_POINTS_PER_CONTENT_PAGE}）`);
  if (pointLenScore < 1) issues.push(`要点过短：平均 ${avgPointLen.toFixed(0)} 字（目标 ≥${MIN_POINT_LENGTH}），多为名词短语`);
  if (notesScore < 1) issues.push(`讲稿备注覆盖不足：${Math.round(notesCoverage * 100)}%（目标 ≥${MIN_NOTES_COVERAGE * 100}%）`);
  if (emptyScore < 1) issues.push(`空内容页偏多：${emptyPages}/${pages.length} 页`);

  return {
    score,
    passed: score >= 85,
    grade: gradeOf(score),
    chars,
    minChars: 0,
    sectionsFound: [],
    sectionsMissing: [],
    sectionCoverage: 1,
    depthLevels: slides.length >= 2 ? 2 : 1,
    sentenceLengthStdDev: 0,
    phraseDiversityRatio: 0,
    issues,
  };
}
