import { Inject, Injectable } from '@nestjs/common';
import { BizException, ErrorCode, type Providers } from '@qz/core';

import { PROVIDERS } from '../../infra/providers/providers.module';
import { FileService } from '../file/file.service';

import type { ToolRunContext, ToolRunResult } from './tool-executor.service';

/** 从 GitHub 仓库 URL 提取 `owner/repo`（用于产物命名与标题兜底） */
export function repoSlug(repoUrl: string): string {
  try {
    const u = new URL(repoUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    const owner = parts[0] ?? '';
    const repo = (parts[1] ?? '').replace(/\.git$/, '');
    if (owner && repo) return `${owner}/${repo}`;
    return '';
  } catch {
    return '';
  }
}

/**
 * 仓库解读工具执行器（explain_repository）
 *
 * 与 `LlmToolRunner`（提示词 → LLM → 产物）不同，这里**不经过任何 LLM**：
 * 深度解读由 deepwiki-open 服务完成，本 runner 只做三件事 ——
 * 收敛入参（URL 校验）→ 调 `RepoProvider` → 把 Markdown 落成可下载产物。
 *
 * ## 为什么产物是文件而不是直接把文本返回
 *
 * 与文本类工具同一取舍：结果页的产物展示走 `outputFiles`，
 * 用户才可能把"仓库解读"下载或转交他人（见 llm-tool-runner.ts 文件头）。
 *
 * ## 为什么单独建 runner 而不挂 llmTools
 *
 * 执行链完全不同（HTTP 到 deepwiki，无 LLM、无质检、无自修复），
 * 挂进 LlmToolRunner 会让"纯 LLM 链"这个分类名不副实。
 */
@Injectable()
export class RepoToolRunner {
  constructor(
    @Inject(PROVIDERS) private readonly providers: Providers,
    private readonly files: FileService,
  ) {}

  /** 仓库解读：输入 GitHub 仓库 URL，产出解读文档（Markdown） */
  async explain(ctx: ToolRunContext): Promise<ToolRunResult> {
    const repoUrl = requireRepoUrl(ctx.params.repo_url);
    const language = toLanguage(ctx.params.language);
    const slug = repoSlug(repoUrl);

    await ctx.onProgress(20, '正在请求 DeepWiki 生成解读');

    const explanation = await this.providers.repo.explain(repoUrl, { language });
    if (!explanation.markdown.trim()) {
      throw new BizException(ErrorCode.InternalError, undefined, 'DeepWiki 返回了空文档，请稍后重试');
    }

    await ctx.onProgress(80, '正在保存产物');
    const title = explanation.title?.trim() || (slug ? `${slug} 仓库解读` : '仓库解读');
    const out = await this.files.saveGenerated(ctx.userId, {
      name: `${title}.md`.replace(/[\\/:*?"<>|]/g, '_'),
      buffer: Buffer.from(explanation.markdown, 'utf8'),
      contentType: 'text/markdown; charset=utf-8',
      source: 'explain_repository',
    });

    return {
      outputFiles: [out.id],
      metrics: { kind: 'content', chars: explanation.markdown.length },
    };
  }
}

/** 入参收敛：repo_url 必须是合法 URL 且指向 GitHub（deepwiki 只吃 GitHub 仓库） */
function requireRepoUrl(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) {
    throw new BizException(ErrorCode.ParamInvalid, undefined, '缺少仓库地址（repo_url）');
  }
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    throw new BizException(ErrorCode.ParamInvalid, undefined, `「${s}」不是合法的 URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BizException(ErrorCode.ParamInvalid, undefined, '仓库地址必须是 http(s) 链接');
  }
  if (!/(^|\.)github\.com$/.test(parsed.hostname)) {
    throw new BizException(
      ErrorCode.ParamInvalid,
      undefined,
      '暂只支持 GitHub 仓库链接（如 https://github.com/owner/repo）',
    );
  }
  return s;
}

function toLanguage(v: unknown): string {
  return v === 'en' ? 'en' : 'zh';
}
