import { Inject, Injectable } from '@nestjs/common';
import QRCode, { type QRCodeRenderersOptions } from 'qrcode';
import sharp from 'sharp';
import { BizException, ErrorCode, type Providers } from '@qz/core';

import { PROVIDERS } from '../../infra/providers/providers.module';
import { FileService } from '../file/file.service';

import type { ToolRunContext, ToolRunResult } from './tool-executor.service';

/**
 * 二维码内容长度上限（字符数）。
 *
 * QR 码容量取决于**版本 × 容错级别**：version 40 + level L 约 2953 字节，
 * 而一个中文字符在 UTF-8 下占 3 字节，所以中文实际只能装 ~980 字（L）到 ~770 字（H）。
 * 这里取一个宽松上限，只为拦住"把整篇文章塞进二维码"这类输入 ——
 * 真正的容量判定交给库（下面 catch 会把它的报错翻译成人话），
 * 因为按文本长度硬算容量既算不准（中英文混排），也会随容错级别变化。
 */
const MAX_QR_CHARS = 1200;

/**
 * 图片类工具执行器（压缩 / 转格式 / 抠图 / 增强 / 二维码生成）
 *
 * 与 `LlmToolRunner`、`tool-executor.service` 的分工：
 *   执行器只负责**路由**（工具名 → 具体执行器）与编排约定；
 *   各 runner 按**能力域**拆分 —— 图片类走 Sharp、文本类走 LLM，
 *   它们的入参形态、产物类型、进度节奏完全不同，塞在一个类里只会互相牵制。
 *
 * 产物纪律：一律写回文件资产（saveGenerated），并把来源工具名记进 `source`，
 * 便于按工具统计与排查"这个文件是谁生成的"。
 */
@Injectable()
export class ImageToolRunner {
  constructor(
    @Inject(PROVIDERS) private readonly providers: Providers,
    private readonly files: FileService,
  ) {}

  /**
   * 二维码生成（node-qrcode，纯本地计算）
   *
   * ## 与同文件其他方法的差别：没有输入文件
   *
   * 其余方法都是"处理一张已上传的图"，这个是"凭文本造一张图"，
   * 所以不读 `ctx.inputFiles`，也不走 `providers` —— node-qrcode 是**纯计算库**，
   * 不存在"没配凭证所以不可用"的状态（OCR / LLM 那种才必须靠 Provider 优雅降级）。
   *
   * ## 超容量必须拦住，且要翻译成人话
   *
   * 容量取决于版本 × 容错级别，超了库会抛一句英文错误。
   * 这里先按字符数做宽松兜底，再把库的报错翻成"缩短内容 / 降低容错级别"——
   * 用户能照着做，而不是对着一句 unknown 发呆。
   */
  async qrcode(ctx: ToolRunContext): Promise<ToolRunResult> {
    const text = typeof ctx.params.text === 'string' ? ctx.params.text.trim() : '';
    if (!text) {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '请先填写要生成二维码的内容');
    }
    if (text.length > MAX_QR_CHARS) {
      throw new BizException(
        ErrorCode.ParamInvalid,
        { length: text.length, max: MAX_QR_CHARS },
        `内容过长（${text.length} 字，上限 ${MAX_QR_CHARS}）—— 二维码容量有限，长文本请先转成短链接`,
      );
    }

    await ctx.onProgress(30, '正在生成二维码');

    const size = toInt(ctx.params.size, 512, 64, 2048);
    const level = toEnum(ctx.params.level, ['L', 'M', 'Q', 'H'] as const, 'M');
    const margin = toInt(ctx.params.margin, 2, 0, 16);
    const format = toEnum(ctx.params.format, ['png', 'svg'] as const, 'png');
    // 默认黑白：识别率最高。彩色只在用户显式指定时用（浅色前景很可能扫不出来）
    const dark = typeof ctx.params.dark === 'string' ? ctx.params.dark : '#000000';
    const light = typeof ctx.params.light === 'string' ? ctx.params.light : '#ffffff';
    const buffer = await this.renderQr(text, format, {
      errorCorrectionLevel: level,
      margin,
      width: size,
      color: { dark, light },
    });

    await ctx.onProgress(80, '二维码已生成，正在保存');
    const out = await this.files.saveGenerated(ctx.userId, {
      name: `二维码.${format}`,
      buffer,
      contentType: format === 'svg' ? 'image/svg+xml' : 'image/png',
      source: 'generate_qrcode',
    });

    return {
      outputFiles: [out.id],
      metrics: {
        kind: 'image',
        inputBytes: Buffer.byteLength(text, 'utf8'),
        outputBytes: buffer.length,
        format,
        // SVG 走 sharp 读不到宽高时返回空对象（指标是附加信息，宁缺勿造）
        ...(await imageSize(buffer)),
      },
    };
  }

  /** 渲染成 PNG / SVG；超容量时把库的报错翻译成可执行的建议 */
  private async renderQr(
    text: string,
    format: 'png' | 'svg',
    options: QRCodeRenderersOptions,
  ): Promise<Buffer> {
    try {
      return format === 'svg'
        ? Buffer.from(await QRCode.toString(text, { ...options, type: 'svg' }), 'utf8')
        : await QRCode.toBuffer(text, options);
    } catch (e) {
      throw new BizException(
        ErrorCode.ParamInvalid,
        { reason: (e as Error).message },
        '内容太长，二维码装不下 —— 请缩短内容，或把容错级别调低（H → L 能多装约 30%）',
      );
    }
  }

  async compress(ctx: ToolRunContext): Promise<ToolRunResult> {
    const src = await this.firstInput(ctx);
    await ctx.onProgress(30, '正在压缩图片');

    const quality = toInt(ctx.params.quality, 80, 1, 100);
    const format = toEnum(ctx.params.format, ['jpeg', 'png', 'webp'] as const, 'jpeg');
    // 目标体积（KB → 字节）。不传则走"按质量压缩"，两种模式互不冲突。
    const targetKb = toInt(ctx.params.targetSizeKb, 0, 0, 50_000);
    const targetSizeBytes = targetKb > 0 ? targetKb * 1024 : undefined;

    const { buffer, targetMet } = await this.providers.image.compress({
      buffer: src.buffer,
      quality,
      format,
      targetSizeBytes,
    });

    // "压不到目标"必须说出来：以前一律报成功，用户拿到比要求大的图却无从判断。
    // 这里仍交付产物（它确实变小了、仍可用），但进度文案如实反映未达标。
    const saved = src.buffer.length - buffer.length;
    const progressText = targetMet
      ? `压缩完成（${mb(src.buffer.length)} → ${mb(buffer.length)}，省 ${mb(saved)}），正在保存`
      : `已尽量压缩（${mb(src.buffer.length)} → ${mb(buffer.length)}），未达到目标 ${targetKb}KB，正在保存`;
    await ctx.onProgress(80, progressText);
    const out = await this.files.saveGenerated(ctx.userId, {
      name: withSuffix(src.name, '_compressed', extOfFormat(format)),
      buffer,
      contentType: `image/${format}`,
      source: 'compress_image',
    });
    return {
      outputFiles: [out.id],
      metrics: {
        kind: 'image',
        inputBytes: src.buffer.length,
        outputBytes: buffer.length,
        format,
        targetMet: targetSizeBytes ? targetMet : undefined,
        ...(await imageSize(buffer)),
      },
    };
  }

  async convert(ctx: ToolRunContext): Promise<ToolRunResult> {
    const src = await this.firstInput(ctx);
    await ctx.onProgress(30, '正在转换格式');

    const format = toEnum(ctx.params.format, ['jpeg', 'png', 'webp'] as const, 'png');
    const buffer = await this.providers.image.convert({ buffer: src.buffer, format });

    await ctx.onProgress(80, '正在保存');
    const out = await this.files.saveGenerated(ctx.userId, {
      name: withSuffix(src.name, '_converted', extOfFormat(format)),
      buffer,
      contentType: `image/${format}`,
      source: 'convert_image',
    });
    return {
      outputFiles: [out.id],
      metrics: {
        kind: 'image',
        inputBytes: src.buffer.length,
        outputBytes: buffer.length,
        format,
        ...(await imageSize(buffer)),
      },
    };
  }

  async matting(ctx: ToolRunContext): Promise<ToolRunResult> {
    const src = await this.firstInput(ctx);
    await ctx.onProgress(30, '正在识别主体');

    const buffer = await this.providers.image.removeBackground(src.buffer);

    await ctx.onProgress(85, '正在保存透明背景图');
    const out = await this.files.saveGenerated(ctx.userId, {
      name: withSuffix(src.name, '_nobg', 'png'),
      buffer,
      contentType: 'image/png',
      source: 'remove_background',
    });
    return { outputFiles: [out.id] };
  }

  async enhance(ctx: ToolRunContext): Promise<ToolRunResult> {
    const src = await this.firstInput(ctx);
    await ctx.onProgress(30, '正在增强画质');

    // strength 直接透传给 Provider 控制锐化强度。
    // 以前这里把它映射成 2/4 传给一个"超分"参数，而实现根本不放大 —— 参数白传。
    const strength = toInt(ctx.params.strength, 50, 0, 100);
    const buffer = await this.providers.image.enhance(src.buffer, strength);

    await ctx.onProgress(85, '正在保存');
    // 扩展名与 contentType 必须跟着**真实输出格式**走：
    // Sharp 不指定格式时保留原格式，以前硬写成 png/image/png，
    // 于是 JPEG 输入会被存成一个后缀 png 的 JPEG —— 部分环境打不开。
    const ext = imageExtOf(src.name);
    const out = await this.files.saveGenerated(ctx.userId, {
      name: withSuffix(src.name, '_enhanced', ext),
      buffer,
      contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
      source: 'enhance_image',
    });
    return {
      outputFiles: [out.id],
      metrics: {
        kind: 'image',
        inputBytes: src.buffer.length,
        outputBytes: buffer.length,
        format: ext,
        ...(await imageSize(buffer)),
      },
    };
  }

  // ---------- 内部 ----------

  /** 取第一个入参文件；没有就报错（大多数工具都需要文件） */
  private async firstInput(ctx: ToolRunContext): Promise<{ buffer: Buffer; name: string }> {
    const fileId = ctx.inputFiles[0];
    if (!fileId) {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '请先选择要处理的文件');
    }
    return this.files.readObject(ctx.userId, fileId);
  }
}

// ---------- 参数取值工具 ----------

function toInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
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

function extOfFormat(format: string): string {
  return format === 'jpeg' ? 'jpg' : format;
}

function withSuffix(name: string, suffix: string, ext: string): string {
  const base = name.replace(/\.[^.]+$/, '');
  return `${base}${suffix}.${ext}`;
}

/** 入参图片的真实扩展名（认不出时按 jpeg 处理，与 Provider 默认一致） */
function imageExtOf(name: string): string {
  const m = /\.(jpe?g|png|webp|gif|avif|tiff?)$/i.exec(name);
  if (!m) return 'jpg';
  const ext = m[1].toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext;
}

/** 人类可读体积（用于进度文案，让用户直接看到省了多少） */
function mb(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}


/**
 * 读取图片真实宽高。
 *
 * 失败时返回空对象而不是抛错：指标是"附加信息"，
 * 不能因为它读不到就让一次成功的压缩失败（宁缺勿造）。
 */
async function imageSize(buffer: Buffer): Promise<{ width?: number; height?: number }> {
  try {
    const meta = await sharp(buffer).metadata();
    return { width: meta.width, height: meta.height };
  } catch {
    return {};
  }
}
