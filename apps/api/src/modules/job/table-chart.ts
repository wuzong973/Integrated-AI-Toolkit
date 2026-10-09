/**
 * 从表格数据抽取「可绘图数据」（真实数据图表的数据源）
 *
 * ## 这条链路解决什么
 *
 * 改造前 PPT 的图表页只能由模型编示例数据（并强制标注「示例数据」）。
 * 而用户上传的 CSV 其实已经有真实数字 —— 只是数据分析与 PPT 是两条各走各的链路，
 * 数据到不了图表里。本文件补上最后一步：从表格到 `PptChartSpec`。
 *
 * ## 为什么需要原始行，而不只是画像
 *
 * `TableProfile` 只有每列的聚合统计（均值/中位数/高频值），
 * 拿它画图只能得到「每个渠道各出现 1 次」这种没意义的图 ——
 * 用户真正想看的是「微信群贡献了 120 单」。
 * 所以这里同时接收原始行，按类目分组后聚合**数值列**。
 *
 * ## 三条纪律
 *
 * - **只搬运，不算新数**：聚合的是表格里真实存在的数值列，不做任何推断估算；
 * - **图表类型按数据形态选**：有顺序（月份）用折线，构成关系才用环形，其余用柱状；
 * - **画不出就不画**：返回 undefined，让调用方回落文字页，绝不产出无意义的空图。
 */
import type { PptChartSpec, PptChartType } from '@qz/core';

import type { ColumnProfile, ParsedTable, TableProfile } from './table-stats';

/** 单图类目上限（与 core 的 MAX_CHART_CATEGORIES 同口径） */
const MAX_CATEGORIES = 12;
/** 占比类图表类目上限：超过就不适合用环形表达 */
const MAX_SHARE_CATEGORIES = 5;
/** 类目轴最多取几个（按数值大小取 Top-N） */
const TOP_N = 6;
/** 分类列取值太多就不适合做类目轴（接近行数说明它近乎唯一） */
const MAX_CATEGORY_CARDINALITY = 20;

/** 顺序类类目词：出现这些字眼说明类目有天然顺序，适合折线图 */
const ORDERED_HINTS = ['月', '季', '年', '周', '日', '阶段', '学期', '年级'] as const;

/** 一列能否当「数值」来画 */
function isDrawableNumber(col: ColumnProfile): boolean {
  return col.type === 'number' && !!col.stats && !col.likelyId;
}

/** 一列能否当「类目」来用：文本、非 ID、取值数量适中 */
function isUsableCategory(col: ColumnProfile): boolean {
  if (col.type === 'empty' || col.likelyId) return false;
  if (col.type !== 'text') return false;
  return (col.top?.length ?? 0) >= 2 && col.unique <= MAX_CATEGORY_CARDINALITY;
}

function looksOrdered(categories: readonly string[]): boolean {
  if (categories.length < 3) return false;
  if (categories.every((c) => /^-?\d+(\.\d+)?$/.test(c.trim()))) return true;
  return categories.some((c) => ORDERED_HINTS.some((h) => c.includes(h)));
}

/**
 * 选图表类型：按数据结构判断，不按好看判断。
 *
 * 顺序很关键：**先判「有顺序」，再判「构成关系」**。
 * 反过来的话，6 个月的销售额会因为有 6 个类目而被画成环形图 ——
 * 时间趋势被表达成占比，是语义错误而不只是不好看。
 */
function pickKind(categories: readonly string[], seriesCount: number): PptChartType {
  if (looksOrdered(categories)) return 'line';
  if (seriesCount === 1 && categories.length <= MAX_SHARE_CATEGORIES) return 'doughnut';
  return 'bar';
}

/** 去掉浮点噪声，保留两位小数 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 取某列在每一行的原始值 */
function columnValues(table: ParsedTable, index: number): string[] {
  return table.rows.map((row) => (row[index] ?? '').trim());
}

function toNumber(v: string): number | null {
  const n = Number(v.replace(/[,\s¥$€]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export interface ChartFromTableInput {
  table: ParsedTable;
  profile: TableProfile;
}

/**
 * 按类目聚合数值列：返回 [类目, 汇总值] 列表。
 *
 * 同一类目多行时求和 —— 这是"总量对比"最常用的口径，
 * 且与用户自己在 Excel 里拉透视表的直觉一致。
 */
function groupByCategory(
  table: ParsedTable,
  categoryIndex: number,
  valueIndex: number,
): { label: string; value: number }[] {
  const labels = columnValues(table, categoryIndex);
  const numbers = columnValues(table, valueIndex).map(toNumber);
  const buckets = new Map<string, number>();
  labels.forEach((label, i) => {
    const n = numbers[i];
    if (!label || n === null) return;
    buckets.set(label, (buckets.get(label) ?? 0) + n);
  });
  return [...buckets.entries()].map(([label, value]) => ({ label, value: round2(value) }));
}

/**
 * 从表格抽取一张真实数据图。
 *
 * 优先级：
 *   ① 类目列 + 数值列 → 按类目聚合数值（用户最想看的口径）
 *   ② 只有数值列 → 各列均值对比
 *   ③ 只有一个数值列 → 该列的 min/均值/中位/max 分布轮廓
 *
 * 都画不出时返回 undefined。
 */
export function chartFromTable({ table, profile }: ChartFromTableInput): PptChartSpec | undefined {
  const categoryIndex = profile.columns.findIndex(isUsableCategory);
  const valueIndex = profile.columns.findIndex(isDrawableNumber);

  // ① 类目 + 数值：按类目聚合真实数值
  if (categoryIndex >= 0 && valueIndex >= 0) {
    const grouped = groupByCategory(table, categoryIndex, valueIndex);
    const ordered = looksOrdered(grouped.map((g) => g.label));
    // 有序类目（月份等）保留原始顺序；无序类目按数值排序取 Top-N，让图更好读
    const picked = ordered
      ? grouped.slice(0, MAX_CATEGORIES)
      : grouped.sort((a, b) => b.value - a.value).slice(0, TOP_N);
    if (picked.length >= 2) {
      const categories = picked.map((p) => p.label);
      const valueName = profile.columns[valueIndex].name;
      return {
        type: pickKind(categories, 1),
        categories,
        series: [{ name: valueName, values: picked.map((p) => p.value) }],
      };
    }
  }

  // ② 多列数值：比各列均值
  const numberCols = profile.columns.filter(isDrawableNumber);
  if (numberCols.length >= 2) {
    const cols = numberCols.slice(0, MAX_CATEGORIES);
    const categories = cols.map((c) => c.name);
    return {
      type: pickKind(categories, 1),
      categories,
      series: [{ name: '各列均值', values: cols.map((c) => round2(c.stats!.mean)) }],
    };
  }

  // ③ 单列数值：展示它的分布轮廓
  const only = numberCols[0];
  if (numberCols.length === 1 && only?.stats) {
    const s = only.stats;
    return {
      type: 'bar',
      categories: ['最小值', '均值', '中位数', '最大值'],
      series: [
        { name: only.name, values: [s.min, s.mean, s.median, s.max].map(round2) },
      ],
    };
  }

  return undefined;
}

/** 图表标注：写清来源与规模，与「示例数据」形成对照（红线 10） */
export function realDataCaption(profile: TableProfile): string {
  return `数据来源：上传表格真实统计（${profile.rowCount} 行 × ${profile.columnCount} 列）`;
}