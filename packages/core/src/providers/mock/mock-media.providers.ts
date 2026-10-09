import { BizException, ErrorCode } from '../../errors';
import type {
  AudioProvider,
  DiagramRenderRequest,
  DocParseProvider,
  DocProvider,
  DocRenderInput,
  ImageCompressInput,
  ImageConvertInput,
  ImageProvider,
  OcrProvider,
  OcrResult,
  PptProvider,
  PptRenderInput,
  PptRenderResult,
  VideoInfo,
  VideoProvider,
} from '../types';

/** Mock OCR：返回带坐标的示例文本 */
export class MockOcrProvider implements OcrProvider {
  readonly name = 'mock-ocr';
  async recognize(_file: Buffer): Promise<OcrResult> {
    const text = '【演示模式 OCR 结果】\n青智校园\n这是一段由 MockOcrProvider 返回的示例识别文本。';
    return {
      blocks: [
        {
          text,
          box: [
            [0, 0],
            [100, 0],
            [100, 20],
            [0, 20],
          ],
          confidence: 0.99,
        },
      ],
      fullText: text,
      language: 'chi_sim+eng',
    };
  }
}

/** Mock PPT：产出一个最小但合法的 .pptx（ZIP 结构占位） */
export class MockPptProvider implements PptProvider {
  readonly name = 'mock-ppt';
  async render(input: PptRenderInput): Promise<PptRenderResult> {
    // 说明：这里产出的是占位字节。真实实现（PptxGenJS）会生成可打开的 pptx。
    const placeholder = Buffer.from(
      `PK\u0003\u0004 MOCK PPTX — ${input.title} — ${input.slides.length} slides`,
      'utf-8',
    );
    return { buffer: placeholder, pageCount: input.slides.length };
  }
  async listTemplates() {
    return [
      { id: 'business', name: '商务' },
      { id: 'tech', name: '科技' },
      { id: 'fresh', name: '清新' },
      { id: 'academic', name: '学术' },
      { id: 'chinese', name: '国潮' },
    ];
  }
}

/** Mock 文档生成 */
export class MockDocProvider implements DocProvider {
  readonly name = 'mock-doc';
  async renderDocx(input: DocRenderInput): Promise<Buffer> {
    return Buffer.from(`MOCK DOCX — ${input.title} — ${input.sections.length} sections`, 'utf-8');
  }
  async renderMarkdown(input: DocRenderInput): Promise<string> {
    const lines = [`# ${input.title}`, ''];
    for (const s of input.sections) {
      lines.push(`${'#'.repeat(s.level + 1)} ${s.heading}`, '');
      if (s.paragraphs) lines.push(...s.paragraphs, '');
      if (s.bullets) lines.push(...s.bullets.map((b) => `- ${b}`), '');
    }
    return lines.join('\n');
  }
}

/** Mock 图片处理：原样返回（仅用于打通链路） */
export class MockImageProvider implements ImageProvider {
  readonly name = 'mock-image';
  async compress(input: ImageCompressInput) {
    // Mock 不改内容，因此"压缩后体积不变"：ratio 恒为 1。
    // targetMet 如实反映这一点，不假装达成目标（红线 10）。
    return { buffer: input.buffer, ratio: 1, targetMet: !input.targetSizeBytes };
  }
  async convert(input: ImageConvertInput) {
    return input.buffer;
  }
  async removeBackground(buffer: Buffer) {
    return buffer;
  }
  async enhance(buffer: Buffer, _strength?: number) {
    return buffer;
  }
  async inpaint(buffer: Buffer) {
    return buffer;
  }
}

/** Mock 视频处理 */
export class MockVideoProvider implements VideoProvider {
  readonly name = 'mock-video';
  async probe(_buffer: Buffer): Promise<VideoInfo> {
    return {
      durationSec: 60,
      width: 1920,
      height: 1080,
      bitrate: 4_000_000,
      sizeBytes: 0,
      format: 'mp4',
    };
  }
  async compress(buffer: Buffer) {
    return buffer;
  }
  async convert(buffer: Buffer) {
    return buffer;
  }
  async cut(buffer: Buffer) {
    return buffer;
  }
  async burnSubtitle(buffer: Buffer) {
    return buffer;
  }
  /**
   * 图表渲染在 Mock 下**没有可给的演示产物**：一张假导图比没有图更糟
   * （用户会把它当成真实渲染结果转发出去）。显式抛错并说明如何开启 ——
   * 与 MockConvertProvider 同一纪律（红线 10）；
   * 调用方（generate_mindmap）捕获后只交付文本产物，不受影响。
   */
  async renderDiagram(_req: DiagramRenderRequest): Promise<Buffer> {
    throw new BizException(
      ErrorCode.ConvertServiceUnavailable,
      undefined,
      '图表渲染未启用（演示模式）：media 侧车安装 playwright + chromium 后设置 RENDER_PROVIDER=playwright',
    );
  }
}

/** Mock 音频处理 */
export class MockAudioProvider implements AudioProvider {
  readonly name = 'mock-audio';
  async convert(buffer: Buffer) {
    return buffer;
  }
  async cut(buffer: Buffer) {
    // 裁剪的"演示产物"就是原样返回 —— 界面会带"演示模式"角标，
    // 用户能看出这不是真的裁剪结果（真实现按起止时间截断）
    return buffer;
  }
  async denoise(buffer: Buffer) {
    return buffer;
  }
  async separateVocals(buffer: Buffer, stems: 2 | 4) {
    // 真实实现返回 2 或 4 条轨道；Mock 用同一份数据占位 ——
    // 界面会带"演示模式"角标，用户能看出这不是真的分离结果
    const names = stems === 4 ? ['drums', 'bass', 'other', 'vocals'] : ['vocals', 'accompaniment'];
    return names.map((name) => ({ name, data: buffer }));
  }
  async speechToText(_buffer: Buffer) {
    return {
      text: '【演示模式】这是一段示例转写文本。',
      segments: [{ start: 0, end: 3.2, text: '【演示模式】这是一段示例转写文本。' }],
    };
  }
  async textToSpeech(_text: string, _voice?: string) {
    // 演示产物是一段**可播放的提示音**，而不是真实语音。
    //
    // 为什么不是空 Buffer：空产物会被上层当成失败（`assertContentPresent` 那类判断），
    // 于是"演示模式"反而变成"功能报错"。也不是静音 —— 静音听起来像 bug，
    // 提示音一听就知道"这是占位"，再配合界面上的"演示模式"角标就完全可辨。
    return toneWav();
  }
}

/**
 * 生成一段 0.3 秒的提示音 WAV（Mock TTS 用）。
 *
 * 手写 WAV 头而不是引库：Mock 的价值在于"零依赖也能跑起来"，
 * 为一段占位音频引一个音频库得不偿失。
 */
function toneWav(seconds = 0.3, freq = 440, rate = 8000): Buffer {
  const samples = Math.round(seconds * rate);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.sin((2 * Math.PI * freq * i) / rate) * 8000;
    pcm.writeInt16LE(Math.round(v), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Mock 文档解析 */
export class MockDocParseProvider implements DocParseProvider {
  readonly name = 'mock-doc-parse';
  async parse(_buffer: Buffer, filename: string) {
    return {
      text: `【演示模式】已解析 ${filename}，此处为示例文本内容。`,
      pages: [{ index: 1, text: `【演示模式】${filename} 第 1 页示例内容` }],
      meta: { pages: '1' },
    };
  }
}
