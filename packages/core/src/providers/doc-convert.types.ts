/**
 * 文档转换（ADR-05）—— 独立类型文件。
 *
 * 从 `types.ts` 拆出来的原因很实际：那份文件是全项目被引用最多的类型文件，
 * 而 ESLint 有「单文件 ≤300 行」的硬红线。与其删注释凑行数，
 * 不如按**能力域**拆分 —— 每个域一个文件，以后加能力不会再撑爆主文件。
 *
 * 导出链不受影响：`providers/index.ts` 会 `export *` 本文件。
 */

/**
 * 文档转换 —— **必须走独立部署的服务**。
 *
 * 这条链路的能力来自 LibreOffice / Pandoc / ConvertX，它们的许可是
 * MPL+LGPL / GPL-2.0 / AGPL-3.0。按仓库红线不得进 `apps/` 或 `services/` 主工程，
 * 只能"独立进程 + HTTP 调用"，所以本接口的实现一定是远程客户端，
 * **不存在本地实现**（本地实现就意味着把 GPL 代码链接进来了）。
 */
export interface DocConvertInput {
  buffer: Buffer;
  /** 原始文件名：转换引擎按扩展名选解析器，这个名字必须带正确后缀 */
  filename: string;
  target: 'pdf' | 'docx' | 'md' | 'html' | 'txt' | 'odt';
}

export interface DocConvertResult {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

export interface DocConvertProvider {
  readonly name: string;
  convert(input: DocConvertInput): Promise<DocConvertResult>;
}
