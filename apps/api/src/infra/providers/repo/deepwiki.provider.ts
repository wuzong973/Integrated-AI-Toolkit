import type { RepoExplanation, RepoProvider } from '@qz/core';

import { AppLogger } from '../../../common/logger/logger.service';

/** DeepWiki 连接参数（与 config.types.ts 的 `repo` 段对应） */
export interface DeepWikiConfig {
  /** 服务基地址，如 `http://localhost:8005`（`DEEPWIKI_BASE_URL`） */
  baseUrl: string;
  /** 单次请求超时（毫秒，`DEEPWIKI_TIMEOUT_MS`） */
  timeoutMs: number;
  /** 可选 Bearer 凭证（`DEEPWIKI_API_KEY`）；不配则不发 Authorization 头 */
  apiKey: string;
}

/** `/api/wiki/ask` 的固定问题：一次问全"核心功能 / 架构 / 使用方式" */
const WIKI_QUESTION = '这个仓库的核心功能、架构与使用方式是什么？';

/**
 * DeepWiki（deepwiki-open，MIT，自托管）仓库解读 Provider。
 *
 * ## 只调 REST，不引 SDK
 *
 * deepwiki-open 没有 official Node SDK；即便有，红线 9 也要求业务代码
 * 只依赖 `RepoProvider` 接口 —— 第三方细节全部关在本文件里。
 *
 * ## 返回结构的容错解析（`extractWikiAnswer`）
 *
 * `/api/wiki/ask` 的响应体随版本差异较大：有的版本直接返回 JSON，
 * 有的按 SSE 分片（`data: {...}` 行）流出。这里按
 * `answer → content → markdown → text → chunks` 的顺序逐字段兜底，
 * 全部落空才抛错 —— **绝不把"解析失败"包装成一份空文档假装成功**（红线 9）。
 * 解析是纯函数，单独导出便于单测打靶。
 */
export class DeepWikiProvider implements RepoProvider {
  readonly name = 'deepwiki';

  constructor(
    private readonly cfg: DeepWikiConfig,
    private readonly logger?: AppLogger,
  ) {}

  async explain(repoUrl: string, opts?: { language?: string }): Promise<RepoExplanation> {
    const base = this.cfg.baseUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/api/wiki/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 不同版本的 ask 端点对 Accept 的宽容度不同：显式要 JSON，
        // 版本仍回 SSE 时由 parseReply 的 data: 行兜底解析
        Accept: 'application/json',
        ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        repoUrl,
        questions: [WIKI_QUESTION],
        type: 'deepwiki',
        ...(opts?.language ? { language: opts.language } : {}),
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(
        `DeepWiki 请求失败（HTTP ${res.status}）：请确认 deepwiki-open 服务可用` +
          `（DEEPWIKI_BASE_URL=${this.cfg.baseUrl}）`,
      );
    }

    const text = await res.text();
    const explanation = parseReply(text);
    if (!explanation) {
      this.logger?.warn(
        `DeepWiki 返回了无法识别的结构（前 200 字符：${text.slice(0, 200)}）`,
        'DeepWiki',
      );
      throw new Error(
        'DeepWiki 返回结构无法解析（answer/content/chunks 均不存在），请核对该部署的 deepwiki-open 版本',
      );
    }
    return explanation;
  }
}

/**
 * 从 DeepWiki 的响应文本里提取解读 Markdown（纯函数，供单测）。
 *
 * 两层兜底：
 *   ① 整体按 JSON 解析（Content-Type 为 JSON 的正常路径）；
 *   ② 解析失败则按 SSE 处理：取每行 `data:` 后面的部分逐段 JSON 解析，
 *      拼出可用的字段再走字段兜底 —— ask 端点流式返回时就是这种形态。
 *
 * 找不到任何已知字段返回 `null`（调用方据此抛错），而不是返回空串。
 */
export function parseReply(raw: string): RepoExplanation | null {
  const direct = tryParse(raw) ?? parseSseChunks(raw);
  if (!direct) return null;
  return extractWikiAnswer(direct);
}

/** 从已解析的响应对象里按字段优先级提取回答 */
export function extractWikiAnswer(payload: unknown): RepoExplanation | null {
  if (!isRecord(payload)) return null;
  const markdown =
    firstNonEmptyString(payload.answer, payload.content, payload.markdown, payload.text) ??
    joinChunks(payload.chunks);
  if (!markdown) return null;
  const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title : undefined;
  return { markdown, title };
}

/** SSE 形态：把每行 `data:` 的 JSON 片段解析后，把其中的文本字段拼起来 */
function parseSseChunks(raw: string): unknown {
  const lines = raw
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => tryParse(l.slice(5).trim()))
    .filter((v): v is Record<string, unknown> => isRecord(v));
  if (!lines.length) return null;
  return { chunks: lines };
}

function joinChunks(chunks: unknown): string | undefined {
  if (!Array.isArray(chunks)) return undefined;
  const parts = chunks
    .map((c) => (isRecord(c) ? firstNonEmptyString(c.answer, c.content, c.text, c.markdown) : undefined))
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  return parts.length ? parts.join('') : undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function tryParse(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}
