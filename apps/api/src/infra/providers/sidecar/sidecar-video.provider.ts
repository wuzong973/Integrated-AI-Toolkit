import { BizException, ErrorCode, type DiagramRenderRequest, type VideoInfo, type VideoProvider } from '@qz/core';

import { sniffMedia } from './magic';
import type { SidecarClient } from './sidecar.client';

/**
 * 音视频 Provider —— 由 `services/media` 侧车执行（M4-01 / M4-03）。
 *
 * ## 为什么音视频必须外置
 *
 * FFmpeg 是**系统级二进制**，而且必须是 LGPL 构建（GPL 构建会污染主工程许可）。
 * Node 侧既没有可靠的进程内 ffmpeg 绑定（都是包装 CLI，等于多一层依赖），
 * 也不该让业务进程去持有几百 MB 的内存缓冲与 CPU 密集的解码循环。
 * 所以后端只做"转发 + 语义翻译"，真正的处理在侧车。
 *
 * ## 每个方法都对应侧车的一个端点
 *
 * | 方法 | 端点 | 说明 |
 * |---|---|---|
 * | probe | `/media/probe` | 入参是文件、出参是 JSON |
 * | compress | `/media/compress` | 按目标体积反推码率 |
 * | convert | `/media/transcode` | mp4 / webm / gif |
 * | cut | `/media/cut` | 默认流复制，秒级完成 |
 * | burnSubtitle | `/media/subtitle` | 字幕文本随表单字段传 |
 * | renderDiagram | `/media/render-diagram` | Mermaid / markmap → PNG（JSON 入参） |
 *
 * ## 两处"绝不假装"的地方
 *
 * 1. **入参缺目标体积时抛错，而不是猜一个默认值**：压缩的本质就是"压到某个体积"，
 *    没有目标值时任何默认值都只是把用户的视频压得又糊又不达标。
 * 2. **字幕烧录失败就直接失败**：字幕没烧上去的视频看起来完全正常，
 *    用户要等到播放时才发现 —— 这种"静默错"比报错糟得多。
 */
export class SidecarVideoProvider implements VideoProvider {
  readonly name = 'media-sidecar';

  constructor(
    private readonly media: SidecarClient,
    /**
     * 分享图渲染是否开启（RENDER_PROVIDER=playwright）。
     *
     * 它**不是** video 族的开关（那由工厂决定），只是本类里这一个方法的开关：
     * 未开启时 `renderDiagram` 抛"未启用"而不是打侧车（侧车没装 playwright 时
     * 也只会还回 501，提前拦能少一次注定失败的网络往返，文案也更可执行）。
     */
    private readonly renderEnabled = false,
  ) {}

  /** 探测媒体信息（时长 / 分辨率 / 码率 / 编码） */
  async probe(buffer: Buffer): Promise<VideoInfo> {
    return this.media.json<VideoInfo>(
      '/media/probe',
      {},
      { errorCode: ErrorCode.ConvertServiceUnavailable, capability: '媒体探测' },
      this.file(buffer),
    );
  }

  /**
   * 压缩到目标体积。
   *
   * 侧车按 `目标字节 × 8 ÷ 时长 − 音频码率` 反推视频码率，
   * 因此**必须**有目标体积；缺失时在这里就报错，
   * 不让请求白跑一趟（也能让调用方立刻发现参数没传对）。
   */
  async compress(buffer: Buffer, targetSizeBytes?: number, crf?: number): Promise<Buffer> {
    if (!targetSizeBytes || targetSizeBytes <= 0) {
      throw new BizException(
        ErrorCode.AiOutputInvalid,
        { tool: 'compress_video' },
        '请指定目标体积后再压缩（缺少 targetSizeBytes）',
      );
    }

    const fields: Record<string, string | number> = { targetSizeBytes };
    if (crf !== undefined) fields.crf = crf;

    return this.run('/media/compress', '视频压缩', buffer, fields);
  }

  async convert(buffer: Buffer, format: 'mp4' | 'webm' | 'gif'): Promise<Buffer> {
    return this.run('/media/transcode', '格式转换', buffer, { format });
  }

  /**
   * 裁剪片段。
   *
   * ⚠️ 侧车默认走**流复制**，切点会对齐到最近关键帧 —— 实际时长可能与请求值
   * 相差几百毫秒。这是刻意的取舍（秒级完成 vs 帧级精确），
   * 需要精确时改走重编码即可；本次返回的字节是真实产物，不做二次裁剪。
   */
  async cut(buffer: Buffer, startSec: number, endSec: number): Promise<Buffer> {
    return this.run('/media/cut', '视频裁剪', buffer, { startSec, endSec });
  }

  async burnSubtitle(buffer: Buffer, srt: string): Promise<Buffer> {
    if (!srt.trim()) {
      throw new BizException(ErrorCode.AiOutputInvalid, undefined, '字幕内容为空，无法烧录');
    }
    return this.run('/media/subtitle', '字幕烧录', buffer, { srt });
  }

  /**
   * 图表渲染：Mermaid / markmap 源码 → PNG（分享图）。
   *
   * 入参是**结构化代码**而非文件，所以走 `jsonBinary`（JSON 请求体）而不是
   * 其他方法的 multipart。渲染未开启时抛"未启用"并说明如何开启 ——
   * 调用方（generate_mindmap）把它当增量能力对待：捕获后只交付文本产物。
   */
  async renderDiagram(req: DiagramRenderRequest): Promise<Buffer> {
    if (!this.renderEnabled) {
      throw new BizException(
        ErrorCode.ConvertServiceUnavailable,
        { kind: req.kind },
        '图表渲染未启用：设置 RENDER_PROVIDER=playwright，并在 media 侧车安装 playwright + chromium',
      );
    }
    if (!req.code.trim()) {
      throw new BizException(ErrorCode.AiOutputInvalid, undefined, '图表代码为空，无法渲染');
    }
    const result = await this.media.jsonBinary(
      '/media/render-diagram',
      { kind: req.kind, code: req.code, format: 'png' },
      { errorCode: ErrorCode.ConvertServiceUnavailable, capability: '图表渲染' },
    );
    return result.buffer;
  }

  /** 统一的"发文件 + 收产物"路径，避免五个方法各写一遍错误语义 */
  private async run(
    path: string,
    capability: string,
    buffer: Buffer,
    fields: Record<string, string | number>,
  ): Promise<Buffer> {
    const result = await this.media.binary(
      path,
      this.file(buffer),
      fields,
      { errorCode: ErrorCode.ConvertServiceUnavailable, capability },
    );
    return result.buffer;
  }

  /** 扩展名必须由魔数决定：ffmpeg 按扩展名选解复用器，猜错会报无关的错 */
  private file(buffer: Buffer): { filename: string; contentType: string; data: Buffer } {
    const type = sniffMedia(buffer);
    return { filename: `input.${type.ext}`, contentType: type.contentType, data: buffer };
  }
}
