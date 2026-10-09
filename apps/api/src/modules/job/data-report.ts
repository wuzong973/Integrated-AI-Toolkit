/**
 * 把表格画像渲染成 Markdown —— `analyze_data` 的展示层（纯函数）
 *
 * 单独成文件的理由与 `table-stats.ts` 一样：这里只有"排版"，不含取数、不含调模型。
 *
 * ## 报告为什么硬拆成「程序统计」与「AI 分析」两节
 *
 * 两者可信度完全不同：前者是算出来的，后者是模型读出来的。
 * 混在一段里，用户无法判断"平均分 82.5"是算的还是编的 —— 而这两种错误的代价差很远。
 * 所以标题里直接写明来源，让"这个数字从哪来"始终可追（与 seed 里
 * "计划书里的数字必须标注示例"是同一条纪律）。
 */
import type { ColumnProfile, ParsedTable, TableProfile } from './table-stats';

/** 样本最多展示多少行（全量进模型既慢又容易超预算，且对结论没有增量价值） */
export const SAMPLE_ROWS = 20;

/** 数字格式化：整数原样，小数保留两位（避免 `82.49999999999999` 这种浮点尾巴） */
function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** 一列的一句话摘要 */
function summarize(col: ColumnProfile): string {
  if (col.type === 'empty') return '整列为空';
  const parts: string[] = [];
  if (col.stats) {
    parts.push(`均值 ${fmt(col.stats.mean)}`, `中位 ${fmt(col.stats.median)}`);
    parts.push(`范围 ${fmt(col.stats.min)}~${fmt(col.stats.max)}`);
  }
  if (col.top?.length) {
    parts.push(`最高频「${col.top[0].value}」${col.top[0].count} 次`);
  }
  if (col.likelyId) parts.push('疑似标识列');
  return parts.join(' ｜ ') || '—';
}

/** 缺失率：有缺失才提示，否则是噪音 */
function missingCell(col: ColumnProfile): string {
  if (col.missing === 0) return '0';
  const total = col.nonEmpty + col.missing;
  return `${col.missing}（${Math.round((col.missing / total) * 100)}%）`;
}

/** 概览表：每列一行 */
function renderOverview(profile: TableProfile): string {
  const head = '| 列名 | 类型 | 非空 | 缺失 | 唯一值 | 摘要 |\n|---|---|---|---|---|---|';
  const body = profile.columns
    .map(
      (c) =>
        `| ${c.name} | ${TYPE_LABEL[c.type]} | ${c.nonEmpty} | ${missingCell(c)} | ${c.unique} | ${summarize(c)} |`,
    )
    .join('\n');
  return `${head}\n${body}`;
}

/** 数值列明细表 */
function renderNumeric(profile: TableProfile): string {
  const cols = profile.columns.filter((c) => c.type === 'number' && c.stats);
  if (cols.length === 0) return '_没有识别到数值列。_\n';
  const head = '| 列名 | 最小值 | 最大值 | 均值 | 中位数 | 合计 |\n|---|---|---|---|---|---|';
  const body = cols
    .map((c) => {
      const s = c.stats!;
      return `| ${c.name} | ${fmt(s.min)} | ${fmt(s.max)} | ${fmt(s.mean)} | ${fmt(s.median)} | ${fmt(s.sum)} |`;
    })
    .join('\n');
  return `${head}\n${body}\n`;
}

/** 文本列高频值 */
function renderText(profile: TableProfile): string {
  const cols = profile.columns.filter((c) => c.type === 'text' && c.top?.length);
  if (cols.length === 0) return '_没有可统计的文本列。_\n';

  return cols
    .map((c) => {
      const total = c.nonEmpty || 1;
      const lines = c.top!.map(
        (t) => `- 「${t.value}」 ${t.count} 次（${Math.round((t.count / total) * 100)}%）`,
      );
      return `**${c.name}**（共 ${c.unique} 种取值）\n${lines.join('\n')}`;
    })
    .join('\n\n')
    .concat('\n');
}

/** 数据样本表（截断到 SAMPLE_ROWS 行，过宽的值截短，否则 Markdown 表格会撑爆） */
export function renderSample(table: ParsedTable, limit = SAMPLE_ROWS): string {
  const rows = table.rows.slice(0, limit);
  if (rows.length === 0) return '_（无数据行）_\n';

  const head = `| ${table.header.join(' | ')} |\n|${table.header.map(() => '---').join('|')}|`;
  const body = rows
    .map((row) => `| ${table.header.map((_, i) => truncate(row[i] ?? '')).join(' | ')} |`)
    .join('\n');
  const more =
    table.rows.length > rows.length
      ? `\n\n_（共 ${table.rows.length} 行，此处仅展示前 ${rows.length} 行）_`
      : '';
  return `${head}\n${body}${more}\n`;
}

function truncate(value: string, max = 20): string {
  const v = value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

/** 渲染「程序统计」整节 */
export function renderStatsSection(profile: TableProfile): string {
  return [
    `数据规模：**${profile.rowCount} 行 × ${profile.columnCount} 列**。`,
    '',
    '### 列概览',
    '',
    renderOverview(profile),
    '',
    '### 数值列统计',
    '',
    renderNumeric(profile),
    '### 文本列高频取值',
    '',
    renderText(profile),
  ].join('\n');
}

/**
 * 组装最终报告。
 *
 * `aiConclusion` 为空时（模型失败）**不写"AI 分析"这一节**，
 * 而不是补一句"暂无分析" —— 少一节读者只会觉得报告短，
 * 补一句占位话反而像"分析过了但没内容"。
 */
export function assembleReport(opts: {
  source: string;
  profile: TableProfile;
  aiConclusion: string;
  sample: string;
}): string {
  const parts = [
    `# 数据分析报告：${opts.source}`,
    '',
    `> 共 ${opts.profile.rowCount} 行 × ${opts.profile.columnCount} 列 ｜ 由「数据分析」工具生成`,
    '',
    '## 一、数据概览（程序统计）',
    '',
    '> 以下数字由程序直接计算得出，可直接引用。',
    '',
    renderStatsSection(opts.profile),
  ];

  if (opts.aiConclusion.trim()) {
    parts.push(
      '## 二、分析结论（AI 生成）',
      '',
      '> 以下为模型基于上述统计与样本的解读，**不是新算出的数字**；请结合业务判断。',
      '',
      opts.aiConclusion.trim(),
      '',
    );
  }

  parts.push('## 附录：数据样本', '', opts.sample);
  return parts.join('\n');
}

const TYPE_LABEL = { number: '数值', text: '文本', empty: '空' } as const;
