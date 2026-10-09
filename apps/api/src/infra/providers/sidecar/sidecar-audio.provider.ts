import { BizException, ErrorCode, type AudioProvider, type AudioStem } from '@qz/core';

import { sniffMedia } from './magic';
import type { SidecarClient } from './sidecar.client';

/**
 * 音频 Provider：**语音识别走模型服务，格式转换走媒体侧车**。
 *
 * ## 为什么拆成两路
 *
 * 音频这一族的能力来源完全不同：
 *   · `speechToText` —— 需要 ASR 模型（硅基流动 `/audio/transcriptions`），**必须联网**；
 *   · `convert`      —— 只是容器/编码转换，ffmpeg 秒级搞定，**没必要走模型**。
 *
 * 此前 `SiliconflowAsrProvider.convert()` 抛的是"音频转格式需要 FFmpeg 服务
 * （MEDIA_SERVICE_URL），尚未接入" —— 那句话在 `services/media` 落地后就**过期了**：
 * 侧车的 `/media/transcode` 本来就支持 mp3/wav/aac/flac。
 * 本类把这条早已可用的路接上，同时保留 `speechToText` 的原有实现（含它的重试与预算逻辑）。
 *
 * ## 2026-09-19 起裁剪与降噪已接通（侧车新增两个端点）
 *
 * 仍然做不到、继续**明确抛错**的只剩 `separateVocals`：
 * 需要 Demucs 权重（约 2GB）与独立算力，ADR-12 已定方案但未部署。
 * 它与降噪的本质区别：降噪是一条音轨的"变干净"，分离是拆成两条 ——
 * 后者没有模型就只能靠中心声道相消这种劣化很大的近似，做了反而误导用户。
 *
 * 两者都**不假装成功**：降噪失败与"原样返回"在听感上差别很小，
 * 而用户会以为处理过了 —— 那比报错糟得多。
 *
 * ## 2026-09-19：分离也已接通
 *
 * 最后一块空白是 `separateVocals`，它需要 Demucs 权重与独立算力（ADR-12）。
 * 拖到最后的理由：降噪是"一条音轨变干净"，分离是**拆成两条** ——
 * 没有模型就只能靠中心声道相消这种劣化很大的近似，做了反而误导用户。
 * 现在 `services/ai` 的 `/ai/separation` 已落地（htdemucs，MIT 许可），这条链才接上。
 *
 * 一个刻意的取舍：分离用**独立超时**（`separationTimeoutMs`），不复用抠图的 120s ——
 * Demucs 在 CPU 上要跑分钟级，用 120s 会把"正常且最终会成功"的请求判成超时。
 */
export class SidecarAudioProvider implements AudioProvider {
  readonly name = 'asr+media-sidecar';

  constructor(
    /** 语音识别委托给它（硅基流动实现，未配 Key 时由上层决定是否降级） */
    private readonly asr: AudioProvider | undefined,
    private readonly media: SidecarClient,
    /** AI 侧车（Demucs 人声分离）。与媒体侧车分开，因为两者超时量级不同 */
    private readonly ai: SidecarClient,
  ) {}

  speechToText(
    buffer: Buffer,
    opts?: { language?: string },
  ): Promise<{
    text: string;
    segments: { start: number; end: number; text: string }[];
  }> {
    if (!this.asr) {
      // 未配 SILICONFLOW_API_KEY 时会走到这里。明确说明是"未配置"而不是"识别失败" ——
      // 否则用户会反复重录音频，而问题其实在运维侧。
      throw new BizException(
        ErrorCode.LlmUnavailable,
        { provider: this.name },
        '语音识别服务未配置（SILICONFLOW_API_KEY），请联系管理员',
      );
    }
    return this.asr.speechToText(buffer, opts);
  }

  /** 音频格式转换 —— 走媒体侧车的 `/media/transcode`（它本就支持这四种） */
  async convert(buffer: Buffer, format: 'mp3' | 'wav' | 'aac' | 'flac'): Promise<Buffer> {
    const type = sniffMedia(buffer);
    const result = await this.media.binary(
      '/media/transcode',
      { filename: `input.${type.ext}`, contentType: type.contentType, data: buffer },
      { format },
      { errorCode: ErrorCode.ConvertServiceUnavailable, capability: '音频转格式' },
    );
    return result.buffer;
  }

  /**
   * 音频裁剪 —— 走 `/media/audio-cut`。
   *
   * 侧车对**同容器**输入走流复制（`-c copy`，零损耗、秒级），
   * 跨容器才重编码。产物扩展名随源文件，调用方按 `X-Output-Filename` 保存。
   */
  async cut(buffer: Buffer, startSec: number, endSec: number): Promise<Buffer> {
    const type = sniffMedia(buffer);
    const result = await this.media.binary(
      '/media/audio-cut',
      { filename: `input.${type.ext}`, contentType: type.contentType, data: buffer },
      { startSec, endSec },
      { errorCode: ErrorCode.ConvertServiceUnavailable, capability: '音频裁剪' },
    );
    return result.buffer;
  }

  /**
   * 音频降噪 —— 走 `/media/audio-denoise`（ffmpeg `afftdn`，FFT 去噪）。
   *
   * 2026-09-19 之前这里抛"暂无降噪端点"—— 那句话随侧车落地而过期。
   * `strength` 原样透传给侧车（它负责换算成 ffmpeg 滤镜参数），
   * 接口层不出现 "nr=14" 这类引擎细节。
   */
  async denoise(
    buffer: Buffer,
    strength: 'light' | 'medium' | 'strong' = 'medium',
  ): Promise<Buffer> {
    const type = sniffMedia(buffer);
    const result = await this.media.binary(
      '/media/audio-denoise',
      { filename: `input.${type.ext}`, contentType: type.contentType, data: buffer },
      { strength },
      { errorCode: ErrorCode.ConvertServiceUnavailable, capability: '音频降噪' },
    );
    return result.buffer;
  }

  /**
   * 人声/伴奏分离 —— 走 `services/ai` 的 `/ai/separation`（Demucs `htdemucs`）。
   *
   * 侧车把多条轨道以 base64 内嵌在一个 JSON 里返回：多文件没法塞进单个响应体，
   * 而 zip 在 Node 侧还得额外解析，base64 只是一行 `Buffer.from`。
   * 这里只负责解码成 Buffer —— 轨道怎么命名、怎么落库由上层决定。
   */
  async separateVocals(buffer: Buffer, stems: 2 | 4): Promise<AudioStem[]> {
    const type = sniffMedia(buffer);
    const res = await this.ai.json<SeparationPayload>(
      '/ai/separation',
      { stems: String(stems) },
      { errorCode: ErrorCode.ConvertServiceUnavailable, capability: '人声/伴奏分离' },
      { filename: `input.${type.ext}`, contentType: type.contentType, data: buffer },
    );

    const tracks = (res.stems ?? []).filter((s) => s.name && s.dataBase64);
    if (tracks.length === 0) {
      // 返回 200 却一条轨道都没有 —— 不能当成功，否则用户拿到一个空作业
      throw new BizException(
        ErrorCode.ConvertServiceUnavailable,
        { sidecar: this.name },
        '分离服务没有返回任何轨道，请稍后重试',
      );
    }
    return tracks.map((t) => ({ name: t.name, data: Buffer.from(t.dataBase64, 'base64') }));
  }

  /**
   * 文本转语音 —— 走 `services/media` 的 `/media/tts`。
   *
   * ⚠️ 这是本类唯一**没有输入文件**的方法：`binary` 的 `file` 传 `undefined`。
   * 合成由侧车的 edge-tts 完成（LGPLv3：独立安装 + 子进程调用，不入库）。
   */
  async textToSpeech(text: string, voice?: string): Promise<Buffer> {
    const result = await this.media.binary(
      '/media/tts',
      undefined,
      { text, ...(voice ? { voice } : {}) },
      { errorCode: ErrorCode.ConvertServiceUnavailable, capability: '语音合成' },
    );
    return result.buffer;
  }
}

/** `services/ai` 的 `/ai/separation` 响应（轨道以 base64 内嵌在 JSON 里） */
interface SeparationPayload {
  model?: string;
  durationSec?: number;
  stems?: { name: string; contentType?: string; sizeBytes?: number; dataBase64: string }[];
}
