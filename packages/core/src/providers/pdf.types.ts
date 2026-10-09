/**
 * PDF 能力 —— 独立类型文件（与 `doc-convert.types.ts` 同样的拆分理由）。
 *
 * ## 为什么必须走独立部署的引擎
 *
 * PDF 引擎 PyMuPDF 是 **AGPL-3.0**（Artifex 双许可）。按仓库红线
 * （`docs/compliance/OPEN_SOURCE_LICENSES.md` B 级清单）：
 * **AGPL / GPL 组件一律独立服务 + 只调 API，不链接、不修改、不分发。**
 *
 * 所以本接口的实现一定是远程客户端（`services/pdf` 侧车，
 * 它再以**子进程**调用仓库外安装的 PyMuPDF CLI），**不存在本地实现** ——
 * 在这里 import fitz 就等于把 AGPL 代码链接进了主工程。
 *
 * ## 与 `DocConvertProvider` 的分工（容易混淆）
 *
 * | | 本接口（pdf） | DocConvertProvider（convert） |
 * |---|---|---|
 * | 引擎 | PyMuPDF | LibreOffice / Pandoc |
 * | 能做什么 | 合并 / 拆分 / 压缩 / 取文本（**不改排版**） | 格式互转（**重新排版**） |
 * | 做不到 | PDF → Word/PPT | 合并、拆分、压缩 |
 *
 * `convert_pdf`（PDF → Word/PPT）**属于 convert**，不要因为"都是 PDF"就接到这里 ——
 * PyMuPDF 产不出能编辑的 docx，接进来就是个假能力。
 */

/** 一个待处理的 PDF 文件。`filename` 必须带 `.pdf` 后缀：引擎按扩展名识别输入 */
export interface PdfFileInput {
  filename: string;
  buffer: Buffer;
}

/** 合并：至少两个文件，顺序即产出顺序 */
export interface PdfMergeInput {
  files: PdfFileInput[];
}

/** 拆分：`page` = 每页一份；`ranges` = 按 `1-3,5,8-N` 分组 */
export interface PdfSplitInput {
  file: PdfFileInput;
  mode: 'page' | 'ranges';
  /** `mode: 'ranges'` 时必填 */
  ranges?: string;
}

/** 压缩（无损优化）：垃圾对象回收 + 内容流压缩 + 清理冗余指令 */
export interface PdfCompressInput {
  file: PdfFileInput;
}

export interface PdfResult {
  buffer: Buffer;
  filename: string;
  contentType: string;
  /**
   * 引擎回传的元信息（`X-*` 头），如 `originalBytes` / `outputBytes` / `partCount`。
   * 工具层用它给用户一句"压到多少 / 拆成几份"的实话。
   */
  meta: Record<string, string>;
}

export interface PdfProvider {
  readonly name: string;
  merge(input: PdfMergeInput): Promise<PdfResult>;
  split(input: PdfSplitInput): Promise<PdfResult>;
  compress(input: PdfCompressInput): Promise<PdfResult>;
}
