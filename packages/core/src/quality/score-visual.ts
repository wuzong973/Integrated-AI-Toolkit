/**
 * PPT 视觉与图表的可量化评分
 *
 * 与 `score.ts`（内容维度）分开成文件，原因是两者判据完全不同：
 * 内容看"写了多少、写全没有"，视觉看"版式是否同构、留白是否够、图表是否单一"。
 * 放在一起会让单文件顶穿 300 行红线，也会让"文案短"和"版式单调"两个问题
 * 在代码里纠缠不清 —— 它们需要完全不同的改进措施。
 */
import type { PptSlideLayout, PptSlideSpec } from '../providers/types';

import {
  ACCEPTANCE,
  DECK_DIVERSITY_MIN_PAGES,
  MAX_ADJACENT_SAME_LAYOUT,
  MAX_CHART_CATEGORIES,
  MAX_CHART_COLORS,
  MAX_CHART_SERIES,
  MAX_CONTENT_AREA_RATIO,
  MIN_CHART_KINDS,
  MIN_LAYOUT_KINDS,
  QUALITY_WEIGHTS,
  gradeOf,
  ratioTo,
} from './standard';
import type { ChartQualityReport, VisualQualityReport } from './score';

/** 各版式的正文区占画布面积（16:9，数据来自 `ppt-layouts.ts` 的 BODY 常量） */
const BODY_AREA_RATIO: Record<PptSlideLayout, number> = {
  bullets: 0.72,
  twoCol: 0.72,
  stat: 0.7,
  quote: 0.55,
  chart: 0.76,
  section: 0.2,
};

/** 单页有效版式：数据不足会降级，所以按"能开画的版式"折算，而不是模型说的版式 */
export function effectiveLayout(slide: PptSlideSpec): PptSlideLayout {
  const raw = slide.layout;
  if (!raw) return slide.chart?.series?.length ? 'chart' : 'bullets';
  return hasDataFor(raw, slide) ? raw : 'bullets';
}

/** 版式能否开画的数据条件（与 ppt-layouts.ts 的 REQUIREMENT 同判据） */
function hasDataFor(layout: PptSlideLayout, slide: PptSlideSpec): boolean {
  switch (layout) {
    case 'stat':
      return !!slide.stat?.value?.trim();
    case 'quote':
      return !!slide.quote?.text?.trim();
    case 'chart':
      return !!slide.chart?.series?.length;
    case 'twoCol':
      return (slide.bullets?.length ?? 0) >= 2;
    default:
      return true;
  }
}

/** 相邻同版式最长连排：3 页连着长一样，读者会以为没翻页 */
export function maxAdjacentRepeat(layouts: readonly PptSlideLayout[]): number {
  let best = 0;
  let run = 0;
  let prev: PptSlideLayout | undefined;
  for (const l of layouts) {
    run = l === prev ? run + 1 : 1;
    prev = l;
    best = Math.max(best, run);
  }
  return best;
}

export function scoreVisual(slides: readonly PptSlideSpec[]): VisualQualityReport {
  const layouts = slides.map(effectiveLayout);
  const kinds = [...new Set(layouts)];
  const needsDiversity = slides.length >= DECK_DIVERSITY_MIN_PAGES;
  const diversityTarget = needsDiversity ? MIN_LAYOUT_KINDS : 1;
  const diversityRate = ratioTo(kinds.length, diversityTarget);

  const repeat = maxAdjacentRepeat(layouts);
  const biggestBody = Math.max(0, ...layouts.map((l) => BODY_AREA_RATIO[l]));

  const score = Math.round(
    (diversityRate * 0.5 +
      ratioTo(MAX_ADJACENT_SAME_LAYOUT, Math.max(1, repeat)) * 0.3 +
      ratioTo(MAX_CONTENT_AREA_RATIO, Math.max(0.01, biggestBody)) * 0.2) *
      100,
  );

  const issues: string[] = [];
  if (needsDiversity && kinds.length < MIN_LAYOUT_KINDS) {
    issues.push(`版式单一：仅 ${kinds.length} 种（目标 ≥${MIN_LAYOUT_KINDS}）`);
  }
  if (repeat > MAX_ADJACENT_SAME_LAYOUT) issues.push(`相邻同版式连排 ${repeat} 页`);
  if (biggestBody > MAX_CONTENT_AREA_RATIO) issues.push('留白不足：内容区占比过高');

  return {
    score,
    layoutKinds: kinds,
    layoutDiversityRate: Number(diversityRate.toFixed(2)),
    maxAdjacentRepeat: repeat,
    bodyAreaRatio: Number(biggestBody.toFixed(2)),
    issues,
  };
}

export function scoreCharts(slides: readonly PptSlideSpec[]): ChartQualityReport {
  const charts = slides.map((s) => s.chart).filter((c): c is NonNullable<typeof c> => !!c?.series.length);
  if (charts.length === 0) {
    return { chartKindCount: 0, chartDiversityRate: 1, colorCount: 0, issues: [] };
  }

  const kinds = [...new Set(charts.map((c) => c.type))];
  // 只有一张图时不谈'多样性'——那是无意义的苛求；两张以上才要求换形态
  const diversityTarget = charts.length >= 2 ? MIN_CHART_KINDS : 1;
  const diversityRate = ratioTo(kinds.length, diversityTarget);
  const maxSeries = Math.max(...charts.map((c) => c.series.length));
  const maxCategories = Math.max(...charts.map((c) => c.categories.length));
  const colorCount = Math.min(MAX_CHART_COLORS, Math.max(maxSeries, kinds.length));

  const issues: string[] = [];
  if (charts.length >= 2 && kinds.length < MIN_CHART_KINDS) {
    issues.push(`图表类型单一：仅 ${kinds.length} 种`);
  }
  if (maxSeries > MAX_CHART_SERIES) issues.push(`单图系列过多（${maxSeries}），建议分面或改表格`);
  if (maxCategories > MAX_CHART_CATEGORIES) issues.push(`类目过多（${maxCategories}），建议 Top-N`);

  return {
    chartKindCount: kinds.length,
    chartDiversityRate: Number(diversityRate.toFixed(2)),
    colorCount,
    issues,
  };
}

/** 综合分：内容 45 / 多样性 30 / 一致性 25，一致性不满分即整体不通过 */
export function combineScores(
  contentScore: number,
  visual: VisualQualityReport,
  charts: ChartQualityReport,
): { overall: number; grade: ReturnType<typeof gradeOf>; passed: boolean; diversity: number; consistency: number } {
  const diversity =
    visual.layoutDiversityRate * 0.7 + charts.chartDiversityRate * 0.3;
  const consistency =
    visual.maxAdjacentRepeat <= MAX_ADJACENT_SAME_LAYOUT && visual.bodyAreaRatio <= MAX_CONTENT_AREA_RATIO
      ? 1
      : 0.5;
  const overall = Math.round(
    contentScore * (QUALITY_WEIGHTS.completeness / 100) +
      diversity * 100 * (QUALITY_WEIGHTS.diversity / 100) +
      consistency * 100 * (QUALITY_WEIGHTS.consistency / 100),
  );
  const passed =
    overall >= ACCEPTANCE.minOverallScore &&
    contentScore >= ACCEPTANCE.minCompleteness &&
    diversity >= ACCEPTANCE.minDiversityRate &&
    consistency >= ACCEPTANCE.requireConsistency;
  return { overall, grade: gradeOf(overall), passed, diversity, consistency };
}
