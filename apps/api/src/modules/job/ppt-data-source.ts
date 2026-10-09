/**
 * PPT 真实数据源：把用户上传的表格转成可直接绘制的图表页
 *
 * ## 为什么单独成文件
 *
 * `tool-executor.service.ts` 已接近 300 行红线，而这段逻辑（读文件 → 解析 → 抽图 → 降级）
 * 是**独立的一件事**：它只回答「用户这次上传的表格能不能画成图」。
 *
 * ## 降级纪律（红线 10 的核心）
 *
 * 拿不到可画的数据时**返回 undefined 而不是报错**，理由分两种：
 *
 * - **不是表格**（用户传的是参考图、文档）：这不是错误，PPT 本来就允许带参考资料；
 * - **是表格但画不出图**（只有一列、全是文本、空表）：同样不阻断生成，
 *   但**绝不因此标成「真实数据」** —— 模型该用示例数据就继续用示例数据，标注照旧。
 *
 * 反过来，只要这里返回了图表，调用方就会把它的来源写进 caption，
 * 让产物上明确显示「数据来源：上传表格真实统计」。真实与示例**一眼可辨**。
 */
import type { PptChartSpec } from '@qz/core';

import type { FileService } from '../file/file.service';

import { chartFromTable, realDataCaption } from './table-chart';
import { decodeTabular, parseTable, profileTable, type TableProfile } from './table-stats';

/** 能被解析成表格的扩展名（与 analyze_data 同一份约定，避免两个工具两套标准） */
const TABULAR_FILE = /\.(csv|tsv|txt|md)$/i;

export interface PptDataSource {
  /** 可直接交给渲染器的图表（已按数据结构选好类型） */
  chart: PptChartSpec;
  /** 诚实标注：写清数据来源与规模 */
  caption: string;
  profile: TableProfile;
  fileName: string;
}

/**
 * 尝试从入参文件里找出一个可绘图的表格。
 *
 * 只取第一个文件：一次 PPT 生成里混入多张表的场景没有明确语义，
 * 与其猜用户想合并哪几张，不如先用第一张并把来源写清楚。
 */
export async function loadPptDataSource(
  files: FileService,
  userId: string,
  fileIds: readonly string[],
): Promise<PptDataSource | undefined> {
  const id = fileIds[0];
  if (!id) return undefined;

  let file: { buffer: Buffer; name: string };
  try {
    file = await files.readObject(userId, id);
  } catch {
    // 附件读不到不应让整个 PPT 失败：用户要的是演示文稿，不是附件错误报告
    return undefined;
  }

  const fileName = file.name || '';
  if (!TABULAR_FILE.test(fileName)) return undefined;

  try {
    const table = parseTable(decodeTabular(file.buffer));
    if (table.header.length < 2 || table.rows.length === 0) return undefined;
    const profile = profileTable(table);
    const chart = chartFromTable({ table, profile });
    if (!chart) return undefined;
    return { chart, caption: realDataCaption(profile), profile, fileName };
  } catch {
    // 编码/分隔符异常同样按「画不出图」处理，而不是让作业失败
    return undefined;
  }
}

/** 把可用的数值列名读出来，供提示词告诉模型「哪些列有真实数字」 */
export function numericColumnNames(profile: TableProfile): string[] {
  return profile.columns
    .filter((c) => c.type === 'number' && c.stats && !c.likelyId)
    .map((c) => c.name);
}
