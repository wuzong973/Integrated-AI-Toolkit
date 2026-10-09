import type {
  PdfCompressInput,
  PdfMergeInput,
  PdfProvider,
  PdfResult,
  PdfSplitInput,
} from '../pdf.types';

/**
 * PDF 能力的 Mock —— **故意抛错，绝不返回"看起来正常的产物"**。
 *
 * 与 `MockConvertProvider` 同一条纪律：PDF 操作的产物是**要给人用的文件**。
 * Mock 若返回原文件，用户会拿到"合并了但只有一份""压缩了但更大"的结果 ——
 * 那比明确报错糟糕得多（红线 9 / 10）。
 *
 * 真实实现是 `HttpPdfProvider`（转发 `services/pdf`），仅在
 * `PDF_SERVICE_URL` 非空时装配；未配置则落到这里，
 * `/health` 的 `mockProviders` 会列出 `mock-pdf` 给运维提醒。
 */
export class MockPdfProvider implements PdfProvider {
  readonly name = 'mock-pdf';

  merge(_input: PdfMergeInput): Promise<PdfResult> {
    throw unavailable();
  }

  split(_input: PdfSplitInput): Promise<PdfResult> {
    throw unavailable();
  }

  compress(_input: PdfCompressInput): Promise<PdfResult> {
    throw unavailable();
  }
}

function unavailable(): Error {
  return new Error('PDF 服务未配置（缺少 PDF_SERVICE_URL），PDF 能力暂不可用');
}
