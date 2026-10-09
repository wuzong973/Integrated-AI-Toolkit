import { Inject, Injectable } from '@nestjs/common';
import { BizException, ErrorCode, type OcrResult, type Providers } from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import { PROVIDERS } from '../../infra/providers/providers.module';
import { FileService } from '../file/file.service';

import type { ToolRunContext, ToolRunResult } from './tool-executor.service';

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|heic)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|opus|amr|wma)$/i;

/**
 * 媒体识别类工具执行器（OCR / 语音转文字）
 *
 * 与 `ImageToolRunner`（像素处理）、`LlmToolRunner`（纯文本）并列：
 * 这一类工具的共同点是 **输入是媒体、输出是文字** —— 需要视觉/听觉模型，
 * 走 `providers.ocr` 与 `providers.audio.speechToText`，产物统一落成可下载的 Markdown。
 *
 * ## 为什么先校验扩展名
 *
 * 把 PDF 丢给 OCR 模型、把视频丢给 ASR，模型侧只会返回一个含糊的失败或空结果，
 * 用户看不出是"文件不对"还是"服务挂了"。这里前置拒绝并说清支持哪些格式，
 * 比让请求打穿到第三方再失败更容易排查（红线 9 的同一条精神）。
 */
@Injectable()
export class MediaAiToolRunner {
  constructor(
    @Inject(PROVIDERS) private readonly providers: Providers,
    private readonly files: FileService,
    private readonly logger: AppLogger,
  ) {}

  /** OCR 文字识别：图片 → Markdown 文本 */
  async ocr(ctx: ToolRunContext): Promise<ToolRunResult> {
    const src = await this.files.readObject(ctx.userId, firstInput(ctx));
    if (!IMAGE_EXT.test(src.name)) {
      throw new BizException(
        ErrorCode.FileFormatUnsupported,
        { list: 'png / jpg / webp / gif / bmp' },
        `「${src.name}」不是图片，文字识别只支持图片格式`,
      );
    }

    await ctx.onProgress(30, '正在识别文字');
    const lang = typeof ctx.params.lang === 'string' ? ctx.params.lang : undefined;
    const result = await this.providers.ocr.recognize(src.buffer, { lang });

    await ctx.onProgress(80, '正在保存识别结果');
    const out = await this.files.saveGenerated(ctx.userId, {
      name: `${stripExt(src.name)}-识别文字.md`,
      buffer: Buffer.from(renderOcr(result, src.name), 'utf8'),
      contentType: 'text/markdown; charset=utf-8',
      source: 'ocr_image',
    });
    this.logger.log(
      `OCR 完成：${src.name} → ${result.fullText.length} 字符 / ${result.blocks.length} 段`,
      'MediaAiTool',
    );
    return { outputFiles: [out.id] };
  }

  /** 语音转文字：音频 → Markdown 文本 */
  async speechToText(ctx: ToolRunContext): Promise<ToolRunResult> {
    const src = await this.files.readObject(ctx.userId, firstInput(ctx));
    if (!AUDIO_EXT.test(src.name)) {
      throw new BizException(
        ErrorCode.FileFormatUnsupported,
        { list: 'mp3 / wav / m4a / aac / flac / ogg' },
        `「${src.name}」不是音频，语音转文字只支持音频格式`,
      );
    }

    await ctx.onProgress(30, '正在转写语音');
    const language = typeof ctx.params.language === 'string' ? ctx.params.language : undefined;
    const { text } = await this.providers.audio.speechToText(src.buffer, { language });

    await ctx.onProgress(80, '正在保存转写结果');
    const out = await this.files.saveGenerated(ctx.userId, {
      name: `${stripExt(src.name)}-转写文字.md`,
      buffer: Buffer.from(renderTranscript(text, src.name), 'utf8'),
      contentType: 'text/markdown; charset=utf-8',
      source: 'speech_to_text',
    });
    this.logger.log(`ASR 完成：${src.name} → ${text.length} 字符`, 'MediaAiTool');
    return { outputFiles: [out.id] };
  }

  /**
   * 文本转语音（TTS）—— 与 `speechToText` 恰好互为逆操作。
   *
   * ⚠️ 这是本类（乃至整个音频族）唯一**没有输入文件**的方法：
   * 文本来自参数，不是上传的素材，所以不读 `ctx.inputFiles`。
   *
   * 合成由媒体侧车的 edge-tts 完成（LGPLv3：独立安装 + 子进程调用，不入库）。
   */
  async textToSpeech(ctx: ToolRunContext): Promise<ToolRunResult> {
    const text = typeof ctx.params.text === 'string' ? ctx.params.text.trim() : '';
    if (!text) {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '请先填写要朗读的文本');
    }
    if (text.length > MAX_TTS_CHARS) {
      throw new BizException(
        ErrorCode.ParamInvalid,
        { length: text.length, max: MAX_TTS_CHARS },
        `文本过长（${text.length} 字，上限 ${MAX_TTS_CHARS}）—— 请分段后再合成`,
      );
    }

    const voice = typeof ctx.params.voice === 'string' ? ctx.params.voice : undefined;
    await ctx.onProgress(25, '正在合成语音');
    const buffer = await this.providers.audio.textToSpeech(text, voice);

    await ctx.onProgress(85, '正在保存音频');
    const out = await this.files.saveGenerated(ctx.userId, {
      name: `${fileStem(text)}-朗读.mp3`,
      buffer,
      contentType: 'audio/mpeg',
      source: 'text_to_speech',
    });
    this.logger.log(`TTS 完成：${text.length} 字 → ${buffer.length} 字节`, 'MediaAiTool');
    return {
      outputFiles: [out.id],
      metrics: {
        // 音视频族统一用 `media`（`JobResultMetrics.kind` 里没有单独的 audio）
        kind: 'media',
        inputBytes: Buffer.byteLength(text, 'utf8'),
        outputBytes: buffer.length,
      },
    };
  }
}

// ---------- 产物渲染 ----------

/** OCR 产物：正文优先，坐标信息（若模型返回）作为附注 */
function renderOcr(result: OcrResult, filename: string): string {
  const lines = [`# ${filename} 文字识别结果`, '', result.fullText.trim(), ''];

  const located = result.blocks.filter((b) => b.box);
  if (located.length > 0) {
    lines.push('---', '', `> 本结果含 ${located.length} 段版面坐标（0~1000 归一化），可用于还原位置。`);
  }
  return lines.join('\n');
}

function renderTranscript(text: string, filename: string): string {
  return [`# ${filename} 语音转写结果`, '', text.trim(), ''].join('\n');
}

// ---------- 参数取值工具 ----------

/**
 * 单次合成的文本上限，与侧车（`services/media` 的 `MAX_TTS_CHARS`）保持一致。
 *
 * 两边都拦一次是刻意的：后端拦能给出**面向用户的中文提示**，
 * 侧车拦是**最后一道**（防止别的调用方绕过工具链路直接打端点）。
 */
const MAX_TTS_CHARS = 3000;

/** 从文本取一段可做文件名的前缀：去掉路径分隔符等非法字符，否则会生成打不开的文件 */
function fileStem(text: string, max = 12): string {
  const cleaned = text.replace(/[\\/:*?"<>|\s]+/g, '');
  return cleaned.slice(0, max) || '朗读';
}

/** 取第一个入参文件 id；没有就报错 */
function firstInput(ctx: ToolRunContext): string {
  const id = ctx.inputFiles[0];
  if (!id) throw new BizException(ErrorCode.ParamInvalid, undefined, '请先选择要处理的文件');
  return id;
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}
