import { Inject, Injectable } from '@nestjs/common';
import { BizException, ErrorCode, type Providers } from '@qz/core';

import { PROVIDERS } from '../../infra/providers/providers.module';
import { FileService } from '../file/file.service';

import type { ToolRunContext, ToolRunResult } from './tool-executor.service';

/**
 * 音视频类工具执行器（M4-01 / M4-03）。
 *
 * ## 为什么这类工具此前一直是 `planned`
 *
 * 不是后端不会写，而是 `services/media` 侧车那时只有一张 501 占位路由表 ——
 * 标 active 就是假功能（红线 9）。侧车的 probe / transcode / compress / cut / subtitle
 * 五个端点在 2026-09-19 全部落地并实测通过，这里才把执行链路接上。
 *
 * ## 一个刻意的取舍：视频压缩**按体积档位**而不是按 CRF 暴露给用户
 *
 * 侧车的 `/media/compress` 需要的是**目标字节数**（它按 `目标体积×8÷时长−音频码率`
 * 反推视频码率）。而界面上的"压缩档位"（高画质/均衡/小体积）是一个**比例**语义 ——
 * 用户想要的是"小一半"，不是"CRF 26"。
 *
 * 所以这里把档位换算成"原体积的百分比"再交给侧车：
 * 高画质 60% / 均衡 35% / 小体积 20%。这样用户对结果的预期与实际产物是一致的；
 * 直接把 CRF 透给用户反而会让"压完还是很大"变成常态（CRF 只管画质，不管体积）。
 *
 * ## 产物一律写回文件资产
 *
 * 与图片类工具同一条纪律：`source` 记来源工具名，便于按工具统计与排查"这个文件是谁生成的"。
 */
@Injectable()
export class MediaToolRunner {
  constructor(
    @Inject(PROVIDERS) private readonly providers: Providers,
    private readonly files: FileService,
  ) {}

  /** 视频压缩：档位 → 目标体积 → 侧车反推码率 */
  async compressVideo(ctx: ToolRunContext): Promise<ToolRunResult> {
    const src = await this.firstInput(ctx);
    await ctx.onProgress(20, '正在解析视频信息');

    const quality = toEnum(ctx.params.quality, ['high', 'medium', 'low'] as const, 'medium');
    // 探测不只是为了报信息：时长决定了"这个目标体积能不能做到"，
    // 而侧车会在目标过小时直接拒绝 —— 提前拦下来能给出更具体的提示。
    const info = await this.providers.video.probe(src.buffer);

    const target = resolveTargetBytes(ctx.params.targetSizeMb, src.buffer.length, quality);
    if (!ctx.params.targetSizeMb && target >= src.buffer.length) {
      throw new BizException(
        ErrorCode.ParamInvalid,
        { sizeBytes: src.buffer.length, durationSec: info.durationSec },
        '源文件已经很小，再压缩收益有限；如需更小体积请改用「视频裁剪」',
      );
    }

    await ctx.onProgress(40, `正在压缩（目标 ${(target / 1024 / 1024).toFixed(1)}MB）`);
    const buffer = await this.providers.video.compress(src.buffer, target, CRF_BY_QUALITY[quality]);

    await ctx.onProgress(85, '正在保存');
    const out = await this.files.saveGenerated(ctx.userId, {
      name: withSuffix(src.name, '_compressed', 'mp4'),
      buffer,
      contentType: 'video/mp4',
      source: 'compress_video',
    });
    return {
      outputFiles: [out.id],
      metrics: {
        kind: 'media',
        inputBytes: src.buffer.length,
        outputBytes: buffer.length,
        durationSec: info.durationSec,
        targetMet: buffer.length <= target,
      },
    };
  }

  /** 视频格式转换（mp4 / webm / gif） */
  async convertVideo(ctx: ToolRunContext): Promise<ToolRunResult> {
    const src = await this.firstInput(ctx);
    await ctx.onProgress(30, '正在转换格式');

    const format = toEnum(ctx.params.format, ['mp4', 'webm', 'gif'] as const, 'mp4');
    const buffer = await this.providers.video.convert(src.buffer, format);

    await ctx.onProgress(85, '正在保存');
    const out = await this.files.saveGenerated(ctx.userId, {
      name: withSuffix(src.name, '_converted', format),
      buffer,
      contentType: CONTENT_TYPE[format],
      source: 'convert_video',
    });
    return {
      outputFiles: [out.id],
      metrics: {
        kind: 'media',
        inputBytes: src.buffer.length,
        outputBytes: buffer.length,
      },
    };
  }

  /** 视频裁剪（默认流复制，秒级完成） */
  async cutVideo(ctx: ToolRunContext): Promise<ToolRunResult> {
    const src = await this.firstInput(ctx);
    const start = toFloat(ctx.params.startSec, 0, 0);
    const end = toFloat(ctx.params.endSec, 0, 0);
    if (end <= start) {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '结束时间必须大于开始时间');
    }

    await ctx.onProgress(30, `正在裁剪 ${start}s ~ ${end}s`);
    const buffer = await this.providers.video.cut(src.buffer, start, end);

    await ctx.onProgress(85, '正在保存');
    const out = await this.files.saveGenerated(ctx.userId, {
      name: withSuffix(src.name, `_${start}-${end}s`, 'mp4'),
      buffer,
      contentType: 'video/mp4',
      source: 'cut_video',
    });
    return {
      outputFiles: [out.id],
      metrics: {
        kind: 'media',
        inputBytes: src.buffer.length,
        outputBytes: buffer.length,
      },
    };
  }

  /** 字幕烧录 */
  async addSubtitle(ctx: ToolRunContext): Promise<ToolRunResult> {
    const src = await this.firstInput(ctx);
    const srt = toStr(ctx.params.srt).trim();
    if (!srt) {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '请粘贴字幕内容（SRT 格式）');
    }

    await ctx.onProgress(30, '正在烧录字幕');
    const buffer = await this.providers.video.burnSubtitle(src.buffer, srt);

    await ctx.onProgress(85, '正在保存');
    const out = await this.files.saveGenerated(ctx.userId, {
      name: withSuffix(src.name, '_subtitled', 'mp4'),
      buffer,
      contentType: 'video/mp4',
      source: 'add_subtitle',
    });
    return {
      outputFiles: [out.id],
      metrics: {
        kind: 'media',
        inputBytes: src.buffer.length,
        outputBytes: buffer.length,
      },
    };
  }

  /** 音频格式转换（走媒体侧车，不需要 ASR 模型） */
  async convertAudio(ctx: ToolRunContext): Promise<ToolRunResult> {
    const src = await this.firstInput(ctx);
    await ctx.onProgress(30, '正在转换音频格式');

    const format = toEnum(ctx.params.format, ['mp3', 'wav', 'aac', 'flac'] as const, 'mp3');
    const buffer = await this.providers.audio.convert(src.buffer, format);

    await ctx.onProgress(85, '正在保存');
    const out = await this.files.saveGenerated(ctx.userId, {
      name: withSuffix(src.name, '_converted', format),
      buffer,
      contentType: AUDIO_CONTENT_TYPE[format],
      source: 'convert_audio',
    });
    return {
      outputFiles: [out.id],
      metrics: {
        kind: 'media',
        inputBytes: src.buffer.length,
        outputBytes: buffer.length,
      },
    };
  }


  /**
   * 音频裁剪：优先**同容器流复制**（零损耗），由 Provider 决定要不要重编码。
   *
   * ⚠️ 时长必须在提交前确认：`endSec` 超过时长不是错误（按末尾截断），
   * 但用户填反了起止顺序是错误 —— 这类"参数能跑、结果不是想要的"最该提前拦。
   */
  async cutAudio(ctx: ToolRunContext): Promise<ToolRunResult> {
    const src = await this.firstInput(ctx);
    await ctx.onProgress(25, '正在读取音频信息');

    const startSec = toNumber(ctx.params.startSec, 0);
    const endSec = toNumber(ctx.params.endSec, Number.NaN);
    if (!Number.isFinite(endSec)) {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '请填写结束时间（秒）');
    }
    if (endSec <= startSec) {
      throw new BizException(
        ErrorCode.ParamInvalid,
        { startSec, endSec },
        `结束时间（${endSec}s）必须晚于开始时间（${startSec}s）`,
      );
    }

    const info = await this.providers.video.probe(src.buffer);
    if (info.durationSec && startSec >= info.durationSec) {
      throw new BizException(
        ErrorCode.ParamInvalid,
        { startSec, durationSec: info.durationSec },
        `开始时间 ${startSec}s 超出音频时长 ${info.durationSec.toFixed(1)}s`,
      );
    }

    await ctx.onProgress(60, '正在裁剪');
    const buffer = await this.providers.audio.cut(src.buffer, startSec, Math.min(endSec, info.durationSec || endSec));

    await ctx.onProgress(85, '正在保存');
    const ext = extOf(src.name, 'mp3');
    const out = await this.files.saveGenerated(ctx.userId, {
      name: withSuffix(src.name, `_cut_${startSec}s-${Math.min(endSec, info.durationSec || endSec)}s`, ext),
      buffer,
      contentType: AUDIO_CONTENT_TYPE[ext as keyof typeof AUDIO_CONTENT_TYPE] ?? 'audio/mpeg',
      source: 'cut_audio',
    });
    return {
      outputFiles: [out.id],
      metrics: {
        kind: 'media',
        inputBytes: src.buffer.length,
        outputBytes: buffer.length,
      },
    };
  }

  /** 音频降噪：强度是用户选的档位，引擎参数由侧车换算 */
  async denoiseAudio(ctx: ToolRunContext): Promise<ToolRunResult> {
    const src = await this.firstInput(ctx);
    await ctx.onProgress(35, '正在降噪');

    const strength = toEnum(ctx.params.strength, ['light', 'medium', 'strong'] as const, 'medium');
    const buffer = await this.providers.audio.denoise(src.buffer, strength);

    await ctx.onProgress(85, '正在保存');
    const ext = extOf(src.name, 'mp3');
    const out = await this.files.saveGenerated(ctx.userId, {
      name: withSuffix(src.name, `_denoised_${strength}`, ext),
      buffer,
      contentType: AUDIO_CONTENT_TYPE[ext as keyof typeof AUDIO_CONTENT_TYPE] ?? 'audio/mpeg',
      source: 'denoise_audio',
    });
    return {
      outputFiles: [out.id],
      metrics: {
        kind: 'media',
        inputBytes: src.buffer.length,
        outputBytes: buffer.length,
      },
    };
  }

  /**
   * 人声 / 伴奏分离。
   *
   * 与前面几个音频工具最大的不同：产物是**多条轨道**，所以要存多个文件并全部返回 ——
   * 结果页会把它们列成"人声 / 伴奏"两项，用户可以分别试听、分别下载。
   *
   * 进度只能给两档（15% → 85%）：Demucs 是一次黑盒推理，中途没有可上报的节点。
   * 与其编一个匀速爬升的假进度，不如在文案里把"要等几分钟"说清楚。
   */
  async separateVocals(ctx: ToolRunContext): Promise<ToolRunResult> {
    const src = await this.firstInput(ctx);
    const stems = toEnum(ctx.params.stems, ['2', '4'] as const, '2');

    await ctx.onProgress(15, '正在分离音轨（CPU 约需数分钟）');
    const tracks = await this.providers.audio.separateVocals(src.buffer, stems === '4' ? 4 : 2);

    await ctx.onProgress(85, '正在保存轨道');
    const base = (src.name || 'audio').replace(/\.[^.]+$/, '');
    const out: string[] = [];
    for (const track of tracks) {
      const saved = await this.files.saveGenerated(ctx.userId, {
        name: `${base}-${STEM_LABEL[track.name] ?? track.name}.mp3`,
        buffer: track.data,
        contentType: 'audio/mpeg',
        source: 'separate_vocals',
      });
      out.push(saved.id);
    }
    return { outputFiles: out };
  }

  private async firstInput(ctx: ToolRunContext): Promise<{ buffer: Buffer; name: string }> {
    const id = ctx.inputFiles[0];
    if (!id) throw new BizException(ErrorCode.ParamInvalid, undefined, '请先选择要处理的文件');
    const file = await this.files.readObject(ctx.userId, id);
    return { buffer: file.buffer, name: file.name || 'input' };
  }
}

// ---------- 档位 → 体积/画质 的换算 ----------

/** 档位对应的 CRF（越小画质越好）。数值沿用 x264 的常用档位。 */
const CRF_BY_QUALITY = { high: 20, medium: 26, low: 32 } as const;

/**
 * 档位对应的**目标体积占比**。
 *
 * 这是"压缩档位"在用户心智里的真实语义 —— 选"小体积"就是想要小很多，
 * 而不是想要某个 CRF 值。所以按原体积比例定目标，再由侧车反推码率。
 */
const RATIO_BY_QUALITY = { high: 0.6, medium: 0.35, low: 0.2 } as const;

const CONTENT_TYPE = { mp4: 'video/mp4', webm: 'video/webm', gif: 'image/gif' } as const;
const AUDIO_CONTENT_TYPE = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  flac: 'audio/flac',
} as const;

/** 目标体积：显式给了 MB 就用它，否则按档位比例推算 */
function resolveTargetBytes(targetSizeMb: unknown, sourceBytes: number, quality: keyof typeof RATIO_BY_QUALITY): number {
  const mb = typeof targetSizeMb === 'number' ? targetSizeMb : Number.parseFloat(String(targetSizeMb ?? ''));
  if (!Number.isNaN(mb) && mb > 0) {
    return Math.max(MIN_TARGET_BYTES, Math.round(mb * 1024 * 1024));
  }
  return Math.max(MIN_TARGET_BYTES, Math.round(sourceBytes * RATIO_BY_QUALITY[quality]));
}

/**
 * 目标体积下限。
 *
 * 128KB 不是随手取的：侧车侧有两条硬约束会更早拒绝 ——
 *   ① 它自己的下限是 64KB；
 *   ② 视频码率不能低于 80kbps（否则产物糊成一片，它宁可报错）。
 * 按 3 秒视频 + 96kbps 音频倒推，`(80000+96000)×3÷8 ≈ 66KB`，
 * 再留出余量取 128KB。这里先夹住，是为了让报错发生在**我们这一层**
 * 并带上人话，而不是把侧车的 42203 原样透给用户。
 */
const MIN_TARGET_BYTES = 128 * 1024;

/** 轨道名的中文标签（用于产物文件名）。未收录的名字原样保留，便于排查侧车新增了轨道 */
const STEM_LABEL: Record<string, string> = {
  vocals: '人声',
  accompaniment: '伴奏',
  drums: '鼓',
  bass: '贝斯',
  other: '其他',
};

/** 宽松取数：模型/表单都可能给字符串数字 */
function toNumber(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

/** 从文件名取扩展名（无后缀时用 fallback），供产物命名与 MIME 选择 */
function extOf(name: string, fallback: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  const ext = m?.[1]?.toLowerCase() ?? fallback;
  return AUDIO_CONTENT_TYPE[ext as keyof typeof AUDIO_CONTENT_TYPE] ? ext : fallback;
}

function withSuffix(name: string, suffix: string, ext: string): string {
  const base = (name || 'output').replace(/\.[^.]+$/, '');
  return `${base}${suffix}.${ext}`;
}

function toEnum<T extends readonly string[]>(
  v: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v)
    ? (v as T[number])
    : fallback;
}

function toFloat(v: unknown, fallback: number, min: number): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, n);
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}
