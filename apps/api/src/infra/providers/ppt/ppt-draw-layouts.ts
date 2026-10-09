import type PptxGenJS from 'pptxgenjs';
import type { PptSlideLayout, PptSlideSpec } from '@qz/core';

import { BODY, BODY_W, PAGE, slidePoints } from './ppt-layouts';
import { chartOptions } from './ppt-chart-style';
import { mix, tint, type PptTheme } from './ppt-themes';

/**
 * 六种版式的画法（从 pptxgenjs.provider.ts 拆出：单文件 300 行红线）。
 *
 * 纪律与渲染器本体一致：
 * - 取色只走 theme（hex 全部集中在 ppt-themes.ts，本文件零色值字面量）；
 * - 所有文本框 `fit: 'shrink'` 防溢出；
 * - 空数据版式降级回 bullets、空页如实说明，绝不编内容（红线 10）；
 * - chart 标题"示例数据"与 stat 的"AI 估算"脚注是诚实标记，不许去掉。
 */

/** 中文字体：Windows/WPS 都有；缺失时 PowerPoint 自行回退，不会报错 */
export const FONT = 'Microsoft YaHei';
/** 每个文本框的公共兜底：防溢出 */
export const BASE_TEXT = { fontFace: FONT, fit: 'shrink' as const };

type Slide = PptxGenJS.Slide;

/** 一页画布（渲染期只读，故不挂实例字段 —— Provider 是单例，并发渲染会串色） */
export interface Page {
  readonly s: Slide;
  readonly theme: PptTheme;
  readonly spec: PptSlideSpec;
  readonly no: number;
  readonly total: number;
  readonly footer: string;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 内容页正文分发（section 由 provider 单独处理：它整页换底色，不叠页眉页脚） */
export function drawBody(page: Page, layout: PptSlideLayout): void {
  switch (layout) {
    case 'twoCol':
      drawTwoCol(page);
      break;
    case 'stat':
      drawStat(page);
      break;
    case 'quote':
      drawQuote(page);
      break;
    case 'chart':
      drawChart(page);
      break;
    default:
      drawBullets(page);
  }
}

/** bullets：整宽编号卡片行 —— 比"一串圆点"更能承重，也不会挤成蚂蚁字 */
function drawBullets(page: Page): void {
  const items = slidePoints(page.spec);
  if (!items.length) return drawEmpty(page);
  const box: Box = { x: BODY.x, y: BODY.top, w: BODY_W, h: BODY.bottom - BODY.top };
  const rowH = Math.min(1.15, box.h / items.length);
  items.forEach((text, i) => {
    drawCardRow(page, text, i + 1, { ...box, y: box.y + i * rowH, h: rowH - 0.16 });
  });
}

/** twoCol：前半左列、后半右列，中缝一条浅色竖线 */
function drawTwoCol(page: Page): void {
  const items = slidePoints(page.spec);
  if (items.length < 2) return drawBullets(page);
  const half = Math.ceil(items.length / 2);
  const gap = 0.42;
  const w = (BODY_W - gap) / 2;
  const h = BODY.bottom - BODY.top;
  [items.slice(0, half), items.slice(half)].forEach((list, i) => {
    const x = BODY.x + i * (w + gap);
    drawPanel(page, { x, y: BODY.top, w, h });
    const rowH = Math.min(1.05, (h - 0.4) / list.length);
    list.forEach((text, r) => {
      drawDotRow(page, text, { x: x + 0.28, y: BODY.top + 0.22 + r * rowH, w: w - 0.62, h: rowH - 0.1 });
    });
  });
  page.s.addShape('rect', {
    x: BODY.x + w + gap / 2 - 0.007,
    y: BODY.top + 0.3,
    w: 0.014,
    h: h - 0.6,
    fill: { color: tint(page.theme.secondary, 0.55) },
  });
}

/** stat：超大数字 + 一句话说明 + 右侧支撑要点；数字必带"AI 估算"标识（脚注在页脚统一挂） */
function drawStat(page: Page): void {
  const { s, theme, spec } = page;
  const stat = spec.stat;
  if (!stat) return drawBullets(page);
  s.addShape('rect', {
    x: 8.15,
    y: BODY.top - 0.15,
    w: PAGE.w - 8.15 - BODY.x,
    h: BODY.bottom - BODY.top + 0.3,
    fill: { color: mix(theme.bgPage, theme.primary, 0.06) },
  });
  s.addText(stat.value, {
    ...BASE_TEXT,
    x: BODY.x,
    y: 2.0,
    w: 7.2,
    h: 2.05,
    fontSize: 72,
    bold: true,
    color: theme.primary,
    valign: 'middle',
  });
  s.addShape('rect', { x: BODY.x + 0.02, y: 4.25, w: 1.05, h: 0.07, fill: { color: theme.accent } });
  s.addText(stat.label || '关键数字', {
    ...BASE_TEXT,
    x: BODY.x,
    y: 4.45,
    w: 6.9,
    h: 0.75,
    fontSize: 16,
    color: theme.textBody,
  });
  const items = slidePoints(spec).slice(0, 3);
  const rowH = 1.0;
  items.forEach((text, i) => {
    drawDotRow(page, text, {
      x: 8.45,
      y: BODY.top + 0.35 + i * rowH,
      w: PAGE.w - 8.45 - BODY.x,
      h: rowH - 0.14,
    });
  });
}

/** quote：左竖条 + 大字引言 + 署名 */
function drawQuote(page: Page): void {
  const { s, theme, spec } = page;
  const quote = spec.quote;
  if (!quote) return drawBullets(page);
  s.addText('“', {
    x: BODY.x + 0.1,
    y: 1.5,
    w: 1.5,
    h: 1.5,
    fontSize: 88,
    bold: true,
    color: tint(theme.primary, 0.72),
    fontFace: FONT,
  });
  s.addShape('rect', { x: BODY.x + 0.06, y: 2.75, w: 0.11, h: 2.7, fill: { color: theme.primary } });
  s.addText(quote.text, {
    ...BASE_TEXT,
    x: BODY.x + 0.45,
    y: 2.7,
    w: BODY_W - 0.9,
    h: 2.8,
    fontSize: 26,
    bold: true,
    color: theme.textTitle,
    lineSpacingMultiple: 1.3,
  });
  s.addText(quote.by ? `—— ${quote.by}` : '—— 观点', {
    ...BASE_TEXT,
    x: BODY.x + 0.45,
    y: 5.6,
    w: 6,
    h: 0.4,
    fontSize: 13,
    color: theme.textMute,
  });
}

/** chart：原生图表（可编辑）。标题里的"示例数据"是红线 10，不许去掉 */
function drawChart(page: Page): void {
  const { s, spec } = page;
  const chart = spec.chart;
  if (!chart) return drawBullets(page);
  const items = slidePoints(spec).slice(0, 2);
  items.forEach((text, i) => {
    drawDotRow(page, text, { x: BODY.x, y: BODY.top + i * 0.56, w: BODY_W, h: 0.48 });
  });
  const top = BODY.top + items.length * 0.56 + 0.15;
  const y = Math.min(top, 3.1);
  const options = chartOptions(
    page.theme,
    { x: BODY.x, y, w: BODY_W, h: Math.max(1.9, BODY.bottom - y) },
    {
      type: chart.type,
      categories: chart.categories.length,
      series: chart.series.length,
      // 真实数据来源随 chart 一起透传：渲染器据此决定标"来源"还是"示例数据"
      caption: chart.caption,
    },
  );
  // PptxGenJS 要的是 `{ labels, values }[]`（labels=类目轴）；契约里 series 用
  // `{ name, values }` 表达（name 进图例），这里做一次性转换 —— 直接透传会在
  // createExcelWorksheet 里读 undefined.labels.length 崩掉（冒烟测试抓到的真雷）。
  s.addChart(
    chart.type,
    chart.series.map((ser) => ({ name: ser.name, labels: chart.categories, values: ser.values })),
    options,
  );
}

/** section：整页主题底 + 大号序号 + 节标题（每组第一节的导航页） */
export function drawSection({ s, theme, spec, no, total, footer }: Page): void {
  s.background = { color: theme.sectionBg };
  s.addText('SECTION', {
    ...BASE_TEXT,
    x: 0.98,
    y: 1.12,
    w: 3.4,
    h: 0.36,
    fontSize: 12,
    color: theme.onSectionMute,
    charSpacing: 5,
  });
  s.addText(pad2(spec.sectionNo ?? 1), {
    x: 0.9,
    y: 1.5,
    w: 6.6,
    h: 2.55,
    fontSize: 130,
    bold: true,
    color: mix(theme.sectionBg, theme.onSection, 0.24),
    fontFace: FONT,
    valign: 'middle',
  });
  s.addShape('rect', { x: 1.02, y: 4.42, w: 1.35, h: 0.08, fill: { color: theme.accent } });
  s.addText(spec.title, {
    ...BASE_TEXT,
    x: 0.98,
    y: 4.62,
    w: 11.3,
    h: 1.15,
    fontSize: 32,
    bold: true,
    color: theme.onSection,
    valign: 'middle',
  });
  s.addText(`${footer} · ${no} / ${total}`, {
    ...BASE_TEXT,
    x: 0.98,
    y: PAGE.h - 0.85,
    w: 8,
    h: 0.32,
    fontSize: 9.5,
    color: theme.onSectionMute,
  });
}

// ---------- 版式内的小构件 ----------

/** 整宽编号卡片行（bullets 版式的骨架） */
function drawCardRow(page: Page, text: string, index: number, box: Box): void {
  const { s, theme } = page;
  s.addShape('roundRect', {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    rectRadius: 0.07,
    fill: { color: mix(theme.bgPage, theme.primary, 0.05) },
    line: { color: tint(theme.primary, 0.88), width: 0.75 },
  });
  s.addText(pad2(index), {
    ...BASE_TEXT,
    x: box.x + 0.22,
    y: box.y,
    w: 0.7,
    h: box.h,
    fontSize: 14,
    bold: true,
    color: theme.primary,
    valign: 'middle',
  });
  s.addText(text, {
    ...BASE_TEXT,
    x: box.x + 1.0,
    y: box.y,
    w: box.w - 1.3,
    h: box.h,
    fontSize: box.h > 0.72 ? 16 : 14,
    color: theme.textBody,
    valign: 'middle',
    lineSpacingMultiple: 1.15,
  });
}

/** 圆点行：双栏与 stat/quote 的支撑要点 */
function drawDotRow(page: Page, text: string, box: Box): void {
  const { s, theme } = page;
  const dotY = box.y + Math.min(0.28, box.h / 2) - 0.055;
  s.addShape('ellipse', { x: box.x, y: dotY, w: 0.11, h: 0.11, fill: { color: theme.accent } });
  s.addText(text, {
    ...BASE_TEXT,
    x: box.x + 0.26,
    y: box.y,
    w: box.w - 0.26,
    h: box.h,
    fontSize: 14,
    color: theme.textBody,
    valign: 'middle',
    lineSpacingMultiple: 1.15,
  });
}

/** 浅色面板：twoCol 的两块底 */
function drawPanel(page: Page, box: Box): void {
  const { s, theme } = page;
  s.addShape('roundRect', {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    rectRadius: 0.09,
    fill: { color: mix(theme.bgPage, theme.secondary, 0.07) },
    line: { color: tint(theme.secondary, 0.7), width: 0.75 },
  });
}

/** 空页兜底：调用方给了没数据的页，就如实说明，绝不编内容（红线 10） */
function drawEmpty({ s, theme }: Page): void {
  s.addText('本页暂无内容，可在大纲里补充要点后重新生成。', {
    ...BASE_TEXT,
    x: BODY.x,
    y: BODY.top,
    w: BODY_W,
    h: 0.6,
    fontSize: 14,
    color: theme.textMute,
  });
}

/** 章节序号补零（01/02…）：大号序号两位数才压得住版面 */
function pad2(n: number): string {
  return String(Math.max(1, Math.trunc(n))).padStart(2, '0');
}
