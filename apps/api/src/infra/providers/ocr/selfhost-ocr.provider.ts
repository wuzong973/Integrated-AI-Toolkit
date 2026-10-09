import { BizException, ErrorCode, type OcrBlock, type OcrProvider, type OcrResult } from '@qz/core';

import type { AppConfig } from '../../../common/config/configuration';

/**
 * OCR —— 自托管 AI 侧车实现（PaddleOCR，`OCR_PROVIDER=selfhost` 时启用）
 *
 * ## 协议
 *
 * POST `{AI_SERVICE_URL}/ai/ocr`（multipart：file），响应
 * `{ blocks: [{ text, box? }], fullText, language }`。box 是 PaddleOCR 的
 * **4 点坐标**（左上/右上/右下/左下），比云端 VLM 方案的 `<|LOC_x|>` 清洗更可靠。
 *
 * ## 与 VlmOcrProvider 的取舍
 *
 * 云端（硅基流动 VLM）偶发"HTTP 200 + 一长串重复字符"的假成功（实测），
 * 需要内容层退化检测；自托管 PaddleOCR 的输出是确定性结构，没有这个问题 ——
 * 所以这里只做**结构校验**，不复制退化检测。若未来切回云端，行为由 VlmOcrProvider 保证。
 *
 * ## 语言参数
 *
 * 侧车模型固定中英文（`lang='ch'`），`recognize` 的 `lang` 选项被刻意**忽略**：
 * 传了也不生效，与其假装支持，不如让接口诚实地只有一个行为。
 */
export class SelfhostOcrProvider implements OcrProvider {
  readonly name = 'selfhost-ocr';

  constructor(private readonly cfg: AppConfig) {}

  async recognize(file: Buffer): Promise<OcrResult> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file)], { type: 'image/png' }), 'image');

    const res = await fetch(`${sidecarBaseUrl(this.cfg.ai.serviceUrl)}/ai/ocr`, {
      method: 'POST',
      // 不要手动设置 Content-Type —— fetch 需要自己带 multipart boundary
      body: form,
      // OCR 与抠图同量级（首次调用加载模型之外，单图秒级），用 AI 侧车 120s 档
      signal: AbortSignal.timeout(this.cfg.ai.timeoutMs),
    });

    if (!res.ok) throw await toSidecarError(res);

    // 响应体不是 JSON（网关返回 HTML 错误页等）按"空结果"收敛 → 走 AiOutputInvalid 的
    // 人话文案，而不是让裸的 SyntaxError 冒出来。
    const result = toOcrResult(await readJson(res));
    // 空结果当失败（红线 9）：把空串当成功，下游会存一份"识别成功但没字"的产物
    if (!result.fullText.trim()) {
      throw new BizException(
        ErrorCode.AiOutputInvalid,
        { provider: this.name },
        'OCR 未返回任何文字，请确认图片清晰且包含文字',
      );
    }
    return result;
  }
}

// ---------- 侧车响应的防御性解析 ----------

interface SidecarErrorBody {
  code?: number;
  message?: string;
  hint?: string;
}

interface SidecarBlock {
  text?: unknown;
  box?: unknown;
}

interface SidecarOcrBody {
  blocks?: unknown;
  fullText?: unknown;
  language?: unknown;
}

/** 拼 baseUrl（容忍配置里末尾多写了一个 `/`） */
function sidecarBaseUrl(serviceUrl: string): string {
  return serviceUrl.replace(/\/+$/, '');
}

async function toSidecarError(res: Response): Promise<BizException> {
  const body = safeJson<SidecarErrorBody>(await res.text());
  const message = body?.message ?? `OCR 服务返回 HTTP ${res.status}`;
  return new BizException(
    ErrorCode.LlmUnavailable,
    { status: res.status, sidecarCode: body?.code, hint: body?.hint },
    body?.hint ? `${message}；${body.hint}` : message,
  );
}

/**
 * 响应结构校验：blocks / fullText 缺失时按"空结果"收敛，交给调用方判空。
 *
 * 为什么不直接信任侧车：两边是独立进程，Python 侧模型/解析逻辑演进时
 * 这里最多"收窄成空结果并报人话错误"，而不是把畸形数据写进产物。
 */
function toOcrResult(json: unknown): OcrResult {
  const body = (json ?? {}) as SidecarOcrBody;
  const blocks: OcrBlock[] = [];
  const texts: string[] = [];

  for (const item of Array.isArray(body.blocks) ? body.blocks : []) {
    const block = toBlock(item);
    if (!block) continue;
    blocks.push(block);
    texts.push(block.text);
  }

  const fullText = typeof body.fullText === 'string' ? body.fullText : texts.join('\n');
  const language = typeof body.language === 'string' ? body.language : 'chi_sim+eng';
  return { blocks, fullText, language };
}

function toBlock(item: unknown): OcrBlock | undefined {
  const raw = (item ?? {}) as SidecarBlock;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return undefined;

  const block: OcrBlock = { text };
  const box = toBox(raw.box);
  if (box) block.box = box;
  return block;
}

/** 4 点坐标逐点校验（np.float32 已被 Python 侧转 float，这里仍防御非数字） */
function toBox(raw: unknown): [number, number][] | undefined {
  if (!Array.isArray(raw) || raw.length < 4) return undefined;

  const box: [number, number][] = [];
  for (const point of raw.slice(0, 4)) {
    const pair = point as [unknown, unknown];
    const x = Number(pair?.[0]);
    const y = Number(pair?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    box.push([x, y]);
  }
  return box;
}

function safeJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** 读响应体 JSON；不是合法 JSON 时返回 undefined（toOcrResult 按空结果收敛） */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
