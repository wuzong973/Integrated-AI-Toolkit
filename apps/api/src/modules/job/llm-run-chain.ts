/**
 * 文本类工具的通用执行链（LLM 生成 → 质检 → 自修复 → 落盘）
 *
 * ## 为什么从 `llm-tool-runner.ts` 抽出来
 *
 * 那个文件已贴 300 行红线，而这段链路本身是**独立的一件事**：
 * 它回答"怎么把一次生成做好"，与"有哪些文本工具、各自的提示词是什么"无关。
 * 抽出来之后，runner 只剩"工具定义表 + 参数收敛"，职责反而更清楚。
 *
 * ## 链路顺序（每一步都不是可选的）
 *
 * ```
 * 生成 → 质检 →（不达标则）带反馈重写一次 → 取分高者 → 落盘 + 记分
 * ```
 *
 * - **质检**：不达标不阻断交付，但必须可见 —— 否则"篇幅过短"会漂到用户手里才被发现；
 * - **自修复**：把扣分项喂回模型（编排在 `content-refine.ts`，本文件只调用）；
 * - **记分**：分数、扣分项、尝试次数一并落库，让效果可被评估（MQ-01）。
 */
import { sampling, type LlmMessage, type Providers } from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import type { FileService } from '../file/file.service';

import { generateWithRefine } from './content-refine';
import type { ToolRunContext, ToolRunResult } from './tool-executor.service';

/** 一次文本工具执行所需的全部依赖 */
export interface RunChainDeps {
  providers: Providers;
  files: FileService;
  logger: AppLogger;
}

/** 一次文本工具的生成规范（见 `LlmToolRunner` 的 `LlmToolSpec`） */
export interface RunChainSpec {
  system: string;
  prompt: string;
  filename: string;
  maxTokens?: number;
  disableThinking?: boolean;
  qualityDocType?: string;
}

/**
 * 跑完整链路并落盘。
 *
 * 抽成自由函数而不是类方法：它只依赖注入进来的三样东西（providers / files / logger），
 * 不碰 runner 的任何状态 —— 这样它既能被 runner 复用，也能被单测直接打靶。
 */
export async function runLlmChain(
  ctx: ToolRunContext,
  toolName: string,
  spec: RunChainSpec,
  deps: RunChainDeps,
): Promise<ToolRunResult> {
  await ctx.onProgress(20, 'AI 正在生成');

  const call = (messages: LlmMessage[]) =>
    deps.providers.llm.chat(messages, {
      tier: 'generate',
      ...sampling('create', { maxTokens: spec.maxTokens ?? 3000 }),
      // 只有"结构固定、不需要推理"的工具才会传 true（见 LlmToolSpec.disableThinking）
      disableThinking: spec.disableThinking,
    });

  // 生成 → 质检 →（不达标则）带反馈重写 → 取分高者。
  // 编排逻辑在 content-refine.ts（可单测）；这里只负责把它接到真实调用上。
  const outcome = await generateWithRefine({
    // 把 finishReason 一并交给编排层：`length` 表示被截断，
    // 那时"重写整篇"没用（会再撞一次上限），应当**接着写**（Q8）。
    generate: async () => {
      const res = await call([
        { role: 'system', content: spec.system },
        { role: 'user', content: spec.prompt },
      ]);
      return { content: res.content, truncated: res.finishReason === 'length' };
    },
    refine: async (feedback) =>
      (
        await call([
          { role: 'system', content: spec.system },
          { role: 'user', content: spec.prompt },
          { role: 'user', content: feedback },
        ])
      ).content,
    qualityDocType: spec.qualityDocType,
  });

  const content = outcome.content;
  logQuality(toolName, spec.qualityDocType, outcome, deps.logger);

  await ctx.onProgress(75, '正在保存产物');
  const out = await deps.files.saveGenerated(ctx.userId, {
    name: spec.filename,
    buffer: Buffer.from(content, 'utf8'),
    contentType: 'text/markdown; charset=utf-8',
    source: toolName,
  });

  // 质检维度的产物才带分数：非 AI 文书（如翻译）没有质量判据，不给空的 0 分
  const quality = spec.qualityDocType
    ? { score: outcome.report.score, issues: outcome.report.issues, chars: outcome.report.chars }
    : undefined;

  return {
    outputFiles: [out.id],
    // chars 用评分器的口径（已去 Markdown 语法），与 qualityScore 同源，避免两个字数
    metrics: { kind: 'content', chars: quality?.chars ?? content.length },
    qualityScore: quality?.score,
    qualityIssues: quality?.issues,
    attempts: outcome.attempts,
  };
}

/**
 * 质量日志。
 *
 * 三档分开说，而不是一律 log：
 * - 未声明质检维度 → 只记长度（这条工具本就没有质量判据）；
 * - 达标 → log；
 * - 未达标 → warn，并带上**具体扣分项**（排查时最需要的就是这个）。
 */
function logQuality(
  toolName: string,
  qualityDocType: string | undefined,
  outcome: {
    report: { passed: boolean; score: number; chars: number; issues: string[] };
    attempts: number;
    improved: boolean;
  },
  logger: AppLogger,
): void {
  if (!qualityDocType) {
    logger.log(`${toolName} 完成（${outcome.report.chars} 字）`, 'LlmTool');
    return;
  }
  const retryNote = outcome.attempts > 1 ? (outcome.improved ? '，重写生效' : '，重写未改善') : '';
  const detail =
    `${toolName} 质量${outcome.report.passed ? '达标' : '未达标'}` +
    `（${outcome.report.score} 分，${outcome.report.chars} 字，尝试 ${outcome.attempts} 次${retryNote}）`;
  if (outcome.report.passed) logger.log(detail, 'LlmTool');
  else logger.warn(`${detail}：${outcome.report.issues.join('；')}`, 'LlmTool');
}
