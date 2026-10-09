import {
  ErrorCode,
  type DocParseProvider,
  type PdfCompressInput,
  type PdfMergeInput,
  type PdfProvider,
  type PdfResult,
  type PdfSplitInput,
} from '@qz/core';

import type { SidecarClient } from '../sidecar/sidecar.client';

/**
 * PDF Provider —— 转发到 `services/pdf`（PyMuPDF 引擎的隔离包装）。
 *
 * ## 这一层薄是刻意的（与 `HttpConvertProvider` 同一个理由）
 *
 * 引擎能做什么、做不了什么，全部由侧车的 `/pdf/capabilities` 与它自己的
 * 错误信息说了算。主工程里维护一份"PDF 能力矩阵"只会在引擎升级后变成错的，
 * 而且是那种"代码说支持、实际报错"的错。
 *
 * 侧车的三条**业务语义**在这里翻译成用户能懂的话：
 *   · 42212 压缩后反而变大 → 提示"已优化过，改用拆分"
 *   · 42213 没有可提取文字 → 提示"可能是扫描件，改用 OCR"
 *   · 50345 引擎未安装     → 提示运维配 `PYMUPDF_BIN`
 * 这些**不**在主工程判断能力，只是把侧车给出的 hint 原样透传
 * —— 主工程一旦开始"翻译"，侧车升级后这些话就会过期。
 */
export class HttpPdfProvider implements PdfProvider {
  readonly name = 'pdf-service';

  constructor(private readonly client: SidecarClient) {}

  async merge(input: PdfMergeInput): Promise<PdfResult> {
    // 合并的文件顺序就是产出顺序，按调用方给的顺序上传（字段名都是 file）
    const files = input.files.map((f) => ({
      filename: assertPdfSuffix(f.filename),
      contentType: PDF_MIME,
      data: f.buffer,
    }));

    const result = await this.client.binaryMulti(
      '/pdf/merge',
      files,
      {},
      { errorCode: ErrorCode.ConvertServiceUnavailable, capability: 'PDF 合并' },
    );
    return toResult(result);
  }

  async split(input: PdfSplitInput): Promise<PdfResult> {
    const result = await this.client.binary(
      '/pdf/split',
      {
        filename: assertPdfSuffix(input.file.filename),
        contentType: PDF_MIME,
        data: input.file.buffer,
      },
      { mode: input.mode, ...(input.ranges ? { ranges: input.ranges } : {}) },
      { errorCode: ErrorCode.ConvertServiceUnavailable, capability: 'PDF 拆分' },
    );
    return toResult(result);
  }

  async compress(input: PdfCompressInput): Promise<PdfResult> {
    const result = await this.client.binary(
      '/pdf/compress',
      {
        filename: assertPdfSuffix(input.file.filename),
        contentType: PDF_MIME,
        data: input.file.buffer,
      },
      {},
      { errorCode: ErrorCode.ConvertServiceUnavailable, capability: 'PDF 压缩' },
    );
    return toResult(result);
  }
}

/** 文档解析（PDF 取文本）—— 与 PDF 操作同一个侧车，只是响应是 JSON */
export class HttpDocParseProvider implements DocParseProvider {
  readonly name = 'pdf-service';

  constructor(private readonly client: SidecarClient) {}

  async parse(buffer: Buffer, filename: string) {
    const parsed = await this.client.json<Record<string, unknown>>(
      '/pdf/text',
      {},
      { errorCode: ErrorCode.ConvertServiceUnavailable, capability: '文档解析' },
      {
        filename: assertPdfSuffix(filename),
        contentType: PDF_MIME,
        data: buffer,
      },
    );

    const pages = Array.isArray(parsed?.pages)
      ? (parsed.pages as { index: number; text: string }[])
      : [];

    return {
      text: typeof parsed?.text === 'string' ? parsed.text : '',
      pages: pages.map((p) => ({ index: Number(p.index), text: String(p.text ?? '') })),
      meta: {
        pageCount: String(parsed?.pageCount ?? pages.length),
        chars: String(parsed?.chars ?? ''),
        engine: 'pymupdf',
      },
    };
  }
}

const PDF_MIME = 'application/pdf';

function toResult(r: {
  buffer: Buffer;
  filename: string;
  contentType: string;
  headers: Record<string, string>;
}): PdfResult {
  // 只挑跟用户有关的元信息，HTTP 头的细节（时长、引擎路径）不往外带
  const keep = [
    'x-original-bytes',
    'x-output-bytes',
    'x-part-count',
    'x-page-count',
    'x-input-count',
  ];
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) {
    if (keep.includes(k.toLowerCase())) meta[k.toLowerCase()] = v;
  }
  return { buffer: r.buffer, filename: r.filename, contentType: r.contentType, meta };
}

/** 引擎按扩展名识别输入，没有 .pdf 后缀会被当成未知格式而失败 */
function assertPdfSuffix(filename: string): string {
  if (/\.pdf$/i.test(filename)) return filename;
  const stem = filename.replace(/\.[^.]+$/, '') || 'document';
  return `${stem}.pdf`;
}
