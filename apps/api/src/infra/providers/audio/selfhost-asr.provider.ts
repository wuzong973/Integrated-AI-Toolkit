import { BizException, ErrorCode, type AudioProvider, type AudioStem } from '@qz/core';

import type { AppConfig } from '../../../common/config/configuration';
import { TimeBudget } from '../../../common/utils/time-budget';

import { isRetryableAsrError, normalizeAsrLanguage, sniffAudioMime } from './asr.provider';

/**
 * 语音转文字 —— 自托管 AI 侧车实现（faster-whisper，`ASR_PROVIDER=selfhost` 时启用）
 *
 * ## 协议
 *
 * POST `{AI_SERVICE_URL}/ai/asr`（multipart：file + language + model），
 * 响应 `{ text, segments: [{ start, end, text }] }`。与云端方案（`SiliconflowAsrProvider`）
 * 的关键差异：**faster-whisper 提供真实的逐句时间戳** —— 云端端点只回整段文本
 * （segments 恒为空），需要字幕烧录这类时间轴的场景应切到本实现。
 *
 * ## 超时与重试：策略与云端完全一致，参数各取所需
 *
 * - 总预算沿用 `ASR_TOTAL_BUDGET_MS`（不变量：一次逻辑调用的墙钟时间有上限）；
 * - 单次超时用 `AI_SERVICE_TIMEOUT_MS`（120s）而不是 `ASR_TIMEOUT_MS`（20s）：
 *   20s 是按云上实测 78ms~6s 调的，CPU 转写是"音频时长的十分之一到一倍"量级，20s 必然误杀。
 *   ⚠️ 切 selfhost 后若 `ASR_TOTAL_BUDGET_MS` 维持默认 25s，长音频会频繁超时 ——
 *   应同步调大预算（注意它仍受"小于小程序请求超时减 5s"的启动期断言约束）。
 * - 重试分类复用 `isRetryableAsrError`：超时/网络可重试，BizException 不重试。
 *
 * ## 语言归一化
 *
 * 复用 `normalizeAsrLanguage`：faster-whisper 同样只认 ISO 639-1 两字母码，
 * `auto` 语义就是"不传参数、自动检测"。Python 侧 `asr.normalize_language` 做同构防御。
 *
 * ## 其余方法直接抛错
 *
 * 理由与文案照抄 `SiliconflowAsrProvider`：那些能力属于媒体侧车（FFmpeg）与
 * AI 侧车的其他端点，本 Provider 不假装实现（红线 9）。
 */
export class SelfhostAsrProvider implements AudioProvider {
  readonly name = 'selfhost-asr';

  constructor(private readonly cfg: AppConfig) {}

  async speechToText(
    buffer: Buffer,
    opts?: { language?: string },
  ): Promise<{
    text: string;
    segments: { start: number; end: number; text: string }[];
  }> {
    const budget = new TimeBudget(this.cfg.asr.totalBudgetMs);
    const maxAttempts = 1 + Math.max(0, this.cfg.asr.maxRetry);
    let lastErr: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (!budget.canAttempt()) break;
      try {
        return await this.transcribeOnce(buffer, opts, budget);
      } catch (e) {
        if (!isRetryableAsrError(e)) throw e;
        lastErr = e;
      }
    }

    throw (
      lastErr ?? new BizException(ErrorCode.LlmUnavailable, { reason: 'asr-budget-exhausted' })
    );
  }

  /** 单次转录请求（不重试；重试由 `speechToText` 统一编排） */
  private async transcribeOnce(
    buffer: Buffer,
    opts: { language?: string } | undefined,
    budget: TimeBudget,
  ): Promise<{
    text: string;
    segments: { start: number; end: number; text: string }[];
  }> {
    const form = new FormData();
    // 模型名发给侧车后仍受白名单约束（services/ai/asr.py 的 resolve_model 会拒绝表外模型）
    form.append('model', this.cfg.ai.whisperModel);
    form.append(
      'file',
      new Blob([new Uint8Array(buffer)], { type: sniffAudioMime(buffer) }),
      'audio',
    );
    const language = normalizeAsrLanguage(opts?.language);
    if (language) form.append('language', language);

    const res = await fetch(`${sidecarBaseUrl(this.cfg.ai.serviceUrl)}/ai/asr`, {
      method: 'POST',
      // 不要手动设置 Content-Type —— fetch 需要自己带 multipart boundary
      body: form,
      signal: AbortSignal.timeout(budget.attemptTimeout(this.cfg.ai.timeoutMs)),
    });

    if (!res.ok) throw await toSidecarError(res);

    // 响应体不是 JSON（网关返回 HTML 错误页等）按"空结果"收敛 → 走 AiOutputInvalid 的
    // 人话文案，而不是让裸的 SyntaxError 冒出来。json() 失败与 text 为空是同一个结论。
    const json = ((await readJson(res)) ?? {}) as { text?: unknown; segments?: unknown };
    const text = typeof json.text === 'string' ? json.text.trim() : '';
    if (!text) {
      throw new BizException(
        ErrorCode.AiOutputInvalid,
        { provider: this.name },
        '未识别到语音内容，请确认音频包含清晰人声',
      );
    }
    return { text, segments: toSegments(json.segments) };
  }

  // 下面五个方法的抛错文案与 SiliconflowAsrProvider 保持一致：
  // 能力入口在媒体侧车 / AI 侧车的其他端点，写"尚未接入"会把排障方向带偏。

  async cut(): Promise<Buffer> {
    throw new BizException(
      ErrorCode.ConvertServiceUnavailable,
      undefined,
      '音频裁剪需要 FFmpeg 服务（MEDIA_SERVICE_URL），请改用已接入的媒体侧车',
    );
  }

  async convert(): Promise<Buffer> {
    throw new BizException(
      ErrorCode.ConvertServiceUnavailable,
      undefined,
      '音频转格式由媒体侧车（services/media）提供，请经由 SidecarAudioProvider 调用',
    );
  }

  async denoise(): Promise<Buffer> {
    throw new BizException(
      ErrorCode.ConvertServiceUnavailable,
      undefined,
      '音频降噪由媒体侧车（services/media）提供，请经由 SidecarAudioProvider 调用',
    );
  }

  async textToSpeech(): Promise<Buffer> {
    throw new BizException(
      ErrorCode.ConvertServiceUnavailable,
      undefined,
      '语音合成由媒体侧车（services/media）的 edge-tts 提供，请经由 SidecarAudioProvider 调用',
    );
  }

  async separateVocals(): Promise<AudioStem[]> {
    throw new BizException(
      ErrorCode.ConvertServiceUnavailable,
      undefined,
      '人声/伴奏分离由 AI 侧车（services/ai，Demucs）提供，请经由 SidecarAudioProvider 调用',
    );
  }
}

// ---------- 侧车响应的防御性解析 ----------

interface SidecarErrorBody {
  code?: number;
  message?: string;
  hint?: string;
}

/** 拼 baseUrl（容忍配置里末尾多写了一个 `/`） */
function sidecarBaseUrl(serviceUrl: string): string {
  return serviceUrl.replace(/\/+$/, '');
}

/** 非 2xx：保留侧车自己的 message 与 hint —— "装什么、怎么装"比任何通用文案都有用 */
async function toSidecarError(res: Response): Promise<BizException> {
  const body = safeJson<SidecarErrorBody>(await res.text());
  const message = body?.message ?? `语音识别服务返回 HTTP ${res.status}`;
  return new BizException(
    ErrorCode.LlmUnavailable,
    { status: res.status, sidecarCode: body?.code, hint: body?.hint },
    body?.hint ? `${message}；${body.hint}` : message,
  );
}

/**
 * segments 结构防御：字段缺失或类型不对的片段丢弃，数字不合法归零。
 *
 * 为什么不整段拒收：时间轴是"锦上添花"字段（下游主要有整段 text），
 * 个别片段畸形不该让一次成功的转写整体失败 —— 与"不伪造时间轴"（红线 9）不冲突：
 * 这里只丢弃，不编造。
 */
function toSegments(raw: unknown): { start: number; end: number; text: string }[] {
  if (!Array.isArray(raw)) return [];

  const out: { start: number; end: number; text: string }[] = [];
  for (const item of raw) {
    const seg = item as { start?: unknown; end?: unknown; text?: unknown };
    const text = typeof seg?.text === 'string' ? seg.text.trim() : '';
    if (!text) continue;
    const start = toFinite(seg?.start);
    const end = toFinite(seg?.end);
    out.push({ start, end, text });
  }
  return out;
}

function toFinite(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** 读响应体 JSON；不是合法 JSON 时返回 undefined（调用方按空结果处理） */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function safeJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
