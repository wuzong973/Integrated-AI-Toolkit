import { BizException, ErrorCode } from '@qz/core';

import type { AppLogger } from '../../../common/logger/logger.service';

/**
 * 侧车（Python 服务）HTTP 客户端。
 *
 * ## 为什么单独抽一个客户端
 *
 * 三个侧车（`services/ai` / `services/media` / `services/convert`）用的是**同一套协议**：
 * multipart 上传二进制 + 表单字段传标量，二进制或 JSON 回来。
 * 各写一份 fetch 就会各错一份 —— 尤其是错误语义：
 * 侧车用 501/50341 表示"这台机器没装依赖"，用 422xx 表示"输入有问题"，
 * 这两类若被压成统一的 500，用户看到的是"服务器错误"，而实际上
 * 一条是"运维要装东西"、一条是"用户该换个文件"。
 *
 * 本客户端负责把侧车的错误语义**翻译成业务错误码**，不负责业务判断。
 *
 * ## 纪律：未配置 ≠ 假装成功
 *
 * `baseUrl` 为空时**不静默降级成 Mock**，而是抛 `ConvertServiceUnavailable`
 * （文案"转换服务暂时不可用"）。理由：Mock 会返回一份看起来正常的产物，
 * 而用户拿到的是"没处理过的原文件" —— 那比报错糟糕得多（红线 9/10）。
 */
export interface SidecarFile {
  /** 表单字段名，默认 file */
  field?: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface SidecarBinary {
  buffer: Buffer;
  /** 侧车回传的产物文件名（`X-Output-Filename`，已 URL 解码） */
  filename: string;
  contentType: string;
  headers: Record<string, string>;
}

export interface SidecarCallOptions {
  /** 失败时映射成的业务错误码（图片类用 LlmUnavailable，转换类用 ConvertServiceUnavailable） */
  errorCode: ErrorCode;
  /** 能力名，进错误文案，如「图片抠图」 */
  capability: string;
}

/** 侧车的错误响应体（`services/shared/http.py` 统一产出这个形状） */
interface SidecarErrorBody {
  code?: number;
  message?: string;
  hint?: string;
}

export class SidecarClient {
  constructor(
    private readonly cfg: { baseUrl: string; timeoutMs: number },
    private readonly label: string,
    private readonly logger: AppLogger,
  ) {}

  /** 是否已配置地址。未配置时所有调用会抛明确错误，而不是走 Mock */
  get enabled(): boolean {
    return this.cfg.baseUrl.trim().length > 0;
  }

  /**
   * 请求 JSON 端点。
   *
   * `file` 可选：`/media/probe` 这类端点只回 JSON，但**入参仍是文件**
   * （要从字节里读时长与分辨率），所以不能假设"JSON 接口 = 没有二进制"。
   */
  async json<T>(
    path: string,
    fields: Record<string, string | number> = {},
    opts: SidecarCallOptions = { errorCode: ErrorCode.LlmUnavailable, capability: this.label },
    file?: SidecarFile,
  ): Promise<T> {
    const res = await this.send(path, fields, file, opts);
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new BizException(
        opts.errorCode,
        { sidecar: this.label, path },
        `${opts.capability}服务返回了非 JSON 结果`,
      );
    }
  }

  /** 请求二进制端点，取回产物 */
  async binary(
    path: string,
    /** 无输入文件的端点传 `undefined`（如 TTS：输入是文本、产出是音频） */
    file: SidecarFile | undefined,
    fields: Record<string, string | number> = {},
    opts: SidecarCallOptions = { errorCode: ErrorCode.LlmUnavailable, capability: this.label },
  ): Promise<SidecarBinary> {
    const res = await this.send(path, fields, file, opts);
    const buffer = Buffer.from(await res.arrayBuffer());

    return {
      buffer,
      // 侧车把文件名 URL 编码后放在响应头里（响应头只能是 ASCII，中文名必须编码）
      filename: decodeURIComponent(
        res.headers.get('x-output-filename') ?? file?.filename ?? 'output',
      ),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      headers: pickTraceHeaders(res.headers),
    };
  }

  /**
   * 多文件版本：字段名相同的多个文件一起上传（PDF 合并用）。
   *
   * ⚠️ 顺序即语义：`/pdf/merge` 的产出顺序就是上传顺序，
   * 所以这里用 `files` 给定顺序逐个 append，**不能**用对象键遍历（键序不可靠）。
   *
   * 为什么不塞进 `binary` 加个可选参数：单文件与多文件的 `filename` 回退逻辑不同
   *（多文件时没有"那一个文件名"可兜底），硬塞会让两个调用方都变难读。
   */
  async binaryMulti(
    path: string,
    files: SidecarFile[],
    fields: Record<string, string | number> = {},
    opts: SidecarCallOptions = { errorCode: ErrorCode.LlmUnavailable, capability: this.label },
  ): Promise<SidecarBinary> {
    const res = await this.sendMulti(path, fields, files, opts);
    const buffer = Buffer.from(await res.arrayBuffer());

    return {
      buffer,
      filename: decodeURIComponent(res.headers.get('x-output-filename') ?? 'output.bin'),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      headers: pickTraceHeaders(res.headers),
    };
  }

  /**
   * JSON 请求 → 二进制响应（`/media/render-diagram` 用：入参是结构化代码、产物是 PNG）。
   *
   * 为什么不复用 `binary`：那个方法固定走 multipart（为"文件入参"设计），
   * 而图表渲染的入参是一段代码文本，用 JSON 语义更清楚、调用方也少拼一层表单。
   */
  async jsonBinary(
    path: string,
    payload: Record<string, unknown>,
    opts: SidecarCallOptions = { errorCode: ErrorCode.LlmUnavailable, capability: this.label },
  ): Promise<SidecarBinary> {
    this.assertConfigured(opts);

    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}${path}`;
    const started = Date.now();

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (e) {
      throw this.networkError(e, path, opts);
    }

    if (!res.ok) {
      throw await this.httpError(res, path, opts);
    }

    this.logger.log(
      `${opts.capability} → ${this.label}${path} 成功（${Date.now() - started}ms）`,
      'SidecarClient',
    );

    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      filename: decodeURIComponent(res.headers.get('x-output-filename') ?? 'output.bin'),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      headers: pickTraceHeaders(res.headers),
    };
  }

  /** 统一构造请求并把非 2xx 翻译成业务异常 */
  private async send(
    path: string,
    fields: Record<string, string | number>,
    file: SidecarFile | undefined,
    opts: SidecarCallOptions,
  ): Promise<Response> {
    return this.sendMulti(path, fields, file ? [file] : [], opts);
  }

  private async sendMulti(
    path: string,
    fields: Record<string, string | number>,
    files: SidecarFile[],
    opts: SidecarCallOptions,
  ): Promise<Response> {
    this.assertConfigured(opts);

    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.append(key, String(value));
    }
    for (const file of files) {
      form.append(
        file.field ?? 'file',
        // 需要一份无符号视图，Blob 不接受 Node 的 Buffer 泛型
        new Blob([new Uint8Array(file.data)], { type: file.contentType }),
        file.filename,
      );
    }

    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}${path}`;
    const started = Date.now();

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        // ⚠️ 不要手动设 Content-Type —— fetch 需要自己写 multipart boundary
        body: form,
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (e) {
      throw this.networkError(e, path, opts);
    }

    if (!res.ok) {
      throw await this.httpError(res, path, opts);
    }

    this.logger.log(
      `${opts.capability} → ${this.label}${path} 成功（${Date.now() - started}ms）`,
      'SidecarClient',
    );
    return res;
  }

  private assertConfigured(opts: SidecarCallOptions): void {
    if (this.enabled) return;
    throw new BizException(
      opts.errorCode,
      { sidecar: this.label },
      `${opts.capability}服务未配置，该能力暂不可用`,
    );
  }

  /**
   * 网络层失败。
   *
   * 单独分类的原因：**超时与服务未启动的表现完全不同**。
   * 超时 → 提高超时或改成异步作业；连不上 → 去把侧车拉起来。
   * 压成同一句"服务不可用"会让运维两件事都试一遍。
   */
  private networkError(e: unknown, path: string, opts: SidecarCallOptions): BizException {
    const name = (e as Error)?.name ?? '';
    const timeout = name === 'AbortError' || name === 'TimeoutError';
    const detail = timeout
      ? `处理超时（上限 ${this.cfg.timeoutMs}ms）`
      : `无法连接（${(e as Error)?.message ?? '未知网络错误'}）`;

    this.logger.warn(`${opts.capability} 调用 ${this.label}${path} 失败：${detail}`, 'SidecarClient');

    return new BizException(
      opts.errorCode,
      { sidecar: this.label, path, timeout },
      `${opts.capability}服务${timeout ? '处理超时，请稍后重试或改用更小的文件' : '暂时不可用'}`,
    );
  }

  /** HTTP 失败：保留侧车自己的错误码与 hint，它们比任何通用文案都有信息量 */
  private async httpError(
    res: Response,
    path: string,
    opts: SidecarCallOptions,
  ): Promise<BizException> {
    const raw = await res.text();
    const body = safeJson<SidecarErrorBody>(raw);

    const message = body?.message ?? `${opts.capability}失败（HTTP ${res.status}）`;
    this.logger.warn(
      `${opts.capability} 调用 ${this.label}${path} 返回 ${res.status}：${message}`,
      'SidecarClient',
    );

    return new BizException(
      opts.errorCode,
      {
        sidecar: this.label,
        path,
        status: res.status,
        sidecarCode: body?.code,
        hint: body?.hint,
      },
      // hint 里通常是"装什么、怎么装"，直接带给调用方比丢掉它有用得多
      body?.hint ? `${message}；${body.hint}` : message,
    );
  }
}

/** 透传侧车的可观测性响应头（产物格式/耗时/编码器等），供排障与埋点使用 */
const TRACE_HEADERS = [
  'x-duration-ms',
  'x-encoder',
  'x-capability',
  'x-matting-model',
  'x-convert-engine',
  'x-output-width',
  'x-output-height',
] as const;

function pickTraceHeaders(headers: Headers): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of TRACE_HEADERS) {
    const value = headers.get(name);
    if (value) picked[name] = value;
  }
  return picked;
}

function safeJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
