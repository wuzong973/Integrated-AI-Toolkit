import { BizException, ErrorCode, type AudioProvider, type AudioStem } from '@qz/core';

import type { AppConfig } from '../../../common/config/configuration';
import { TimeBudget } from '../../../common/utils/time-budget';

/**
 * 语音转文字 —— 硅基流动实现（任务清单 M4-03）
 *
 * ## 实测关键结论：ASR 不走 /chat/completions
 *
 * 硅基流动的语音模型必须调 `POST {baseUrl}/audio/transcriptions`
 * （multipart 上传，OpenAI Whisper 风格）。用 `/chat/completions` 传
 * `audio_url` 会返回 `400 code 20012 Model does not exist`。
 *
 * 实测（1s 音频）：`Qwen/Qwen3-ASR-1.7B` 约 0.5s；
 * `FunAudioLLM/SenseVoiceSmall` 同样可用但明显更慢。
 *
 * ## ⚠️ 该端点不提供时间戳（实测）
 *
 * `response_format` 只接受 `json`（默认）：`verbose_json` / `srt` / `vtt` 一律 400，
 * `timestamp_granularities[]` 被接受但忽略。响应恒为 `{ text, usage }`，
 * 因此 `segments` 只能是空数组 —— **不伪造时间轴**（红线 9）。
 * 若将来需要逐句时间戳（如字幕烧录），必须换方案：
 * 自部署 faster-whisper（`WHISPER_MODEL`）或支持 `verbose_json` 的服务。
 *
 * `usage.seconds` 会返回音频时长，目前未使用（接口没有承载它的字段）。
 *
 * ## ⚠️ `language` 是白名单参数
 *
 * 见 `normalizeAsrLanguage`：传 `zh-CN` / `auto` / `中文` 都会 400，
 * 必须归一化后再发。
 *
 * ## 为什么其余方法直接抛错
 *
 * `AudioProvider` 还包含 convert / cut / denoise / separateVocals，它们分别属于
 * 媒体侧车（FFmpeg）与 AI 侧车（Demucs）的职责，本 Provider 不假装实现（红线 9）。
 *
 * ⚠️ 这三个方法的错误文案写的是"**由哪个 Provider 提供**"，而不是"尚未接入" ——
 * 它们**都已经上线**了，写成"尚未接入"会把排障方向带偏：
 * 看到那句话的人会去翻任务清单，而真正的原因是调用链走错了 Provider。
 */
export class SiliconflowAsrProvider implements AudioProvider {
  readonly name = 'siliconflow-asr';

  constructor(private readonly cfg: AppConfig['asr']) {}

  async speechToText(
    buffer: Buffer,
    opts?: { language?: string },
  ): Promise<{
    text: string;
    segments: { start: number; end: number; text: string }[];
  }> {
    const budget = new TimeBudget(this.cfg.totalBudgetMs);
    const maxAttempts = 1 + Math.max(0, this.cfg.maxRetry);
    let lastErr: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (!budget.canAttempt()) break;
      try {
        return await this.transcribeOnce(buffer, opts, budget);
      } catch (e) {
        // 只有**超时 / 网络**这类偶发故障才重试；确定性失败（400/401、空结果）
        // 重试只是白花额度 —— 同一次音频再发一次，模型还是会拒绝。
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
    form.append('model', this.cfg.model);
    form.append(
      'file',
      new Blob([new Uint8Array(buffer)], { type: sniffAudioMime(buffer) }),
      'audio',
    );

    /**
     * language **必须归一化后再发**，不能原样透传。
     * 实测该端点只认 ISO 639-1 两字母码，传 `zh-CN` / `auto` / `中文` 一律 400。
     * 而小程序界面的语言选项恰好包含「自动识别」→ 值为 `auto`
     * —— 若原样透传，"自动识别"这个选项会 100% 失败。
     */
    const language = normalizeAsrLanguage(opts?.language);
    if (language) form.append('language', language);

    const res = await fetch(`${this.cfg.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      // 注意：不要手动设置 Content-Type —— fetch 需要自己带 multipart boundary
      headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
      body: form,
      // 单次超时同时受 per-attempt 上限与剩余总预算约束（见 TimeBudget）
      signal: AbortSignal.timeout(budget.attemptTimeout(this.cfg.timeoutMs)),
    });

    if (!res.ok) {
      // 用 LlmUnavailable 而非 ConvertServiceUnavailable：文案是「AI 服务繁忙」，
      // 对用户才说得通（转换服务那句会被误解成"文件转换失败"）。
      throw new BizException(ErrorCode.LlmUnavailable, {
        status: res.status,
        body: (await res.text()).slice(0, 300),
      });
    }

    const json = (await res.json()) as { text?: string };
    const text = (json.text ?? '').trim();
    if (!text) {
      throw new BizException(
        ErrorCode.AiOutputInvalid,
        { model: this.cfg.model },
        '未识别到语音内容，请确认音频包含清晰人声',
      );
    }

    /**
     * 该模型只返回整段文本、不含时间戳，因此 segments 留空数组。
     * 不伪造时间轴 —— 下游若需要逐句时间戳（如字幕烧录），
     * 应改用带时间戳能力的方案（faster-whisper / 支持 verbose_json 的模型）。
     */
    return { text, segments: [] };
  }

  async cut(): Promise<Buffer> {
    // 音频裁剪属于 FFmpeg 的职责，走媒体侧车（见 SidecarAudioProvider）
    throw new BizException(
      ErrorCode.ConvertServiceUnavailable,
      undefined,
      '音频裁剪需要 FFmpeg 服务（MEDIA_SERVICE_URL），请改用已接入的媒体侧车',
    );
  }

  // 下面三个方法**不再表示"能力没做"** —— 它们都已接入，只是入口不在本 Provider：
  // 转格式/降噪走媒体侧车，分离走 AI 侧车。文案据此写成"去哪里找"，
  // 因为"尚未接入"会让排障的人去翻任务清单，而真正的原因是调用链走错了 Provider。

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

// ---------- 语言参数归一化 ----------

/**
 * `/audio/transcriptions` 实际接受的语言取值 —— **实测得出**（20 个全部返回 200）。
 *
 * 该参数是**白名单**而非"格式校验"：`xx` 这种格式合法但不在表里的值同样 400。
 * 若上游扩了语言，把新码加进来即可；不加的后果只是"该语言退回自动识别"，不会报错。
 */
const ASR_LANGUAGES = new Set([
  'zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt', 'it',
  'ar', 'yue', 'vi', 'th', 'id', 'ms', 'tr', 'pl', 'nl', 'hi',
]);

/**
 * 把界面传来的语言取值翻译成 API 认的取值。
 *
 * 返回 `undefined` 表示**不发送该参数**，此时服务端自动识别语言。
 *
 * 实测拒绝的取值（原样透传会 400）：
 *   · `auto`（小程序「自动识别」选项的值）→ 语义上就该不传参数
 *   · `zh-CN` 等带地区后缀的 BCP-47 → 截到主语言 `zh`
 *   · `中文` 这类自然语言名 → 无法映射，退回自动识别
 *   · `xx` 这类白名单外的码 → 退回自动识别
 *
 * 设计取舍：**未知取值一律降级为自动识别，而不是让请求失败**。
 * 宁可转写结果的语言不是用户所点，也不要整个功能报错 ——
 * 且这样界面新增语言选项时最坏只是"没生效"，不会把功能打挂。
 */
export function normalizeAsrLanguage(input?: string): string | undefined {
  if (!input) return undefined;

  // BCP-47 → ISO 639-1：zh-CN / en-US → zh / en
  const primary = input.trim().toLowerCase().split(/[-_]/)[0];
  if (!primary) return undefined;
  if (primary === 'auto') return undefined;

  return ASR_LANGUAGES.has(primary) ? primary : undefined;
}

/** 音频魔数表（表驱动，避免 if 链推高圈复杂度） */
const AUDIO_SIGNATURES: readonly { mime: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'audio/wav', test: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' },
  { mime: 'audio/mpeg', test: (b) => b.length >= 3 && b.toString('ascii', 0, 3) === 'ID3' },
  { mime: 'audio/mpeg', test: (b) => b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 },
  { mime: 'audio/mp4', test: (b) => b.length >= 8 && b.toString('ascii', 4, 8) === 'ftyp' },
  { mime: 'audio/ogg', test: (b) => b.length >= 4 && b.toString('ascii', 0, 4) === 'OggS' },
  { mime: 'audio/flac', test: (b) => b.length >= 4 && b.toString('ascii', 0, 4) === 'fLaC' },
];

/** 按魔数判断音频类型（入参只有 Buffer，不信任文件名） */
export function sniffAudioMime(buf: Buffer): string {
  return AUDIO_SIGNATURES.find((s) => s.test(buf))?.mime ?? 'audio/wav';
}

/**
 * 该错误是否值得重试。
 *
 * 判据（与 LLM Provider 同一套思路：**重试策略取决于错误分类**）：
 * - **可重试**：`AbortError` / `TimeoutError`（超时）、`TypeError`（fetch 网络层失败）。
 *   实测该端点会间歇性挂起 —— 同一次音频第一次超时、第二次 78ms 成功，
 *   约 **35%** 的调用会挂住。不重试等于把三成多的可用性直接丢掉。
 * - **不可重试**：`BizException` —— 400/401（参数或凭证问题）、空结果（音频里真没人声）。
 *   这些再发一次结果一样，重试只是多花一次额度。
 *
 * ⚠️ 分类错了后果很直接：把超时当确定性失败 → 丢掉 ~35% 可用性；
 * 把 400 当可重试 → 每次配置错误都要白等两轮才报错。
 */
export function isRetryableAsrError(e: unknown): boolean {
  if (e instanceof BizException) return false;
  if (e instanceof Error) {
    // fetch 超时抛 AbortError（DOMException）；部分运行时用 TimeoutError
    return e.name === 'AbortError' || e.name === 'TimeoutError' || e.name === 'TypeError';
  }
  return false;
}
