import {
  BizException,
  ErrorCode,
  type PdfCompressInput,
  type PdfMergeInput,
  type PdfProvider,
  type PdfResult,
  type PdfSplitInput,
} from '@qz/core';

/** Stirling-PDF 连接参数（`STIRLING_*` 环境变量经 configuration.ts 装配后的结果） */
export interface StirlingConfig {
  baseUrl: string;
  /** 服务端启用 `SECURITY_CUSTOMGLOBALAPIKEY` 时才需要；自建默认留空 */
  apiKey: string;
  timeoutMs: number;
}

/**
 * Stirling-PDF REST Provider —— 自托管 PDF 工具站（open-core：主 LICENSE 为 MIT）。
 *
 * ## 与 HttpPdfProvider 的分工
 *
 * 两者都实现 `PdfProvider`（合并/拆分/压缩），由 `PDF_PROVIDER` 在
 * real-provider.factory 的 buildPdf 里二选一。**文档解析（docParse）不归 Stirling 管**：
 * 社区版没有与 `DocParseProvider` 等价的稳定端点，docParse 始终走 services/pdf 侧车。
 *
 * ## 端点与字段名（Stirling 3.x，依仓库源码核实，与社区流传的旧文档有出入）
 *
 *   · 合并   `POST /api/v1/general/merge-pdfs` —— 多文件用**重复的 `fileInput`** 字段
 *     （`MergePdfsRequest.fileInput` 是数组），顺序即产出顺序；`sortType` 默认
 *     `orderProvided`，不必传。
 *   · 拆分   `POST /api/v1/general/split-pages` —— `fileInput` + `pageNumbers`
 *     （**切割点**：在这些页之后切开；支持 `all`），**响应始终是 zip**（无 zip 开关）。
 *   · 压缩   `POST /api/v1/misc/compress-pdf` —— `fileInput` + `optimizeLevel`。
 *
 * ## 错误与超时纪律（与 SidecarClient 同一哲学）
 *
 * 不在调用前探活（启动期竞态不可靠），失败时区分「超时」与「连不上」，
 * 并统一带指引文案让运维有两条可执行的出路；验证类问题（ranges 无法等价执行）
 * 显式报错而不是悄悄给出一份与 sidecar 不同的结果（红线 9）。
 */
export class StirlingPdfProvider implements PdfProvider {
  readonly name = 'stirling-pdf';

  constructor(private readonly cfg: StirlingConfig) {}

  async merge(input: PdfMergeInput): Promise<PdfResult> {
    const form = new FormData();
    for (const f of input.files) {
      form.append('fileInput', pdfBlob(f.buffer), assertPdfSuffix(f.filename));
    }
    return this.binary(ENDPOINTS.merge, form, 'merged.pdf', 'PDF 合并', PDF_MIME);
  }

  async split(input: PdfSplitInput): Promise<PdfResult> {
    const form = new FormData();
    form.append('fileInput', pdfBlob(input.file.buffer), assertPdfSuffix(input.file.filename));
    form.append('pageNumbers', splitPoints(input));
    const stem = stemOf(assertPdfSuffix(input.file.filename));
    return this.binary(ENDPOINTS.split, form, `${stem}-split.zip`, 'PDF 拆分', ZIP_MIME);
  }

  async compress(input: PdfCompressInput): Promise<PdfResult> {
    const form = new FormData();
    form.append('fileInput', pdfBlob(input.file.buffer), assertPdfSuffix(input.file.filename));
    // 核心接口的 compress 语义是"无损优化"（垃圾对象回收 + 内容流压缩）；
    // Stirling 的 optimizeLevel 1-9 越高压得越狠、损得越多 —— 取最温和的 1。
    form.append('optimizeLevel', '1');
    return this.binary(ENDPOINTS.compress, form, input.file.filename, 'PDF 压缩', PDF_MIME);
  }

  /**
   * 发送 multipart 并把响应字节转成 PdfResult。
   *
   * 每次调用前**不探活**；`X-API-KEY` 只在配置了 key 时携带（自建默认无鉴权）。
   * Stirling 把产物文件名放在 Content-Disposition，解析失败时用调用方给的兜底名。
   */
  private async binary(
    path: string,
    form: FormData,
    fallbackName: string,
    capability: string,
    fallbackType: string,
  ): Promise<PdfResult> {
    let res: Response;
    try {
      res = await fetch(`${baseOf(this.cfg.baseUrl)}${path}`, {
        method: 'POST',
        body: form,
        headers: this.cfg.apiKey ? { 'X-API-KEY': this.cfg.apiKey } : undefined,
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (e) {
      throw networkError(e, capability, this.cfg.timeoutMs);
    }
    if (!res.ok) throw await httpError(res, capability);

    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      filename: filenameOf(res.headers, fallbackName),
      contentType: res.headers.get('content-type') ?? fallbackType,
      meta: {},
    };
  }
}

/** Stirling 3.x 的 REST 端点（社区版功能；压缩在 misc 组，不在 general） */
const ENDPOINTS = {
  merge: '/api/v1/general/merge-pdfs',
  split: '/api/v1/general/split-pages',
  compress: '/api/v1/misc/compress-pdf',
} as const;

const PDF_MIME = 'application/pdf';
const ZIP_MIME = 'application/zip';

/** 失败时的统一指引：两条可执行的出路 —— 查服务地址，或回退默认引擎 */
const GUIDANCE = 'Stirling-PDF 服务不可用，请检查 STIRLING_SERVICE_URL 或切回 PDF_PROVIDER=sidecar';

/** Stirling 的错误响应是 JSON（可能带 message；取不到就退回 HTTP 状态码） */
interface StirlingErrorBody {
  message?: string;
}

/** 与 SidecarClient.networkError 同款分类：超时要考虑加大超时，连不上要拉起服务 */
function networkError(e: unknown, capability: string, timeoutMs: number): BizException {
  const name = (e as Error)?.name ?? '';
  const timeout = name === 'AbortError' || name === 'TimeoutError';
  const detail = timeout
    ? `处理超时（上限 ${timeoutMs}ms）`
    : `无法连接（${(e as Error)?.message ?? '未知网络错误'}）`;
  return new BizException(
    ErrorCode.ConvertServiceUnavailable,
    { provider: 'stirling-pdf', timeout },
    `${capability}失败：${detail}。${GUIDANCE}`,
  );
}

async function httpError(res: Response, capability: string): Promise<BizException> {
  const body = safeJson<StirlingErrorBody>(await res.text());
  const detail = body?.message ?? `HTTP ${res.status}`;
  return new BizException(
    ErrorCode.ConvertServiceUnavailable,
    { provider: 'stirling-pdf', status: res.status },
    `${capability}失败：${detail}。${GUIDANCE}`,
  );
}

/**
 * PdfSplitInput → Stirling 的 `pageNumbers` 切割点。
 *
 * ⚠️ 两边的 ranges 语义**不同**，只在「可证明等价」时才转发（红线 9：不伪造支持）：
 *   · sidecar 的 ranges 是**显式分组**（`1-3,5,8-N` → [1-3] [5] [8-末]，未列出的页被丢弃）；
 *   · Stirling 的 split-pages 是**连续切割点**（`2,5` → [1-2] [3-5] [6-末]），永不丢页。
 * 因此只有「分组连续、首页从 1 开始、末组以 8-N 收尾」的 ranges 能一一对应 ——
 * 此时切割点 = 除末组外各分组的结束页（末组的结束页就是文档最后一页，
 * Stirling 会自动补上该切割点）。`page`（每页一份）与 Stirling 的 `all` 精确等价。
 */
function splitPoints(input: PdfSplitInput): string {
  if (input.mode === 'page') return 'all';

  const spec = (input.ranges ?? '').trim();
  if (!spec) throw notEquivalent('mode=ranges 时必须给 ranges（如 1-3,4-N）');

  const groups = spec
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .map(parseChunk);

  assertMappable(groups, spec);

  if (groups.length < 2 || groups[0].start !== 1 || !groups[groups.length - 1].endsAtLastPage) {
    throw notEquivalent(
      `ranges「${spec}」无法映射为 Stirling 的连续切割点（需 ≥2 个连续分组且以 8-N 收尾）`,
    );
  }
  return groups
    .slice(0, -1)
    .map((g) => String(g.end))
    .join(',');
}

/** 拆分点映射的前置校验：末组才能以 8-N 收尾、分组之间不许有缺口（否则与 sidecar 产出不一致） */
function assertMappable(groups: PageGroup[], spec: string): void {
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].endsAtLastPage && i !== groups.length - 1) {
      throw notEquivalent(`ranges 里的「N」只能出现在末组（收到「${spec}」）`);
    }
    if (i > 0 && groups[i].start !== groups[i - 1].end + 1) {
      throw notEquivalent(
        `ranges「${spec}」有缺口：Stirling 拆分不丢弃未列出的页，` +
          '请改用连续分组（如 1-3,4-N）或切回 PDF_PROVIDER=sidecar',
      );
    }
  }
}

interface PageGroup {
  start: number;
  end: number;
  /** 是否以 8-N 形式收尾（覆盖到文档最后一页） */
  endsAtLastPage: boolean;
}

const CHUNK_RE = /^(\d+)(?:-(\d+|N))?$/;

/** 单个分组的语义与 sidecar 的 _parse_ranges 一致：`4` = 只取第 4 页；`4-N` = 到末页 */
function parseChunk(chunk: string): PageGroup {
  const m = CHUNK_RE.exec(chunk);
  if (!m || Number(m[1]) < 1) {
    throw notEquivalent(`ranges 里的「${chunk}」不是合法写法（应为 1、1-3 或 8-N）`);
  }
  const start = Number(m[1]);
  if (m[2] === undefined) return { start, end: start, endsAtLastPage: false };
  if (m[2] === 'N') return { start, end: Number.MAX_SAFE_INTEGER, endsAtLastPage: true };
  return { start, end: Number(m[2]), endsAtLastPage: false };
}

function notEquivalent(reason: string): BizException {
  return new BizException(
    ErrorCode.ConvertServiceUnavailable,
    { provider: 'stirling-pdf' },
    `PDF 拆分参数无法在 Stirling-PDF 上等价执行：${reason}`,
  );
}

/** 引擎按扩展名识别输入；没有 .pdf 后缀会被当成未知格式而失败（与 sidecar 客户端同款） */
function assertPdfSuffix(filename: string): string {
  if (/\.pdf$/i.test(filename)) return filename;
  const stem = filename.replace(/\.[^.]+$/, '') || 'document';
  return `${stem}.pdf`;
}

function stemOf(filename: string): string {
  return filename.replace(/\.pdf$/i, '');
}

function baseOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** Blob 不接受 Node 的 Buffer 泛型，需先转无符号视图（与 SidecarClient 同款处理） */
function pdfBlob(buffer: Buffer): Blob {
  return new Blob([new Uint8Array(buffer)], { type: PDF_MIME });
}

function filenameOf(headers: Headers, fallback: string): string {
  const cd = headers.get('content-disposition') ?? '';
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (utf8) return decodeURIComponent(utf8[1].trim());
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? plain[1].trim() : fallback;
}

function safeJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
