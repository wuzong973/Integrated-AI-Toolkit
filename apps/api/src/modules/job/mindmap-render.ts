/**
 * 思维导图的**分享图**渲染（generate_mindmap 的增量产物）。
 *
 * ## 为什么从 `llm-tool-runner.ts` 拆出来

 * 那个文件已贴 300 行红线，而这段"落库后追加一张 PNG"的逻辑有自己的一套纪律
 * （提取代码块、失败不阻塞），与"工具定义 + 提示词"是两件事 —— 与 `llm-run-chain.ts`
 * 同样的拆分理由：抽成自由函数，依赖（providers / files / logger）显式传入，可单测。
 *
 * ## 纪律：渲染失败**绝不**让作业失败
 *
 * 分享图是增量产物，文本结果才是主体 —— LLM 跑了几十秒生成的内容，
 * 不能因为"截图这一步挂了"就整个作废。所以这里的任何失败都只 log warn，
 * 返回原样结果。反过来说，成功也**不改变**文本产物本身：只是往 `outputFiles`
 * 末尾追加一张 PNG（结果页多一个可下载/可分享的产物）。
 */
import { isMockProvider, type Providers } from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import type { FileService } from '../file/file.service';

import type { ToolRunContext, ToolRunResult } from './tool-executor.service';

/** 一次分享图渲染所需的全部依赖（与 RunChainDeps 同一风格） */
export interface MindmapRenderDeps {
  providers: Providers;
  files: FileService;
  logger: AppLogger;
}

/** LLM 输出里 Mermaid 代码块的提取（mindmap 提示词要求它放在 ```mermaid 围栏里） */
const MERMAID_BLOCK = /```mermaid\s*\n([\s\S]*?)```/i;

/** 从产物 Markdown 提取 Mermaid 源码；没有代码块时返回空串 */
export function extractMermaidCode(markdown: string): string {
  const m = MERMAID_BLOCK.exec(markdown);
  return m?.[1]?.trim() ?? '';
}

/**
 * 在 `generate_mindmap` 文本产物落库后追加渲染分享图。
 *
 * Mock 环境**直接跳过**（渲染未启用不是"失败"，连 warn 都不该刷）；
 * 真实环境下渲染失败仅 warn —— 两条路都保证文本产物原样返回。
 */
export async function attachRenderedDiagram(
  ctx: ToolRunContext,
  result: ToolRunResult,
  deps: MindmapRenderDeps,
): Promise<ToolRunResult> {
  const video = deps.providers.video;
  if (isMockProvider(video)) return result;

  const fileId = result.outputFiles[0];
  if (!fileId) return result;

  const md = await deps.files.readObject(ctx.userId, fileId);
  const code = extractMermaidCode(md.buffer.toString('utf8'));
  if (!code) {
    deps.logger.warn(
      'generate_mindmap 产物里没有 Mermaid 代码块，跳过分享图渲染',
      'MindmapRender',
    );
    return result;
  }

  try {
    await ctx.onProgress(90, '正在生成分享图');
    const png = await video.renderDiagram({ kind: 'mermaid', code });
    const out = await deps.files.saveGenerated(ctx.userId, {
      name: `${fileStem(md.name)}-导图.png`,
      buffer: png,
      contentType: 'image/png',
      // source 与文本产物同名：按工具统计产物数时两张图算同一次生成
      source: 'generate_mindmap',
    });
    deps.logger.log(`generate_mindmap 分享图已生成（${png.length} 字节）`, 'MindmapRender');
    return { ...result, outputFiles: [...result.outputFiles, out.id] };
  } catch (e) {
    deps.logger.warn(
      `generate_mindmap 分享图渲染失败（不影响文本产物）：${(e as Error)?.message ?? String(e)}`,
      'MindmapRender',
    );
    return result;
  }
}

/** 从产物文件名取 stem（去掉扩展名），并兜底非法字符 —— 产物命名用 */
function fileStem(name: string): string {
  const stem = (name || '思维导图').replace(/\.[^.]+$/, '').trim();
  return stem || '思维导图';
}
