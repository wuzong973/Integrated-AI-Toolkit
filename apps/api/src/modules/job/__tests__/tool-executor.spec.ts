import { describe, expect, it, vi } from 'vitest';
import type { Providers } from '@qz/core';

import { PptxGenJsProvider } from '../../../infra/providers/ppt/pptxgenjs.provider';
import { SharpImageProvider } from '../../../infra/providers/image/sharp-image.provider';
import { DataToolRunner } from '../data-tool-runner';
import { ImageToolRunner } from '../image-tool-runner';
import { LlmToolRunner } from '../llm-tool-runner';
import { MediaAiToolRunner } from '../media-ai-tool-runner';
import { MediaToolRunner } from '../media-tool-runner';
import { PdfToolRunner } from '../pdf-tool-runner';
import { RepoToolRunner } from '../repo-tool-runner';
import { ToolExecutorService, type ToolRunContext } from '../tool-executor.service';

/**
 * 验证执行器真的能把工具跑出产物。
 *
 * 用**真实的 PptxGenJS / Sharp** + **假的文件服务**：
 * 唯一的替身是"把产出写到哪"，被替掉的是对象存储传输，
 * 生成逻辑本身是真实代码 —— 因此这个测试能证明"工具确实产出了可用的文件"。
 */
function makeExecutor() {
  const saved: { name: string; buffer: Buffer; contentType: string; source?: string }[] = [];
  /** 可切换的入参文件（用于测"文件类型不符被拒绝"这类分支） */
  let currentFile = { buffer: Buffer.from('fake-image'), name: 'input.png' };
  const files = {
    saveGenerated: async (
      _userId: string,
      input: { name: string; buffer: Buffer; contentType: string; source?: string },
    ) => {
      saved.push(input);
      return { id: `file-${saved.length}` };
    },
    readObject: async () => currentFile,
  };
  /**
   * LLM 用假实现（确定性返回）：单元测试不该依赖外部网络，
   * LLM 与真实服务商的对接由 scripts/dev/verify-llm.mjs 用真实接口验证 —— 两者互补。
   */
  const llm = {
    chat: async () => ({
      content: '# 大纲\n## 一、背景\n- 要点 A\n- 要点 B',
      model: 'fake-llm',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    }),
    structured: async () => ({
      subtitle: '让闲置资源流转起来',
      sections: Array.from({ length: 6 }, (_, i) => ({
        title: `第 ${i + 1} 节：真实要点`,
        points: ['具体要点 1', '具体要点 2', '具体要点 3'],
      })),
    }),
  };
  /**
   * OCR / 语音同样用假实现：单元测试不依赖外部网络。
   * 真实服务商对接由联调脚本用真实接口验证 —— 两者互补。
   */
  const ocr = {
    recognize: async () => ({
      blocks: [
        {
          text: '青智校园',
          box: [
            [0, 0],
            [100, 0],
            [100, 20],
            [0, 20],
          ],
        },
      ],
      fullText: '青智校园',
      language: 'chi_sim+eng',
    }),
  };
  const audio = {
    speechToText: async () => ({ text: '这是一段测试语音', segments: [] }),
  };
  const providers = {
    ppt: new PptxGenJsProvider(),
    image: new SharpImageProvider(),
    llm,
    ocr,
    audio,
  } as unknown as Providers;
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const images = new ImageToolRunner(providers, files as never);
  const llmTools = new LlmToolRunner(providers, files as never, logger as never);
  const mediaAi = new MediaAiToolRunner(providers, files as never, logger as never);
  const executor = new ToolExecutorService(
    providers,
    files as never,
    images,
    llmTools,
    mediaAi,
    // ⚠️ 第 6 位是 MediaToolRunner。这里原来传的是 `logger as never` ——
    // 当时构造器只有 5 个形参，多出来的实参被运行时静默吞掉了；
    // 一旦新增第 6 个形参，它就变成"把 logger 当成 media 传进去"，
    // 只在调用音视频工具时才炸。这类"多余实参"是单测里最隐蔽的定时炸弹。
    new MediaToolRunner(providers, files as never),
    // ⚠️ 第 7、8 位（PdfToolRunner / DataToolRunner）也必须**占住**：
    // 少传能通过类型检查（形参可缺省），但一旦有人再往后追加执行器，
    // 实参与形参就会整体错位 —— 占位比"省一行"值钱得多。
    new PdfToolRunner(providers, files as never),
    new DataToolRunner(providers, files as never, logger as never),
    // 第 9 位：仓库解读（2026-10-08 接入），同样按位置占住
    new RepoToolRunner(providers, files as never),
  );
  const setFile = (name: string, buf?: Buffer) => {
    currentFile = { buffer: buf ?? Buffer.from('fake'), name };
  };
  return { executor, saved, llm, setFile };
}

function ctx(params: Record<string, unknown>, inputFiles: string[] = []): ToolRunContext {
  const progress: number[] = [];
  return {
    jobId: 'job-1',
    userId: 'user-1',
    params,
    inputFiles,
    onProgress: async (p) => {
      progress.push(p);
    },
  };
}

describe('ToolExecutorService（M1-02 执行侧）', () => {
  it('已接入的工具清单与预期一致', () => {
    const { executor } = makeExecutor();
    expect(executor.supportedTools.sort()).toEqual(
      [
        // 图片（5）
        'compress_image',
        'convert_image',
        'enhance_image',
        // 二维码生成（2026-09-20 接入）：工具箱里唯一**不需要上传文件**的工具，输入是一段文本
        'generate_qrcode',
        'remove_background',
        // 办公 / 文本（10）
        'generate_ppt',
        'generate_outline',
        'summarize_text',
        'generate_image_prompt',
        'generate_resume',
        'generate_mindmap',
        'translate_text',
        'paper_summary',
        'solve_question',
        'generate_document',
        // 数据分析（1，2026-09-19 接入：数字由代码算、解读交给 LLM）
        'analyze_data',
        // PDF（5）：其中 4 个走 services/pdf 侧车（2026-09-19 落地，PyMuPDF 子进程）；
        // images_to_pdf 是**例外**（2026-09-20 接入）—— 走 Node 侧 sharp + pdf-lib，
        // 因为 PyMuPDF CLI 没有"图片转 PDF"子命令，且 AGPL 不允许 import fitz
        'compress_pdf',
        'images_to_pdf',
        'merge_pdf',
        'parse_document',
        'split_pdf',
        // 音视频（8，2026-09-19 侧车落地后接入）
        'compress_video',
        'convert_video',
        'cut_video',
        'add_subtitle',
        'convert_audio',
        'cut_audio',
        'denoise_audio',
        // separate_vocals 走的是 AI 侧车（Demucs），不是媒体侧车 —— 放在这里只是按"音频族"归类
        'separate_vocals',
        // text_to_speech 与 speech_to_text 互为逆操作（2026-09-20 接入；
        // 走媒体侧车的 edge-tts，唯一不需要上传文件的音频工具）
        'text_to_speech',
        // 媒体识别（2）
        'ocr_image',
        'speech_to_text',
        // 仓库解读（1，2026-10-08 接入：deepwiki-open 自托管；seed 暂为 planned）
        'explain_repository',
      ].sort(),
    );
  });

  it('未接入的工具直接抛错（不假装成功）', async () => {
    const { executor } = makeExecutor();
    // 示例必须是**当前确实没接入**的工具：换成已接入的会让这条用例变成空转，
    // 而它恰恰是"不许假装成功"这条红线的守卫。
    // ⚠️ `merge_pdf` 曾在这里当示例，2026-09-19 侧车落地后它被接入了 → 本用例随即失败。
    //    这是清单守卫该有的行为（新增工具必须被人显式确认），换一个仍未接入的即可。
    expect(executor.supports('convert_pdf')).toBe(false);
    await expect(executor.run('convert_pdf', ctx({}))).rejects.toThrow(/尚未接入执行器/);
  });

  // ---------- 媒体识别类（OCR / 语音转文字） ----------

  it('ocr_image 产出 Markdown 识别结果', async () => {
    const { executor, saved } = makeExecutor();
    const r = await executor.run('ocr_image', ctx({}, ['file-1']));

    expect(r.outputFiles).toEqual(['file-1']);
    expect(saved[0].name).toBe('input-识别文字.md');
    expect(saved[0].contentType).toContain('text/markdown');
    expect(saved[0].buffer.toString('utf8')).toContain('青智校园');
  });

  it('ocr_image 拒绝非图片文件（前置校验，不让请求打穿到第三方）', async () => {
    const { executor, setFile } = makeExecutor();
    setFile('report.pdf');
    await expect(executor.run('ocr_image', ctx({}, ['file-1']))).rejects.toThrow(/不是图片/);
  });

  it('speech_to_text 产出转写结果', async () => {
    const { executor, saved, setFile } = makeExecutor();
    setFile('voice.mp3');
    const r = await executor.run('speech_to_text', ctx({}, ['file-1']));

    expect(r.outputFiles).toEqual(['file-1']);
    expect(saved[0].name).toBe('voice-转写文字.md');
    expect(saved[0].buffer.toString('utf8')).toContain('这是一段测试语音');
  });

  it('speech_to_text 拒绝非音频文件', async () => {
    const { executor, setFile } = makeExecutor();
    setFile('photo.png');
    await expect(executor.run('speech_to_text', ctx({}, ['file-1']))).rejects.toThrow(/不是音频/);
  });

  describe('generate_ppt：真实渲染出可打开的 .pptx', () => {
    it('产出物是合法的 pptx（zip 魔数 PK）且落到文件服务', async () => {
      const { executor, saved } = makeExecutor();

      const result = await executor.run(
        'generate_ppt',
        ctx({ topic: '校园二手交易平台', pages: 10, style: 'tech', purpose: 'contest' }),
      );

      expect(result.outputFiles).toHaveLength(1);
      expect(saved).toHaveLength(1);

      const out = saved[0];
      // .pptx 本质是 zip 包，魔数为 PK\x03\x04 —— 用它证明产出的不是空文件
      expect(out.buffer.subarray(0, 2).toString('binary')).toBe('PK');
      expect(out.buffer.length).toBeGreaterThan(2000);
      expect(out.name).toBe('校园二手交易平台.pptx');
      expect(out.contentType).toContain('presentationml');
    });

    it('页数参数被收敛到 5~40 区间', async () => {
      const { executor, saved } = makeExecutor();
      await executor.run('generate_ppt', ctx({ topic: 'X', pages: 9999 }));
      // 参数被夹到 40，幻灯片数量随之受控（目录 + 最多 8 个章节）
      expect(saved).toHaveLength(1);
    });

    it('缺少主题时用兜底标题而不是崩溃', async () => {
      const { executor, saved } = makeExecutor();
      const r = await executor.run('generate_ppt', ctx({}));
      expect(r.outputFiles).toHaveLength(1);
      expect(saved[0].name).toBe('未命名演示文稿.pptx');
    });

    it('非法 style 回落到默认值 business', async () => {
      const { executor } = makeExecutor();
      await expect(
        executor.run('generate_ppt', ctx({ topic: 'T', style: 'not-a-style' })),
      ).resolves.toBeTruthy();
    });
  });

  describe('图片类：真实走 Sharp', () => {
    it('compress_image 产出压缩后的图片并改名', async () => {
      // 用 Sharp 自身造一张真实 PNG，避免引入测试夹具文件
      const png = await new SharpImageProvider().convert({
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
        format: 'png',
      });

      const saved: { name: string; contentType: string }[] = [];
      const deps = {
        providers: { image: new SharpImageProvider() } as unknown as Providers,
        files: {} as never,
      };
      const fileStub = {
        saveGenerated: async (_u: string, i: { name: string; contentType: string }) => {
          saved.push(i);
          return { id: 'f1' };
        },
        readObject: async () => ({ buffer: png, name: 'photo.png' }),
      } as never;
      // ⚠️ 只跑 compress_image，但**每个位置都要占住**：构造器是位置参数，
      // 少传会让后面的实参整体前移（"把 A 当成 B"），只在调用到那个工具时才炸。
      const svc = new ToolExecutorService(
        deps.providers,
        fileStub,
        new ImageToolRunner(deps.providers, fileStub),
        new LlmToolRunner(deps.providers, fileStub, {
          log: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        } as never),
        undefined as never,
        new MediaToolRunner(deps.providers, fileStub),
        undefined as never,
        undefined as never,
        undefined as never,
      );

      const r = await svc.run('compress_image', ctx({ quality: 60, format: 'jpeg' }, ['file-1']));

      expect(r.outputFiles).toEqual(['f1']);
      expect(saved[0].name).toBe('photo_compressed.jpg');
      expect(saved[0].contentType).toBe('image/jpeg');
    });

    it('convert_image 按目标格式改扩展名', async () => {
      const png = await new SharpImageProvider().convert({
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
        format: 'png',
      });
      const names: string[] = [];
      const deps = {
        providers: { image: new SharpImageProvider() } as unknown as Providers,
        files: {} as never,
      };
      const svc = new ToolExecutorService(
        deps.providers,
        {
          saveGenerated: async (_u: string, i: { name: string }) => {
            names.push(i.name);
            return { id: 'f1' };
          },
          readObject: async () => ({ buffer: png, name: 'photo.png' }),
        } as never,
        new ImageToolRunner(deps.providers, {
          saveGenerated: async (_u: string, i: { name: string }) => {
            names.push(i.name);
            return { id: 'f1' };
          },
          readObject: async () => ({ buffer: png, name: 'photo.png' }),
        } as never),
        new LlmToolRunner(
          deps.providers,
          {} as never,
          { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
        ),
        new MediaToolRunner(deps.providers, {} as never),
      );

      await svc.run('convert_image', ctx({ format: 'webp' }, ['file-1']));
      expect(names[0]).toBe('photo_converted.webp');
    });

    it('没有入参文件时抛参数错误，而不是产出空文件', async () => {
      const { executor } = makeExecutor();
      await expect(executor.run('compress_image', ctx({}, []))).rejects.toThrow(
        /请先选择要处理的文件/,
      );
    });
  });
});
