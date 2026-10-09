/**
 * PPT 主题色板（任务清单 M1-02 / M1-07 · PPT 视觉改造）
 *
 * 职责：把 `PptRenderInput.style` 的五档取值落成**一套真正被渲染器使用的颜色**。
 * 改造前这五档只是 `listTemplates()` 里的摆设 —— 渲染器里写死一个品牌青，
 * 选"国潮"和选"商务"画出的是同一张片子。
 *
 * 关于"禁止硬编码色值"（红线 2）：那条约束的对象是**小程序样式**
 * （`apps/mp/styles/tokens.scss` 之外不出现 hex）。后端渲染器产出的是 .pptx 二进制，
 * 拿不到 Design Token，只能自带色板。所以这里的纪律是**收口而不是豁免**：
 * 整个 ppt 目录只有本文件允许出现 hex，渲染器/版式一律经 `theme.xxx` 取色。
 */
import type { PptRenderInput } from '@qz/core';

/** 五档风格的全部取值（与 core 的 `PptRenderInput.style` 同源，加一档就编译报错） */
export type PptStyleId = NonNullable<PptRenderInput['style']>;

/** 封面装饰画法：不同风格用不同的构图语言，而不是同一块纯色底 */
export type PptCoverDeco = 'band' | 'blocks' | 'wave' | 'frame' | 'seal';

export interface PptTheme {
  readonly id: PptStyleId;
  /** 中文风格名（给 listTemplates 与页脚用） */
  readonly label: string;
  /** 主色：页码、序号、装饰条、超大数字 */
  readonly primary: string;
  /** 辅色：卡片底、次级装饰、双栏分隔 */
  readonly secondary: string;
  /** 点缀色：细线、图章、高亮（多数场合只出现在深底上） */
  readonly accent: string;
  /** 封面底色 */
  readonly bgCover: string;
  /** 内容页底色 */
  readonly bgPage: string;
  /** 内容页文字三级：标题 / 正文 / 弱化（脚注、估算提示） */
  readonly textTitle: string;
  readonly textBody: string;
  readonly textMute: string;
  /** 封面深（或浅）底上的文字 */
  readonly onCover: string;
  readonly onCoverMute: string;
  /** 章节过渡页：整页底色 + 其上文字 */
  readonly sectionBg: string;
  readonly onSection: string;
  readonly onSectionMute: string;
  readonly coverDeco: PptCoverDeco;
}

const THEMES: Record<PptStyleId, PptTheme> = {
  // 商务：深藏青 + 金 —— 路演/答辩最稳的一档
  business: {
    id: 'business',
    label: '商务',
    primary: '18284A',
    secondary: '2C4A7C',
    accent: 'C9A227',
    bgCover: '18284A',
    bgPage: 'FFFFFF',
    textTitle: '18284A',
    textBody: '3B4A63',
    textMute: '94A3B8',
    onCover: 'FFFFFF',
    onCoverMute: 'AFC0D8',
    sectionBg: '22355C',
    onSection: 'FFFFFF',
    onSectionMute: 'B9C6DC',
    coverDeco: 'band',
  },
  // 科技：深蓝紫 + 电青
  tech: {
    id: 'tech',
    label: '科技',
    primary: '1E2359',
    secondary: '4C4FD1',
    accent: '22D3EE',
    bgCover: '10143A',
    bgPage: 'F7F8FE',
    textTitle: '161A45',
    textBody: '3E4472',
    textMute: '8E95C4',
    onCover: 'F2F6FF',
    onCoverMute: '7EE0F5',
    sectionBg: '141A4A',
    onSection: 'F2F6FF',
    onSectionMute: '8FD9EE',
    coverDeco: 'blocks',
  },
  // 清新：白底 + 薄荷/柠檬糖果色（主色对齐小程序设计令牌 $brand-500 #00B8A9）
  fresh: {
    id: 'fresh',
    label: '清新',
    primary: '00B8A9',
    secondary: '8FE3D6',
    accent: 'FFE066',
    bgCover: 'F1FBF9',
    bgPage: 'FFFFFF',
    textTitle: '0B3B36',
    textBody: '35564F',
    textMute: '8FABA5',
    onCover: '0B3B36',
    onCoverMute: '4E8C82',
    sectionBg: '00B8A9',
    onSection: 'FFFFFF',
    onSectionMute: 'D6F5EF',
    coverDeco: 'wave',
  },
  // 学术：米白 + 墨绿
  academic: {
    id: 'academic',
    label: '学术',
    primary: '1F4D3A',
    secondary: '4F7B5F',
    accent: 'B08D57',
    bgCover: 'F6F3EA',
    bgPage: 'FCFBF6',
    textTitle: '1B332A',
    textBody: '3F4A42',
    textMute: '97A096',
    onCover: '1F4D3A',
    onCoverMute: '6E7C6F',
    sectionBg: '1F4D3A',
    onSection: 'F6F3EA',
    onSectionMute: 'B7CBBE',
    coverDeco: 'frame',
  },
  // 国潮：米黄 + 朱砂红 + 黛蓝
  chinese: {
    id: 'chinese',
    label: '国潮',
    primary: 'B02E28',
    secondary: '2E4A6B',
    accent: 'D9A441',
    bgCover: 'F7EFDF',
    bgPage: 'FDF8EE',
    textTitle: '5A2A22',
    textBody: '4A4238',
    textMute: 'A79A85',
    onCover: '5A2A22',
    onCoverMute: '8C7A63',
    sectionBg: 'B02E28',
    onSection: 'FDF8EE',
    onSectionMute: 'F0C9B8',
    coverDeco: 'seal',
  },
};

/** 风格清单（`listTemplates()` 的唯一来源，避免"模板列表"与色板两处漂移） */
export const PPT_STYLES: readonly PptStyleId[] = [
  'business',
  'tech',
  'fresh',
  'academic',
  'chinese',
];

/**
 * 取主题。未匹配一律回落 business —— 但**不静默**：调用方（执行器）已用
 * `toEnum` 收敛过入参，这里的回落是给"直接 new Provider 传了野值"的兜底，
 * 保证渲染器任何输入都能出片，而不是抛错让整作业失败。
 */
export function resolveTheme(style?: string): PptTheme {
  const hit = style ? THEMES[style as PptStyleId] : undefined;
  return hit ?? THEMES.business;
}

/** `#RRGGBB`（无井号）按 ratio 与白色混合，ratio=1 得纯白；用于卡片底、弱化文字等 */
export function tint(hex: string, ratio: number): string {
  return mix(hex, 'FFFFFF', ratio);
}

/** 两色线性混合，ratio 越大越靠近 b。所有派生色都从这里出，避免再散落字面量 */
export function mix(a: string, b: string, ratio: number): string {
  const r = Math.max(0, Math.min(1, ratio));
  const ca = parseHex(a);
  const cb = parseHex(b);
  const ch = ca.map((v, i) => Math.round(v + (cb[i] - v) * r));
  return ch.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function parseHex(hex: string): number[] {
  const s = hex.replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return [0, 0, 0];
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}
