import {
  BizException,
  ErrorCode,
  sampling,
  type OcrBlock,
  type OcrProvider,
  type OcrResult,
} from '@qz/core';

import type { AppConfig } from '../../../common/config/configuration';

/**
 * 硅基流动 VLM OCR 实现（任务清单 M1-11）
 *
 * ## 为什么不用 OpenAiCompatibleLlmProvider
 *
 * 那个 Provider 的 `content` 是 `string`，而图像理解需要**多段 content**
 * （`{type:'image_url'}` + `{type:'text'}`）。两者协议不同，必须独立实现。
 *
 * ## 实测结论（同一张中文截图，硅基流动国内站）
 *
 * | 模型 | 耗时 | 输出特征 |
 * |---|---|---|
 * | `deepseek-ai/DeepSeek-OCR` | 1.3s | 纯文本，最干净 —— **默认** |
 * | `PaddlePaddle/PaddleOCR-VL-1.5` | 2.1s | 含 `<|LOC_x|>` 版面坐标标记 |
 *
 * 后者虽然需要清洗，但坐标可还原文字位置，需要版面信息时切换即可。
 *
 * ## 免费档的稳定性注意
 *
 * 实测同一张图连打多次：PaddleOCR-VL 通常 120~250ms，但偶发一次 **14s 且返回一长串
 * 重复字符**（HTTP 仍是 200）。这类"假成功"由 `isDegenerateOutput` 拦下并报错，
 * 不写入产物。生产上若高频出现，说明免费档不够用，需要升档或换自部署。
 */
export class VlmOcrProvider implements OcrProvider {
  readonly name = 'siliconflow-vlm-ocr';

  constructor(private readonly cfg: AppConfig['vlm']) {}

  async recognize(file: Buffer, opts?: { lang?: string }): Promise<OcrResult> {
    return parseOcrOutput(await this.fetchUsableText(file, opts));
  }

  /**
   * 取回「可用」的模型输出 —— HTTP 层与**内容层**都带重试。
   *
   * 为什么内容层也要重试：实测免费档偶发 HTTP 200、耗时正常，但内容是一长串
   * 重复字符（如 `00000000…`）。这类失败重试一次通常就好了；若当成确定性错误
   * 直接抛出，用户看到的就是一次本可避免的失败。
   *
   * 重试策略：4xx（除 429）是确定性失败（模型名错、参数不支持等），立刻抛出，
   * 重试只会白白拖长响应；其余按 1s / 4s 指数退避。
   */
  private async fetchUsableText(file: Buffer, opts?: { lang?: string }): Promise<string> {
    const max = Math.max(1, this.cfg.maxRetry);
    let last: unknown;

    for (let attempt = 0; attempt < max; attempt++) {
      try {
        const raw = extractContent(await this.postOnce(file, opts));
        assertUsable(raw);
        return raw;
      } catch (e) {
        if (e instanceof BizException) throw e;
        last = e;
      }

      if (attempt < max - 1) {
        await new Promise((r) => setTimeout(r, Math.pow(4, attempt) * 1000));
      }
    }

    throw toFinalError(last, this.cfg.model);
  }

  /** 单次请求：POST /chat/completions（多段 content：图 + 文） */
  private async postOnce(file: Buffer, opts?: { lang?: string }): Promise<unknown> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: [
        {
          role: 'user' as const,
          content: [
            { type: 'image_url', image_url: { url: toDataUri(file) } },
            { type: 'text', text: buildPrompt(opts?.lang) },
          ],
        },
      ],
      max_tokens: 4096,
      ...sampling('extract'),
    };

    /**
     * `enable_thinking` **只能按需发送**，不能无脑带上：
     * 实测 `deepseek-ai/DeepSeek-OCR` 收到该参数会直接 400
     * （`code 20015 ... does not support parameter enable_thinking`）。
     * 配置留空（默认）时不发送，对任何模型都安全。
     */
    if (this.cfg.enableThinking !== undefined) {
      body.enable_thinking = this.cfg.enableThinking;
    }

    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });

    if (res.ok) return await res.json();

    // 4xx（除 429 限流）是确定性失败，重试无意义
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      throw new BizException(ErrorCode.LlmUnavailable, {
        status: res.status,
        body: (await res.text()).slice(0, 300),
      });
    }

    throw new Error(`OCR HTTP ${res.status}`);
  }
}

// ---------- 输出校验 ----------

interface SfResponse {
  choices?: { message?: { content?: string } }[];
}

/** 从硅基流动响应里取正文（结构不对时返回空串，交给 assertUsable 判定失败） */
function extractContent(json: unknown): string {
  return (json as SfResponse).choices?.[0]?.message?.content ?? '';
}

/**
 * 「内容不可用」—— 空输出或退化输出。
 *
 * **刻意不继承 BizException**：BizException 在重试循环里被当作"确定性失败"直接抛出，
 * 而这两类问题恰恰是可重试的。继承关系就是重试策略的开关，别改错。
 */
class UnusableOutputError extends Error {
  constructor(
    readonly reason: 'empty' | 'degenerate',
    readonly sample: string,
  ) {
    super(`OCR output unusable: ${reason}`);
    this.name = 'UnusableOutputError';
  }
}

/**
 * 空输出与退化输出都必须视为失败（红线 9：不许用假数据冒充功能）。
 *
 * 空输出：把空串当成功，下游会存下一份空识别结果 —— 用户拿到"识别成功但没字"，
 * 比直接报错更难排查。
 * 退化输出：实测免费档偶发返回一长串重复字符，状态码与耗时都正常，只有内容能看出问题。
 */
function assertUsable(raw: string): void {
  if (!raw.trim()) throw new UnusableOutputError('empty', '');
  if (isDegenerateOutput(raw)) throw new UnusableOutputError('degenerate', raw.trim().slice(0, 40));
}

/** 重试耗尽后，把最后一类错误翻译成对用户有意义的业务异常 */
function toFinalError(last: unknown, model: string): BizException {
  if (last instanceof UnusableOutputError) {
    return new BizException(
      ErrorCode.AiOutputInvalid,
      { model, reason: last.reason, sample: last.sample },
      last.reason === 'empty'
        ? 'OCR 未返回任何文字，请确认图片清晰且包含文字'
        : '识别结果异常（模型多次返回重复内容），请换用其它 OCR 模型',
    );
  }

  return new BizException(ErrorCode.LlmUnavailable, {
    model,
    reason: (last as Error)?.message ?? 'unknown',
  });
}

/**
 * 判定是否为「退化输出」——同一字符占绝对多数。
 *
 * 为什么需要：实测硅基流动免费档偶发返回 HTTP 200 + 一长串 `0000…`，
 * 耗时和状态码都正常，只有内容能看出问题。阈值取 80% 且要求总长 ≥16，
 * 是为了不误伤"图片里真的只有一串数字"这类合法结果（那种情况字符不会重复到 80%）。
 */
export function isDegenerateOutput(raw: string): boolean {
  const s = raw.replace(/\s/g, '');
  if (s.length < 16) return false;

  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);

  return Math.max(...counts.values()) / s.length > 0.8;
}

/**
 * 把模型输出转成 OcrResult。
 *
 * PaddleOCR-VL 会在文字后附加 `<|LOC_x1|><|LOC_y1|><|LOC_x2|><|LOC_y2|>` 形式的
 * 归一化坐标（0~1000）。这里把它们抽出来还原成 box，其余情况按行切分成无坐标块。
 */
export function parseOcrOutput(raw: string): OcrResult {
  const blocks: OcrBlock[] = [];
  const texts: string[] = [];

  for (const line of raw.split('\n')) {
    const { text, box } = extractLine(line);
    if (!text) continue;
    texts.push(text);
    blocks.push(box ? { text, box } : { text });
  }

  return {
    blocks,
    fullText: texts.join('\n'),
    language: 'chi_sim+eng',
  };
}

/** 拆出一行的纯文本与（可选的）归一化坐标框 */
function extractLine(line: string): { text: string; box?: [number, number][] } {
  const coords = [...line.matchAll(/<\|LOC_(\d+)\|>/g)].map((m) => Number(m[1]));
  const text = line.replace(/<\|LOC_\d+\|>/g, '').replace(/<\|[^|]*\|>/g, '').trim();
  if (!text) return { text: '' };

  // 4 个坐标构成一个矩形（左上、右上、右下、左下）
  if (coords.length >= 4) {
    const [x1, y1, x2, y2] = coords;
    return {
      text,
      box: [
        [x1, y1],
        [x2, y1],
        [x2, y2],
        [x1, y2],
      ],
    };
  }
  return { text };
}

// ---------- 工具 ----------

/**
 * 图片魔数表（表驱动，避免 if 链推高圈复杂度）。
 * 按声明顺序匹配，RIFF 需放在 webp 之前判定的位置由具体签名区分。
 */
const IMAGE_SIGNATURES: readonly { mime: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'image/png', test: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 },
  { mime: 'image/jpeg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 },
  { mime: 'image/webp', test: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' },
  { mime: 'image/gif', test: (b) => b.length >= 6 && b.toString('ascii', 0, 3) === 'GIF' },
  { mime: 'image/bmp', test: (b) => b.length >= 4 && b[0] === 0x42 && b[1] === 0x4d },
];

/** 按魔数判断图片类型（不信任扩展名，入参只有 Buffer） */
export function sniffImageMime(buf: Buffer): string {
  return IMAGE_SIGNATURES.find((s) => s.test(buf))?.mime ?? 'image/png';
}

function toDataUri(file: Buffer): string {
  return `data:${sniffImageMime(file)};base64,${file.toString('base64')}`;
}

function buildPrompt(lang?: string): string {
  const target = lang ? `（优先识别 ${lang}）` : '';
  return (
    `请识别图中所有文字${target}，按自然阅读顺序（先上后下、先左后右）逐行输出。` +
    '保持原文的换行与段落结构。不要添加任何解释、标题或标点改写。' +
    '如果图中没有文字，只回复：无文字'
  );
}
