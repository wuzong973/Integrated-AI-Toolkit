/**
 * 质量评分统一入口
 *
 * 调用方（执行器 / 守卫脚本 / 单测）只认这一个函数，避免三处各写一套"怎么算分"。
 * 文档与 PPT 的内容判据**不同**：文档看字数与章节，PPT 看每页信息量与讲稿备注 ——
 * 用一套标准套两种产物，必然有一方被误判。
 */
import type { PptSlideSpec } from '../providers/types';

import { scoreContent, type ContentQualityReport } from './score';
import { scoreDeckContent } from './score-deck';
import { combineScores, scoreCharts, scoreVisual } from './score-visual';
import type { ChartQualityReport, VisualQualityReport } from './score';

export * from './standard';
export * from './score';
export * from './score-deck';
export * from './score-visual';

/** 综合质量报告：三个维度各自可追溯，综合分只是它们的加权结论 */
export interface OverallQualityReport {
  overall: number;
  grade: ReturnType<typeof import('./standard').gradeOf>;
  passed: boolean;
  /** 内容完整性（文档用文档判据，PPT 用 deck 判据） */
  completeness: number;
  diversity: number;
  consistency: number;
  content: ContentQualityReport;
  visual: VisualQualityReport;
  charts: ChartQualityReport;
}

/** 只评内容（文案 / 文档 / 报告） */
export function analyzeContent(markdown: string, docType?: string): ContentQualityReport {
  return scoreContent(markdown, docType);
}

/** 只评一整套 PPT 的内容（每页信息量 / 要点长度 / 讲稿备注） */
export function analyzeDeckContent(slides: readonly PptSlideSpec[]): ContentQualityReport {
  return scoreDeckContent(slides);
}

/**
 * 评一整套 PPT：deck 内容 + 版式 + 图表 合成综合分。
 *
 * 注意这里**不传 docType**：PPT 内容走 `scoreDeckContent` 的专属判据，
 * 与文档章节 / 字数标准无关。传 docType 只评文字稿的 `analyzeContent` 才需要。
 */
export function analyzeDeck(slides: readonly PptSlideSpec[]): OverallQualityReport {
  const content = scoreDeckContent(slides);
  const visual = scoreVisual(slides);
  const charts = scoreCharts(slides);
  const combined = combineScores(content.score, visual, charts);
  return { ...combined, completeness: content.score, content, visual, charts };
}
