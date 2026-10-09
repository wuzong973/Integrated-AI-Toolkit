import {
  BizException,
  ErrorCode,
  type DocParseProvider,
  type ParsedDocument,
} from '@qz/core';

import type { SidecarClient } from '../sidecar/sidecar.client';

/**
 * docling 文档解析 Provider —— 版面/表格/阅读顺序理解，输出 Markdown。
 *
 * ## 与 HttpDocParseProvider 的关系
 *
 * 两者都实现 `DocParseProvider`、都打到 `services/pdf`，差别只在引擎与端点：
 *   · legacy（`/pdf/text`）—— PyMuPDF 取纯文本，快，但理解不了版面；
 *   · docling（`/pdf/parse-docling`）—— 版面/表格/阅读顺序理解，产出 Markdown。
 * 由 `DOC_PARSER_PROVIDER` 在 real-provider.factory 的 buildPdf 里二选一，
 * 默认 legacy —— 本类的存在不得影响 legacy 的任何行为。
 *
 * ## 后缀的纪律
 *
 * 侧车按**扩展名**给 docling 分流格式（.pdf/.docx/.pptx/.html），
 * 认不出的后缀会被兜底成 .pdf 再交给引擎 —— 与 HttpDocParseProvider 的
 * assertPdfSuffix 同一取舍：让引擎吃"确定的东西"，不靠它猜。
 *
 * ## 错误语义
 *
 * 侧车的 501（docling 未装）会带 pip 安装指引，由 SidecarClient 原样透传；
 * "解出空内容"在这里兜底成 AiOutputInvalid —— 不把"没字"当成功落库（红线 9）。
 */
export class DoclingDocParseProvider implements DocParseProvider {
  readonly name = 'pdf-service-docling';

  constructor(private readonly client: SidecarClient) {}

  async parse(buffer: Buffer, filename: string): Promise<ParsedDocument> {
    const normalized = normalizeSuffix(filename);
    const parsed = await this.client.json<DoclingParseBody>(
      '/pdf/parse-docling',
      {},
      { errorCode: ErrorCode.ConvertServiceUnavailable, capability: '文档解析' },
      {
        filename: normalized,
        contentType: MIME_BY_EXT[extOf(normalized)] ?? PDF_MIME,
        data: buffer,
      },
    );
    return toParsedDocument(parsed);
  }
}

/** 侧车响应体（services/pdf/handlers.handle_parse_docling 的 payload 形状） */
interface DoclingParseBody {
  text?: unknown;
  pages?: unknown;
  pageCount?: unknown;
  chars?: unknown;
  meta?: { format?: unknown; mdPreview?: unknown } | null;
}

/**
 * 响应 → ParsedDocument。
 *
 * 与 HttpDocParseProvider 的映射保持同构（text/pages/meta.pageCount/chars），
 * 多带 meta.format / meta.mdPreview 增量字段 —— 消费方读不到也不受影响。
 */
function toParsedDocument(parsed: DoclingParseBody): ParsedDocument {
  const text = typeof parsed.text === 'string' ? parsed.text : '';
  if (!text.trim()) {
    throw new BizException(
      ErrorCode.AiOutputInvalid,
      { provider: 'docling' },
      '文档解析没有产出内容（可能是扫描件），请改用「OCR 文字识别」',
    );
  }

  const pages = Array.isArray(parsed.pages)
    ? (parsed.pages as { index?: unknown; text?: unknown }[])
    : [];
  const meta = typeof parsed.meta === 'object' && parsed.meta !== null ? parsed.meta : {};

  return {
    text,
    pages: pages.map((p, i) => ({ index: Number(p.index ?? i), text: String(p.text ?? '') })),
    meta: {
      pageCount: String(parsed.pageCount ?? pages.length),
      chars: String(parsed.chars ?? text.length),
      engine: 'docling',
      format: String(meta.format ?? ''),
      mdPreview: String(meta.mdPreview ?? ''),
    },
  };
}

/** docling 原生支持的扩展名；认不出兜底 .pdf（解析目标以 PDF 为主） */
const SUPPORTED_SUFFIX = [/\.pdf$/i, /\.docx$/i, /\.pptx$/i, /\.html?$/i];

function normalizeSuffix(filename: string): string {
  if (SUPPORTED_SUFFIX.some((re) => re.test(filename))) return filename;
  const stem = filename.replace(/\.[^.]+$/, '') || 'document';
  return `${stem}.pdf`;
}

function extOf(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename);
  return (m?.[1] ?? '').toLowerCase();
}

const PDF_MIME = 'application/pdf';

const MIME_BY_EXT: Record<string, string> = {
  pdf: PDF_MIME,
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  html: 'text/html',
  htm: 'text/html',
};
