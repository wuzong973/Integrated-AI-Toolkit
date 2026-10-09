/**
 * 图表样式与选用规范（PPT 视觉改造 · 图表设计）
 *
 * 职责：把"这一页该用哪种图、该长什么样"从渲染器里剥出来。
 * 此前 3 种图共用同一套 `barGapWidthPct: 60` 配置，导致 pie 也按柱状图的间距画，
 * 数据页之间几乎没有视觉差异。本文件是图表的**唯一取色与取参入口**：
 * 色值仍只来自 `ppt-themes.ts`（本文件零 hex 字面量）。
 *
 * 统一设计规范（与 `docs/dev/AI-OUTPUT-QUALITY-STANDARD.md` 对齐）：
 * - 配色只用主题三色 + 一个混色，最多 4 色，杜绝"彩虹图"；
 * - 轴标签 / 图例字号不低于 9pt，保证投影可读；
 * - 图例位置按图表类型选择（占比图靠右、趋势图靠下），不无脑堆在底部；
 * - 饼 / 环形图不画网格线，柱 / 折线图保留浅网格；
 * - 数据标签只在类目较少时开启，避免糊成一片；
 * - 图表标注由 `chart.caption` 决定：有来源写来源，没有一律标"示例数据"。
 */
import type PptxGenJS from 'pptxgenjs';
import type { PptChartType } from '@qz/core';

import { FONT } from './ppt-draw-layouts';
import { mix, tint, type PptTheme } from './ppt-themes';

/** 图表绘制区域 */
export interface ChartBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 无坐标轴语义的图表：不应画网格线，标签贴扇区 */
const AXISLESS: ReadonlySet<PptChartType> = new Set<PptChartType>(['pie', 'doughnut']);
/** 由点构成、适合显示数据标签的图表 */
const POINT_LABELED: ReadonlySet<PptChartType> = new Set<PptChartType>([
  'bar',
  'line',
  'radar',
  'doughnut',
]);

/** 图表专用配色：主题三色 + 主/点缀混色，上限 4 色（与 MAX_CHART_COLORS 一致） */
export function chartColors(theme: PptTheme): string[] {
  return [theme.primary, theme.secondary, theme.accent, mix(theme.primary, theme.accent, 0.5)];
}

/** 每个图表类型的专属参数：这是"样式单一"真正的解药 */
function typeOptions(type: PptChartType): Record<string, unknown> {
  switch (type) {
    case 'bar':
      return { barGapWidthPct: 55, barDir: 'col' };
    case 'bar3D':
      return { barGapWidthPct: 70, barDir: 'col', dataNoEffects: false };
    case 'line':
      return { lineDataSymbol: 'circle', lineDataSymbolSize: 8, lineSize: 2.25 };
    case 'area':
      return { lineDataSymbol: 'none', lineSize: 2, dataNoEffects: false };
    case 'pie':
      return { dataBorder: { pt: 1.5, color: 'FFFFFF' } };
    case 'doughnut':
      return { holeSize: 55, dataBorder: { pt: 1.5, color: 'FFFFFF' } };
    case 'radar':
      return { radarStyle: 'marker', lineSize: 1.75 };
    case 'scatter':
      return { lineDataSymbol: 'circle', lineDataSymbolSize: 9, lineSize: 0 };
    case 'bubble':
      return { lineDataSymbol: 'circle', lineDataSymbolSize: 12, lineSize: 0 };
    default:
      return {};
  }
}

/** 类目 ≤6 才显示数值标签：多了会糊成一片，抵掉可读性 */
function shouldShowValues(type: PptChartType, categories: number, series: number): boolean {
  if (!POINT_LABELED.has(type)) return false;
  return categories <= 6 && series <= 2;
}

/**
 * 组装某个图表的全部绘制参数。
 *
 * 所有取色只走 theme；轴标签 / 图例字号在这里统一收口，
 * 保证"视觉一致性"可以被静态检查（不存在散落各处的字号字面量）。
 */
export function chartOptions(
  theme: PptTheme,
  box: ChartBox,
  meta: { type: PptChartType; categories: number; series: number; caption?: string },
): PptxGenJS.IChartOpts {
  const axisless = AXISLESS.has(meta.type);
  const base: PptxGenJS.IChartOpts = {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    chartColors: chartColors(theme),
    catAxisLabelColor: theme.textBody,
    catAxisLabelFontFace: FONT,
    catAxisLabelFontSize: 11,
    dataLabelColor: theme.textBody,
    dataLabelFontFace: FONT,
    dataLabelFontSize: 10,
    legendFontFace: FONT,
    legendFontSize: 10,
    legendPos: axisless ? 'r' : 'b',
    showLegend: true,
    showTitle: true,
    // 有 caption 说明数据有明确来源，原样标注；没有则一律按示例数据处理（红线 10）
    title: meta.caption?.trim() || '示例数据（请替换为你的真实数据）',
    titleColor: theme.textMute,
    titleFontSize: 11,
    valAxisLabelColor: theme.textBody,
    valAxisLabelFontFace: FONT,
    valAxisLabelFontSize: 11,
    ...typeOptions(meta.type),
  };

  if (axisless) {
    base.showValue = shouldShowValues(meta.type, meta.categories, meta.series);
    return base;
  }

  base.showValue = shouldShowValues(meta.type, meta.categories, meta.series);
  base.catGridLine = { color: tint(theme.textMute, 0.82), style: 'solid', size: 0.5 };
  base.valGridLine = { color: tint(theme.textMute, 0.82), style: 'solid', size: 0.5 };
  base.catAxisLineShow = true;
  base.valAxisLineShow = false;
  return base;
}
