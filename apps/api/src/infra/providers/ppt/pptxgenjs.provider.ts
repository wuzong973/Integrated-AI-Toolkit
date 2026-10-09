import PptxGenJS from 'pptxgenjs';
import type { PptProvider, PptRenderInput, PptRenderResult, PptSlideSpec } from '@qz/core';

import { drawCoverDeco } from './ppt-cover-deco';
import { BASE_TEXT, drawBody, drawSection, type Page } from './ppt-draw-layouts';
import { BODY, BODY_W, needsEstimateNote, PAGE, resolveLayout, withSectionNumbers } from './ppt-layouts';
import { PPT_STYLES, resolveTheme, tint, type PptTheme } from './ppt-themes';

/**
 * PPT 渲染真实实现（PptxGenJS，MIT）· 任务清单 M1-02 / M1-07 · PPT 视觉改造
 *
 * 关键设计（文档 6.5.2）：
 * - 图表使用 PptxGenJS 原生 chart API，而非贴图 —— 保证用户拿到后仍可编辑；
 * - 图表标题固定标注"示例数据"，严禁编造真实统计（红线 10）；
 * - stat 版式的数字来自模型，页脚强制挂"数据为 AI 估算，请核实"（红线 10）；
 * - 每页写入演讲备注（notes），结果页可单独导出。
 *
 * 改造要点（此前 171 行只有一种版式，五档 style 被完全忽略，九页同构）：
 * 1. 取色全部走 `resolveTheme(style)`，本文件不再出现任何 hex 字面量（色板见 ppt-themes.ts）；
 * 2. 按 `resolveLayout()` 的结论分发到 6 种版式画法；
 * 3. 所有内容页共用页眉（标题 + 双色装饰条）与页脚（细线 + 主题色页码 + 署名），
 *    页码不再是右下角一个孤零零的灰色数字；
 * 4. 所有文本框 `fit: 'shrink'`，并按要点条数收字号，避免长文溢出压版。
 */

/** 每个文本框的公共兜底（含字体）见 ppt-draw-layouts 的 BASE_TEXT，页脚署名默认值在这里 */
const DEFAULT_FOOTER = '青智校园 · AI 生成';

export class PptxGenJsProvider implements PptProvider {
  readonly name = 'pptxgenjs';

  async render(input: PptRenderInput): Promise<PptRenderResult> {
    const theme = resolveTheme(input.style);
    const pptx = new PptxGenJS();
    pptx.author = '青智校园';
    pptx.company = '青智校园';
    pptx.title = input.title;
    pptx.subject = '由青智校园 AI 生成';
    pptx.defineLayout({ name: 'QZ_WIDE', width: PAGE.w, height: PAGE.h });
    pptx.layout = 'QZ_WIDE';

    const slides = withSectionNumbers(input.slides);
    const total = slides.length + 1;
    const footer = input.footerLabel?.trim() || DEFAULT_FOOTER;
    this.addCover(pptx, theme, input, footer);
    slides.forEach((spec, i) => this.addPage(pptx, theme, spec, i + 2, total, footer));

    const out = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
    return { buffer: out, pageCount: total };
  }

  /** 模板清单：与色板同源，杜绝"列了模板却没有对应主题" */
  async listTemplates(): Promise<{ id: string; name: string; thumbnail?: string }[]> {
    return PPT_STYLES.map((id) => ({ id, name: resolveTheme(id).label }));
  }

  // ---------- 页面骨架 ----------

  /** 封面：底色 + 风格装饰层 + 标题块 */
  private addCover(pptx: PptxGenJS, theme: PptTheme, input: PptRenderInput, footer: string): void {
    const s = pptx.addSlide();
    s.background = { color: theme.bgCover };
    drawCoverDeco(s, theme);

    s.addShape('rect', { x: 1.02, y: 1.3, w: 0.17, h: 0.17, fill: { color: theme.accent } });
    s.addText('青智校园 · QINGZHI CAMPUS', {
      ...BASE_TEXT,
      x: 1.32,
      y: 1.18,
      w: 8,
      h: 0.4,
      fontSize: 11,
      color: theme.onCoverMute,
      charSpacing: 2.4,
      valign: 'middle',
    });
    s.addText(input.title, {
      ...BASE_TEXT,
      x: 0.98,
      y: 2.45,
      w: 11.0,
      h: 1.55,
      fontSize: 40,
      bold: true,
      color: theme.onCover,
      valign: 'middle',
    });
    s.addShape('rect', { x: 1.04, y: 4.22, w: 1.5, h: 0.075, fill: { color: theme.accent } });
    if (input.subtitle) {
      s.addText(input.subtitle, {
        ...BASE_TEXT,
        x: 1.02,
        y: 4.5,
        w: 10.4,
        h: 0.72,
        fontSize: 17,
        color: theme.onCoverMute,
      });
    }
    s.addText(`${footer} · ${theme.label}风格`, {
      ...BASE_TEXT,
      x: 1.02,
      y: PAGE.h - 1.0,
      w: 8,
      h: 0.36,
      fontSize: 11,
      color: theme.onCoverMute,
    });
  }

  private addPage(
    pptx: PptxGenJS,
    theme: PptTheme,
    spec: PptSlideSpec,
    no: number,
    total: number,
    footer: string,
  ): void {
    const s = pptx.addSlide();
    const layout = resolveLayout(spec);
    const page: Page = { s, theme, spec, no, total, footer };
    if (layout === 'section') {
      drawSection(page);
    } else {
      s.background = { color: theme.bgPage };
      this.drawHeader(page);
      drawBody(page, layout);
      this.drawFooter(page);
    }
    if (spec.notes?.trim()) s.addNotes(spec.notes.trim());
  }

  /** 内容页页眉：标题 + 双色装饰条（主色长条 + 点缀色短条） */
  private drawHeader({ s, theme, spec }: Page): void {
    s.addText(spec.title, {
      ...BASE_TEXT,
      x: BODY.x,
      y: 0.42,
      w: BODY_W - 0.4,
      h: 0.66,
      fontSize: 24,
      bold: true,
      color: theme.textTitle,
      valign: 'middle',
    });
    s.addShape('rect', { x: BODY.x + 0.02, y: 1.16, w: 0.62, h: 0.075, fill: { color: theme.primary } });
    s.addShape('rect', {
      x: BODY.x + 0.7,
      y: 1.16,
      w: 0.2,
      h: 0.075,
      fill: { color: theme.accent },
    });
  }

  /** 内容页页脚：细线 + 署名 + 主题色页码；stat 页额外挂"AI 估算"提示 */
  private drawFooter({ s, theme, spec, no, total, footer }: Page): void {
    s.addShape('rect', {
      x: BODY.x,
      y: BODY.footY,
      w: BODY_W,
      h: 0.014,
      fill: { color: tint(theme.textMute, 0.55) },
    });
    s.addText(footer, {
      ...BASE_TEXT,
      x: BODY.x,
      y: BODY.footY + 0.07,
      // 宽度止于 5.02"：给右侧"AI 估算"脚注（x=5.2 起）让位，
      // 两者同行动过就重叠（几何审计抓到的 98×29px 碰撞）。
      w: 4.4,
      h: 0.3,
      fontSize: 9,
      color: theme.textMute,
    });
    s.addText(`${no} / ${total}`, {
      ...BASE_TEXT,
      x: PAGE.w - 1.75,
      y: BODY.footY + 0.05,
      w: 1.13,
      h: 0.32,
      fontSize: 10,
      bold: true,
      color: theme.primary,
      align: 'right',
    });
    if (needsEstimateNote(spec.stat)) {
      s.addText('数据为 AI 估算，请核实', {
        ...BASE_TEXT,
        x: 5.2,
        y: BODY.footY + 0.07,
        w: 3.4,
        h: 0.3,
        fontSize: 9.5,
        italic: true,
        color: theme.textMute,
        align: 'right',
      });
    }
  }
}
