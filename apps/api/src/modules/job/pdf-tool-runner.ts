import { Inject, Injectable } from '@nestjs/common';
import { BizException, ErrorCode, type Providers } from '@qz/core';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';

import { PROVIDERS } from '../../infra/providers/providers.module';
import { FileService } from '../file/file.service';

import type { ToolRunContext, ToolRunResult } from './tool-executor.service';

/** A4 尺寸（pt，72 units/inch）。仅"统一页面尺寸"模式使用 */
const A4_W = 595.28;
const A4_H = 841.89;

/**
 * PDF 类工具执行器（merge / split / compress / parse_document）。
 *
 * ## 为什么这类工具此前一直是 `planned`
 *
 * 不是后端不会写，而是**引擎进不来**：PDF 引擎 PyMuPDF 是 AGPL-3.0，
 * 仓库红线禁止把它装进 `services/`。红线是对的 —— 但它把这条链路冻住了。
 *
 * 解法不是绕过红线，而是**换一种满足红线的方式**：
 * 引擎独立安装（仓库之外），`services/pdf` 侧车以**子进程**调它的 CLI，
 * 主工程只跟侧车说话。这与 LibreOffice / Pandoc 的用法完全同构，
 * 所以 `requirements.txt` 依然是空的、AGPL 代码也依然没有进仓库。
 *
 * ## 产物一律写回文件资产（与图片/音视频同一条纪律）
 *
 * `source` 记来源工具名 —— 排查"这个文件是谁生成的"、按工具统计都靠它。
 */
@Injectable()
export class PdfToolRunner {
  constructor(
    @Inject(PROVIDERS) private readonly providers: Providers,
    private readonly files: FileService,
  ) {}

  /**
   * 图片合成 PDF（作业 / 实验报告拍照 → 合成一份 PDF 提交）
   *
   * ## 为什么用 pdf-lib 而不是走 PyMuPDF 侧车
   *
   * 本文件其余能力都靠 `services/pdf` 子进程调 PyMuPDF，但它**做不了这件事**：
   * 实测 PyMuPDF CLI 的子命令只有 `show / clean / join / extract / embed-* /
   * gettext / internal`，**没有"图片转 PDF"**；而它是 AGPL，也不允许 `import fitz` 绕过。
   * 所以改走 Node 侧的 pdf-lib（MIT，纯 JS、无原生依赖）。
   * ⚠️ 这纠正了先前的一个判断：本能力**不是**"零新依赖"。
   */
  async imagesToPdf(ctx: ToolRunContext, tool: string): Promise<ToolRunResult> {
    if (!ctx.inputFiles.length) {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '请先上传要合成的图片');
    }

    const inputs = await this.readAll(ctx);
    const pageSize = ctx.params.pageSize === 'a4' ? 'a4' : 'auto';
    const quality = clamp(ctx.params.quality, 85, 30, 100);
    // 长边上限：手机直出照片动辄 4000px，原样嵌进去 PDF 会几十 MB、交不上去
    const maxSide = clamp(ctx.params.maxSide, 1600, 400, 4000);

    const doc = await PDFDocument.create();
    for (const [i, f] of inputs.entries()) {
      await ctx.onProgress(
        20 + Math.round((i / inputs.length) * 60),
        `正在排版第 ${i + 1} / ${inputs.length} 张`,
      );
      await this.layoutPage(doc, f.buffer, pageSize, quality, maxSide);
    }

    const buffer = Buffer.from(await doc.save());
    await ctx.onProgress(85, '正在保存');
    const base = (inputs[0].filename || '图片').replace(/\.[^.]+$/, '');

    return {
      outputFiles: [
        (
          await this.save(
            ctx,
            {
              buffer,
              filename: `${base}等${inputs.length}张-合成.pdf`,
              contentType: 'application/pdf',
            },
            tool,
          )
        ).id,
      ],
      metrics: {
        kind: 'pdf',
        inputBytes: inputs.reduce((a, f) => a + f.buffer.length, 0),
        outputBytes: buffer.length,
        pages: doc.getPageCount(),
      },
    };
  }

  /** 一张图排成一页。统一转 JPEG：PDF 里 JPEG 走 DCTDecode，体积远小于嵌 PNG 像素流 */
  private async layoutPage(
    doc: PDFDocument,
    src: Buffer,
    pageSize: 'auto' | 'a4',
    quality: number,
    maxSide: number,
  ): Promise<void> {
    // rotate() 先吃掉 EXIF 方向：手机竖拍的照片不这么做会躺倒
    const jpeg = await sharp(src, { failOn: 'none' })
      .rotate()
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
    const meta = await sharp(jpeg).metadata();
    const w = meta.width ?? A4_W;
    const h = meta.height ?? A4_H;
    const image = await doc.embedJpg(jpeg);

    if (pageSize !== 'a4') {
      doc.addPage([w, h]).drawImage(image, { x: 0, y: 0, width: w, height: h });
      return;
    }
    // A4：等比缩放并居中，长边不超出、比例不变形
    const scale = Math.min(A4_W / w, A4_H / h);
    const dw = w * scale;
    const dh = h * scale;
    doc.addPage([A4_W, A4_H]).drawImage(image, {
      x: (A4_W - dw) / 2,
      y: (A4_H - dh) / 2,
      width: dw,
      height: dh,
    });
  }

  /** 合并多个 PDF：**顺序就是上传顺序**，界面上的选择顺序要保住 */
  async merge(ctx: ToolRunContext, tool: string): Promise<ToolRunResult> {
    if (ctx.inputFiles.length < 2) {
      throw new BizException(
        ErrorCode.ParamInvalid,
        { count: ctx.inputFiles.length },
        '合并至少需要选择 2 个 PDF 文件',
      );
    }

    const inputs = await this.readAll(ctx);
    await ctx.onProgress(30, `正在合并 ${inputs.length} 个文件`);

    const out = await this.providers.pdf.merge({ files: inputs });
    await ctx.onProgress(85, '正在保存');

    return {
      outputFiles: [(await this.save(ctx, out, tool)).id],
      metrics: {
        kind: 'pdf',
        inputBytes: inputs.reduce((a, f) => a + f.buffer.length, 0),
        outputBytes: out.buffer.length,
        pages: toPageCount(out.meta['x-page-count']),
      },
    };
  }

  /** 拆分：默认每页一份；`ranges` 按范围分组，产物是 ZIP */
  async split(ctx: ToolRunContext, tool: string): Promise<ToolRunResult> {
    const src = await this.firstInput(ctx);
    const mode = toMode(ctx.params.mode);
    const ranges = toRanges(ctx.params.ranges, mode);

    await ctx.onProgress(30, '正在拆分');
    const out = await this.providers.pdf.split({ file: src, mode, ranges });
    await ctx.onProgress(85, `已拆成 ${out.meta['x-part-count'] ?? '?'} 份，正在打包`);

    return { outputFiles: [(await this.save(ctx, out, tool)).id] };
  }

  /**
   * 压缩：**必须真的变小，否则报错**。
   *
   * 侧车已经把"压完更大"拦成 422，这里再做一层兜底转换：
   * 用户要的是"省空间"，把一个没变小的文件标成"压缩成功"是自欺。
   */
  async compress(ctx: ToolRunContext, tool: string): Promise<ToolRunResult> {
    const src = await this.firstInput(ctx);
    await ctx.onProgress(30, '正在优化');

    let out;
    try {
      out = await this.providers.pdf.compress({ file: src });
    } catch (e) {
      throw translate(e, src.buffer.length);
    }

    const before = Number(out.meta['x-original-bytes'] ?? src.buffer.length);
    const after = Number(out.meta['x-output-bytes'] ?? out.buffer.length);
    await ctx.onProgress(85, `已从 ${formatKiB(before)} 压到 ${formatKiB(after)}`);

    return {
      outputFiles: [(await this.save(ctx, out, tool)).id],
      metrics: {
        kind: 'pdf',
        inputBytes: before,
        outputBytes: after,
        pages: toPageCount(out.meta['x-page-count']),
      },
    };
  }

  /**
   * 文档解析：产物是**文本文件**（.md），供用户阅读与后续加工。
   *
   * 不把纯文本直接塞进响应 —— 与文本类工具同一条 UX：
   * 走 `outputFiles`（可下载、可转交别人继续处理）。
   */
  async parse(ctx: ToolRunContext, tool: string): Promise<ToolRunResult> {
    const src = await this.firstInput(ctx);
    await ctx.onProgress(30, '正在解析');

    const parsed = await this.providers.docParse.parse(src.buffer, src.filename ?? 'input.pdf');
    if (!parsed.text.trim()) {
      throw new BizException(
        ErrorCode.ParamInvalid,
        undefined,
        '这份 PDF 里没有可提取的文字（可能是扫描件，请改用「OCR 文字识别」）',
      );
    }

    await ctx.onProgress(85, `已解析 ${parsed.pages?.length ?? 0} 页，正在保存`);
    const markdown = await this.providers.doc.renderMarkdown({
      title: `${stripPdf(src.filename ?? 'input.pdf')} · 解析结果`,
      sections: [
        {
          heading: '说明',
          level: 1,
          paragraphs: [
            `来源：${src.filename ?? 'input.pdf'}（共 ${parsed.meta?.['pageCount'] ?? parsed.pages?.length ?? '?'} 页，` +
              `${parsed.text.length} 字）。以下为按页提取的文本，段落顺序与原文一致。`,
          ],
        },
        { heading: '正文', level: 1, paragraphs: parsed.text.split(/\n{2,}/) },
      ],
    });

    return {
      outputFiles: [
        await this.files.saveGenerated(ctx.userId, {
          name: `${stripPdf(src.filename ?? 'document')}-解析.md`,
          buffer: Buffer.from(markdown, 'utf8'),
          contentType: 'text/markdown; charset=utf-8',
          source: tool,
        }),
      ].map((f) => f.id),
    };
  }

  // ---------- 内部 ----------

  private async firstInput(ctx: ToolRunContext) {
    const id = ctx.inputFiles[0];
    if (!id) {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '请先上传 PDF 文件');
    }
    const f = await this.files.readObject(ctx.userId, id);
    return { filename: f.name || 'input.pdf', buffer: f.buffer };
  }

  private async readAll(ctx: ToolRunContext) {
    // 顺序敏感：Promise 串行读取，保证合并顺序与用户选择的顺序一致
    const out: { filename: string; buffer: Buffer }[] = [];
    for (const id of ctx.inputFiles) {
      const f = await this.files.readObject(ctx.userId, id);
      out.push({ filename: f.name || 'input.pdf', buffer: f.buffer });
    }
    return out;
  }

  private save(
    ctx: ToolRunContext,
    out: { buffer: Buffer; filename: string; contentType: string },
    tool: string,
  ) {
    return this.files.saveGenerated(ctx.userId, {
      name: out.filename,
      buffer: out.buffer,
      contentType: out.contentType,
      source: tool,
    });
  }
}

/** 把引擎侧的"压不动"翻译成用户能行动的一句话（其余原样抛出） */
function translate(e: unknown, originalBytes: number): Error {
  const msg = e instanceof BizException ? e.message : ((e as Error)?.message ?? '');
  if (/已经优化过|压缩后反而|压不出收益/.test(msg)) {
    return new BizException(
      ErrorCode.ParamInvalid,
      { originalBytes },
      '这份 PDF 已经优化过，压缩收益为负；如需更小可改用「PDF 拆分」取部分页',
    );
  }
  return e instanceof Error ? e : new Error(msg);
}

function toMode(v: unknown): 'page' | 'ranges' {
  return v === 'ranges' ? 'ranges' : 'page';
}

function toRanges(v: unknown, mode: 'page' | 'ranges'): string | undefined {
  if (mode !== 'ranges') return undefined;
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) {
    throw new BizException(
      ErrorCode.ParamInvalid,
      undefined,
      '按范围拆分时请填写页码范围，如 1-3,5,8-N',
    );
  }
  return s;
}

function stripPdf(filename: string): string {
  return filename.replace(/\.pdf$/i, '') || 'document';
}

function formatKiB(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 侧车 meta 里的页数（字符串）转数字；拿不到返回 undefined 而不是 0 */
function toPageCount(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 数值入参保底：非法值一律回落默认值，不把 NaN / 超范围值传给下游 */
function clamp(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
