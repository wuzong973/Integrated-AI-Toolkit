/**
 * PPT 版式分发与「大纲 → 幻灯片」映射（任务清单 M1-02 / M1-07 · PPT 视觉改造）
 *
 * 职责：把"这一页该画成什么样"的决定**从渲染器里剥出来**做成纯函数 ——
 * 渲染器只管画，这里只管判。剥出来还有第二个理由：这类规则此前根本没被执行器碰过
 * （sections 直接 1:1 映射成 title+bullets），所以模型对视觉零表达权。
 *
 * 三条规则（都有单测 —— 它们是"同构九页"的真正解药，回归了没人看得出来）：
 *  1. `resolveLayout`：版式按数据条件降级，绝不画空版式；points>4 自动 twoCol；
 *  2. `dedupeAdjacentLayouts`：相邻两页都是挤着的 bullets → 第二页改 twoCol；
 *  3. `slidesFromSections`：每节先给一张章节过渡页，要点按每页 4 条分片；
 *     一节铺过 8 页内容时再插一张"（续）"过渡页；layout/stat/quote 意图透传。
 */
import type { PptChartType, PptSlideLayout, PptSlideSpec } from '@qz/core';

/** 与 `pptx.defineLayout` 的 QZ_WIDE 一致（16:9，英寸） */
export const PAGE = { w: 13.333, h: 7.5 } as const;
/** 内容页正文区：左边距、正文上下界、页脚细线的 y（标题区固定 0.42~1.25） */
export const BODY = { x: 0.62, top: 1.62, bottom: 6.5, footY: 6.98 } as const;
/** 正文区可用宽度（左右等边距） */
export const BODY_W = PAGE.w - BODY.x * 2;

/**
 * AI 大纲的一节 —— 模型对视觉的**全部**表达权就在这个形状里
 * （schema 与提示词见 `modules/job/tool-executor.service.ts` 的 runGeneratePpt）。
 *
 * 为什么开放 stat / quote / chart 三种：
 * - section 过渡页与 twoCol 由映射规则统一推导（交给模型会画坏版面）；
 * - stat / quote 是模型真正有信息量、又不可能画坏的决定；
 * - chart 需要**真实数据**，所以契约要求模型同时给出 type / categories / series，
 *   数据不全时映射层会降级回 bullets，绝不画空图（红线 10）。
 */
export interface PptOutlineSectionHint {
  title: string;
  points?: string[];
  layout?: 'stat' | 'quote' | 'chart';
  stat?: { value?: string; label?: string };
  quote?: { text?: string; by?: string };
  chart?: {
    type?: PptChartType;
    categories?: string[];
    series?: { name?: string; values?: number[] }[];
  };
  /** 讲稿提示，落到演讲备注（notes），不进正文 */
  notes?: string;
}

/** 单页最多几条要点 —— 超过就该分页或双栏，而不是把字号压成蚂蚁 */
export const MAX_POINTS_PER_PAGE = 4;
/** 一节（两张过渡页之间）最多铺几页内容；超出则再插一张过渡页续节 */
export const MAX_PAGES_PER_GROUP = 8;
/** 强调版式（stat/quote）最多带几条支撑要点 */
export const MAX_EMPHASIS_POINTS = 2;

const LAYOUT_SET = new Set<string>(['bullets', 'section', 'twoCol', 'stat', 'quote', 'chart']);

/**
 * 版式能开画的数据条件。
 * 为什么要有这张表而不是直接信模型给的 layout：`structured()` 内部只做 JSON.parse、
 * 不做 schema 校验，模型完全可能回 `"layout":"stat"` 却不给数字 —— 那样渲染出来
 * 就是一张空白页。条件不满足即按 FALLBACK 降级。
 */
const REQUIREMENT: Record<PptSlideLayout, (s: PptSlideSpec) => boolean> = {
  bullets: () => true,
  section: () => true,
  chart: (s) => !!s.chart?.series.length,
  twoCol: (s) => slidePoints(s).length >= 2,
  stat: (s) => !!s.stat?.value.trim(),
  quote: (s) => !!s.quote?.text.trim(),
};

/** 数据不足以支撑所选版式时的回落目标 */
const FALLBACK: Record<PptSlideLayout, PptSlideLayout> = {
  chart: 'bullets',
  twoCol: 'bullets',
  stat: 'bullets',
  quote: 'bullets',
  bullets: 'bullets',
  section: 'section',
};

/** 这一页最终用哪个版式画（渲染器只认这个函数的结论） */
export function resolveLayout(slide: PptSlideSpec): PptSlideLayout {
  const wanted = wantedLayout(slide);
  const base = REQUIREMENT[wanted](slide) ? wanted : FALLBACK[wanted];
  const crowded = slidePoints(slide).length > MAX_POINTS_PER_PAGE;
  return base === 'bullets' && crowded ? 'twoCol' : base;
}

/**
 * 相邻内容页去重：连着两页都是"挤满要点的 bullets"时，第二页转 twoCol。
 * 返回新数组（不改调用方传入的对象）。过渡页/强调页不参与 —— 它们本来就不重复。
 */
export function dedupeAdjacentLayouts(slides: readonly PptSlideSpec[]): PptSlideSpec[] {
  const out: PptSlideSpec[] = [];
  let prev: PptSlideLayout | undefined;
  for (const slide of slides) {
    const layout = resolveLayout(slide);
    const crowded = slidePoints(slide).length >= 3;
    const repeated = layout === 'bullets' && prev === 'bullets' && crowded;
    out.push(repeated ? { ...slide, layout: 'twoCol' } : slide);
    prev = layout;
  }
  return out;
}

/**
 * 大纲 → 幻灯片。每节先给一张章节过渡页（大序号 + 节标题），再把要点按每页 4 条
 * 分片；一节铺过 8 页时再插一张同序号的"（续）"过渡页。
 * `sectionNo` 由这里统一编号，渲染器照画即可（外部直接构造 slides 时走
 * `withSectionNumbers` 补号，两处都不会画出"第 ? 节"）。
 */
export function slidesFromSections(sections: readonly PptOutlineSectionHint[]): PptSlideSpec[] {
  const out: PptSlideSpec[] = [];
  let sectionNo = 0;
  for (const section of sections) {
    const pages = contentPages(section);
    sectionNo += 1;
    const title = cleanTitle(section.title, sectionNo);
    out.push(dividerSlide(title, sectionNo, section.notes));
    out.push(...withContinuations(pages, title, sectionNo, section.notes));
  }
  return dedupeAdjacentLayouts(out);
}

/**
 * 给"没带 sectionNo 的过渡页"按出现顺序补号。
 * 为什么在渲染器里再补一次：`PptProvider.render` 是公开能力，调用方不一定走
 * `slidesFromSections`（例如 AI 助手直接拼 slides）—— 缺号就画"第 0 节"很难看。
 */
export function withSectionNumbers(slides: readonly PptSlideSpec[]): PptSlideSpec[] {
  let seen = 0;
  return slides.map((slide) => {
    if (resolveLayout(slide) !== 'section') return slide;
    seen += 1;
    return slide.sectionNo ? slide : { ...slide, sectionNo: seen };
  });
}

/** stat 的数字来自模型、可能是编的：value 含数字就必须挂估算脚注（红线 10） */
export function needsEstimateNote(stat?: { value?: string }): boolean {
  return !!stat?.value && /\d/.test(stat.value);
}

/** 单页要点列表（渲染器与版式规则共用这一份取数口径，避免两处各写一遍 filter） */
export function slidePoints(slide: PptSlideSpec): string[] {
  const list = slide.bullets ?? [];
  return list.map((p) => (typeof p === 'string' ? p.trim() : '')).filter(Boolean);
}

// ---------- 内部 ----------

function wantedLayout(slide: PptSlideSpec): PptSlideLayout {
  const raw = slide.layout as string | undefined;
  if (raw && LAYOUT_SET.has(raw)) return raw as PptSlideLayout;
  return slide.chart?.series.length ? 'chart' : 'bullets';
}

/** 一节铺过 8 页就断成"（续）"，并在断点补一张同序号过渡页（长节也要有导航） */
function withContinuations(
  pages: PptSlideSpec[],
  title: string,
  sectionNo: number,
  notes?: string,
): PptSlideSpec[] {
  const out: PptSlideSpec[] = [];
  pages.forEach((page, i) => {
    if (i && i % MAX_PAGES_PER_GROUP === 0) out.push(dividerSlide(`${title}（续）`, sectionNo, notes));
    out.push(page);
  });
  return out;
}

/** 节标题兜底：模型偶尔回空标题，过渡页不能是白板 */
function cleanTitle(raw: string | undefined, sectionNo: number): string {
  const title = (raw ?? '').trim();
  return title || `第 ${sectionNo} 部分`;
}

/** 一节的内容页：强调版式吃掉前 2 条要点作支撑，其余按 4 条一页继续分片 */
function contentPages(section: PptOutlineSectionHint): PptSlideSpec[] {
  const list = cleanPoints(section.points);
  const emphasis = emphasisPage(section, list);
  if (emphasis) return [emphasis];
  const chunks = chunk(list, MAX_POINTS_PER_PAGE);
  return chunks.map((items, i) => ({
    title: i ? `${section.title}（续）` : section.title,
    bullets: items,
    notes: section.notes,
  }));
}

/**
 * 模型点名要 stat/quote/chart 且数据齐备时，这一节第一页就是强调页；
 * 剩余要点进备注。三种强调页互斥，优先 chart（信息密度最高）。
 */
function emphasisPage(
  section: PptOutlineSectionHint,
  list: string[],
): PptSlideSpec | undefined {
  const chart = section.layout === 'chart' ? normalizeChart(section.chart) : undefined;
  const stat = section.layout === 'stat' ? normalizeStat(section.stat) : undefined;
  const quote = section.layout === 'quote' ? normalizeQuote(section.quote) : undefined;
  if (!chart && !stat && !quote) return undefined;
  const tail = list.slice(MAX_EMPHASIS_POINTS);
  const layout: PptSlideLayout = chart ? 'chart' : stat ? 'stat' : 'quote';
  return {
    title: section.title,
    bullets: list.slice(0, MAX_EMPHASIS_POINTS),
    layout,
    chart,
    stat,
    quote,
    notes: tail.length ? withExtraPoints(section.notes, tail) : section.notes,
  };
}

/** 图表数据收敛：类型必须在白名单、类目与系列非空且等长，否则判无数据 */
const CHART_TYPES: readonly PptChartType[] = [
  'bar',
  'bar3D',
  'line',
  'area',
  'pie',
  'doughnut',
  'radar',
  'scatter',
  'bubble',
];

function normalizeChart(
  raw?: PptOutlineSectionHint['chart'],
): PptSlideSpec['chart'] {
  const type = raw?.type && CHART_TYPES.includes(raw.type) ? raw.type : undefined;
  const categories = (raw?.categories ?? []).map((c) => String(c).trim()).filter(Boolean);
  const series = (raw?.series ?? [])
    .map((s) => ({
      name: String(s.name ?? '').trim() || '系列',
      values: (s.values ?? []).map((v) => Number(v)).filter((v) => Number.isFinite(v)),
    }))
    .filter((s) => s.values.length > 0);
  if (!type || categories.length === 0 || series.length === 0) return undefined;
  return { type, categories, series };
}

function normalizeStat(stat?: { value?: string; label?: string }): PptSlideSpec['stat'] {
  const value = stat?.value?.trim();
  if (!value) return undefined;
  return { value, label: stat?.label?.trim() ?? '' };
}

function normalizeQuote(quote?: { text?: string; by?: string }): PptSlideSpec['quote'] {
  const text = quote?.text?.trim();
  if (!text) return undefined;
  return { text, by: quote?.by?.trim() };
}

function withExtraPoints(notes: string | undefined, extra: string[]): string {
  const tail = `补充要点：${extra.join('；')}`;
  return notes ? `${notes}\n${tail}` : tail;
}

function dividerSlide(title: string, sectionNo: number, notes?: string): PptSlideSpec {
  return { title, layout: 'section', sectionNo, notes };
}

/** 去掉空串与非法项，并截断超长要点（单行超过 ~46 字在 16:9 上必然溢出） */
function cleanPoints(raw: readonly string[] | undefined): string[] {
  return (raw ?? [])
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .map((p) => (p.length > 46 ? `${p.slice(0, 45)}…` : p));
}

function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
