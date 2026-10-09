/**
 * PPT 封面装饰层（任务清单 M1-02 · PPT 视觉改造）
 *
 * 职责：按主题的 `coverDeco` 画封面**装饰**（纯色几何层，不产生图片资源），
 * 封面文字由渲染器画在装饰之上。改造前封面是"一块纯色 + 三个文本框"，
 * 五档风格共用同一块颜色 —— 这里把风格差异真正落到版面上。
 *
 * 为什么单独成文件：装饰是"每个风格一段画法"的代码，和分发/取色逻辑混在
 * 渲染器里会顶破 300 行上限（红线 8），而且这五段画法互不相干，分开最好读。
 */
import type PptxGenJS from 'pptxgenjs';

import { PAGE } from './ppt-layouts';
import { mix, type PptCoverDeco, type PptTheme } from './ppt-themes';

type Slide = PptxGenJS.Slide;

/* 页面/正文区常量以 ppt-layouts.ts 为唯一来源 —— 这里曾有一份 bottom=6.55 的
   副本，与正文用的 6.5 漂移了 0.05"；装饰几何全部按 COVER_TITLE 让位，不依赖 BODY。 */

/** 封面标题块起始位置（装饰层需要绕开它） */
const COVER_TITLE = { x: 1.02, y: 2.45, w: 10.9 } as const;

/** 画封面装饰：本函数只画形状，不画文字 */
export function drawCoverDeco(slide: Slide, theme: PptTheme): void {
  const draw: Record<PptCoverDeco, (s: Slide, t: PptTheme) => void> = {
    band: drawBand,
    blocks: drawBlocks,
    wave: drawWave,
    frame: drawFrame,
    seal: drawSeal,
  };
  draw[theme.coverDeco](slide, theme);
}

/** 商务：一条贯通竖向金色色带 + 右下方块，压住深藏青底 */
function drawBand(s: Slide, t: PptTheme): void {
  s.addShape('rect', { x: 0, y: 0, w: 0.3, h: PAGE.h, fill: { color: t.accent } });
  s.addShape('rect', {
    x: 9.05,
    y: 0.9,
    w: 3.5,
    h: 3.5,
    fill: { color: t.secondary, transparency: 74 },
  });
  s.addShape('rect', {
    x: 10.4,
    y: 3.5,
    w: 2.9,
    h: 2.9,
    fill: { color: t.accent, transparency: 78 },
  });
  s.addShape('rect', {
    x: 0,
    y: PAGE.h - 1.05,
    w: PAGE.w,
    h: 1.05,
    fill: { color: mix(t.bgCover, t.onCover, 0.1) },
  });
}

/** 科技：3×3 点阵 + 空心圆环，冷光感 */
function drawBlocks(s: Slide, t: PptTheme): void {
  s.addShape('rect', {
    x: 8.2,
    y: -1.2,
    w: 6.2,
    h: 6.2,
    fill: { color: t.secondary, transparency: 72 },
  });
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      const onDiagonal = col === row;
      s.addShape('rect', {
        x: 9.6 + col * 0.72,
        y: 4.35 + row * 0.72,
        w: 0.34,
        h: 0.34,
        fill: { color: t.accent, transparency: onDiagonal ? 8 : 62 },
      });
    }
  }
  s.addShape('ellipse', {
    x: 11.15,
    y: 1.15,
    w: 1.55,
    h: 1.55,
    fill: { type: 'none' },
    line: { color: t.accent, width: 1.4 },
  });
}

/** 清新：薄荷大圆出血 + 柠檬小圆，白底不吃深色 */
function drawWave(s: Slide, t: PptTheme): void {
  s.addShape('ellipse', {
    x: 8.6,
    y: -2.7,
    w: 7.1,
    h: 7.1,
    fill: { color: t.secondary, transparency: 42 },
  });
  s.addShape('ellipse', {
    x: -2.3,
    y: 4.35,
    w: 6.1,
    h: 6.1,
    fill: { color: t.primary, transparency: 84 },
  });
  s.addShape('ellipse', { x: 11.6, y: 5.35, w: 0.9, h: 0.9, fill: { color: t.accent } });
  s.addShape('roundRect', {
    x: COVER_TITLE.x,
    y: 6.1,
    w: 2.5,
    h: 0.1,
    rectRadius: 0.05,
    fill: { color: t.primary, transparency: 45 },
  });
}

/** 学术：双线内收框 + 左上角实心方块，纸感 */
function drawFrame(s: Slide, t: PptTheme): void {
  s.addShape('rect', {
    x: 0.42,
    y: 0.38,
    w: PAGE.w - 0.84,
    h: PAGE.h - 0.76,
    fill: { type: 'none' },
    line: { color: t.primary, width: 1.6 },
  });
  s.addShape('rect', {
    x: 0.62,
    y: 0.58,
    w: PAGE.w - 1.24,
    h: PAGE.h - 1.16,
    fill: { type: 'none' },
    line: { color: t.accent, width: 0.75 },
  });
  s.addShape('rect', { x: 0.62, y: 0.58, w: 0.52, h: 0.52, fill: { color: t.primary } });
  s.addShape('rect', {
    x: PAGE.w - 3.4,
    y: PAGE.h - 2.5,
    w: 2.78,
    h: 1.9,
    fill: { color: t.secondary, transparency: 86 },
  });
}

/** 国潮：右侧黛蓝竖幅 + 朱砂印章，米黄底 */
function drawSeal(s: Slide, t: PptTheme): void {
  s.addShape('rect', {
    x: PAGE.w - 1.95,
    y: 0,
    w: 1.95,
    h: PAGE.h,
    fill: { color: t.secondary, transparency: 82 },
  });
  s.addShape('rect', { x: PAGE.w - 2.12, y: 0, w: 0.06, h: PAGE.h, fill: { color: t.primary } });
  s.addShape('roundRect', {
    x: PAGE.w - 1.62,
    y: 5.15,
    w: 1.05,
    h: 1.05,
    rectRadius: 0.08,
    fill: { color: t.primary },
  });
  s.addText('青智', {
    x: PAGE.w - 1.62,
    y: 5.15,
    w: 1.05,
    h: 1.05,
    fontSize: 15,
    bold: true,
    color: t.bgPage,
    align: 'center',
    valign: 'middle',
  });
  s.addShape('rect', { x: 0, y: 0, w: PAGE.w, h: 0.16, fill: { color: t.accent } });
}
