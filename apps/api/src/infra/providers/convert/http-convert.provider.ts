import {
  ErrorCode,
  type DocConvertInput,
  type DocConvertProvider,
  type DocConvertResult,
} from '@qz/core';

import type { SidecarClient } from '../sidecar/sidecar.client';

/**
 * 文档转换 Provider —— 转发到独立部署的 `services/convert`（ADR-05）。
 *
 * ## 这一层薄是刻意的
 *
 * 后端**不判断**"docx 能不能转 pdf" 这类问题，全部交给转换服务的 `/convert/capabilities`
 * 与它自己的错误信息。原因：能转什么完全取决于**那台机器上装了哪个版本**的
 * LibreOffice / Pandoc —— 在主工程里维护一份能力矩阵，只会在引擎升级后变成错的，
 * 而且是那种"代码说支持、实际报错"的错。
 *
 * ## 未配置时的行为
 *
 * `CONVERT_SERVICE_URL` 为空 → `SidecarClient` 抛 `ConvertServiceUnavailable`（50362），
 * 用户看到"转换服务暂时不可用"。这是 ADR-05 明确要求的降级方式：
 * **不是 500、也不是假成功**。相关工具在 seed 里也还是 `planned`，
 * 界面会显示"即将上线"，不会让用户点了才发现不行。
 */
export class HttpConvertProvider implements DocConvertProvider {
  readonly name = 'convert-service';

  constructor(private readonly client: SidecarClient) {}

  async convert(input: DocConvertInput): Promise<DocConvertResult> {
    const result = await this.client.binary(
      '/convert/document',
      {
        filename: input.filename,
        contentType: contentTypeFor(input.filename),
        data: input.buffer,
      },
      { target: input.target },
      { errorCode: ErrorCode.ConvertServiceUnavailable, capability: '文档转换' },
    );

    return {
      buffer: result.buffer,
      filename: result.filename,
      contentType: result.contentType,
    };
  }
}

/** 上传侧的 MIME。识别不了就当二进制流 —— 侧车是按扩展名选引擎的，不依赖这个值 */
const CONTENT_TYPES: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  md: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  pdf: 'application/pdf',
};

function contentTypeFor(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return CONTENT_TYPES[filename.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}
