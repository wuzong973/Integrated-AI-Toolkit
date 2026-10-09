/**
 * 字数统计与文本整理（校园小工具）
 *
 * ## 为什么是本地页面
 *
 * 与绩点 / AA 分账 / 抽签同因：粘一段课程论文去算字数，没有任何副作用，
 * 就不该走服务端 —— 全部计算在 `utils/text-tools.ts` 里，本机跑完，
 * **不上传、不占额度**，离线也能用。文本往往是未发表的作业或论文，
 * 不出这台手机是这条页面前提，副标题上就照实写。
 *
 * ## 算法不在这里
 *
 * 页面只做四件事：① 收输入；② 把 `countText` 的结果**格式化成字符串**；
 * ③ 应用 `applyTextOp` 并留一份快照；④ 如实告知复制成功还是失败。
 *
 * ⚠️ **WXML 里不能调函数**，所以六个统计数字、字数提示、结果计数全部在
 * TS 里算好再 `setData`（`stats` 是格式化后的网格数据，不是原始计数）。
 *
 * ## 结果不覆盖原文
 *
 * 整理操作只把结果写进"结果卡"，原文完好 —— 用户可以拿结果和原文对照，
 * 满意了点「用结果替换原文」才真的替换。粘一篇论文要点七次整理，
 * 每次都没收原文是这类工具最讨人嫌的做法。
 */
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import {
  applyTextOp,
  countText,
  TEXT_OPS,
  type TextCounts,
  wordCount,
  wordLimitHint,
} from '../../utils/text-tools';

/** 统计卡的一格：label 是口径名，value 是已经格式化成字符串的数字 */
interface StatCell {
  key: string;
  label: string;
  value: string;
}

/** 超过这个字符数就给一句"统计仍照常算完"的提示（真机 textarea 有实际上限） */
const LONG_CHARS = 3000;

/** 六格固定顺序：主口径在前，字符类在中，行段在末 */
function toStats(c: TextCounts): StatCell[] {
  return [
    { key: 'han', label: '汉字', value: String(c.han) },
    { key: 'enWords', label: '英文单词', value: String(c.enWords) },
    { key: 'chars', label: '字符·不含空格', value: String(c.chars) },
    { key: 'charsWithSpace', label: '字符·含空格', value: String(c.charsWithSpace) },
    { key: 'lines', label: '行数', value: String(c.lines) },
    { key: 'paragraphs', label: '段落', value: String(c.paragraphs) },
  ];
}

/**
 * 字数要求输入 → 数字。
 *
 * 只接受纯数字；填了 `800字`、`-1`、`1e3` 这类一律当"没填"（返回 0），
 * 提示行随之不显示。**不弹"格式错误"**：这是一个可选的辅助输入，
 * 用户边打边错会被吵到，不如安静地不给提示。
 */
function parseLimit(raw: string): number {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return 0;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : 0;
}

Page({
  data: {
    /** 原文（textarea 双向绑定值） */
    text: '',
    hasText: false,
    /** 超长提示（不影响统计，只是让用户知道数字仍可信） */
    long: false,
    /** 六格统计，已格式化 */
    stats: [] as StatCell[],
    /** 大字：汉字 + 英文单词，即"作文字数"口径 */
    wordTotal: '0',
    /** 字数要求（输入框原样字符串 + 算出来的提示） */
    limitRaw: '',
    limitHint: '',
    ops: TEXT_OPS.map((op) => ({ key: op.key, label: op.label })),
    /** 结果卡快照：text / 用了哪个操作 / 它的字数 */
    resultText: '',
    resultTitle: '',
    resultCount: '',
    hasResult: false,
    fxStyle: '',
  },

  onLoad() {
    this.refresh('');
  },

  /* ---------- 装饰视差（倾斜只在 onShow 开，onHide 关） ---------- */

  onShow() {
    fxEnableTilt(this);
  },

  onHide() {
    fxDisableTilt();
  },

  onFxStart(e: WechatMiniprogram.TouchEvent) {
    fxStart(this, e);
  },

  onFxMove(e: WechatMiniprogram.TouchEvent) {
    fxMove(this, e);
  },

  onFxEnd() {
    fxEnd(this);
  },

  /* ---------- 统计 ---------- */

  /**
   * 重算六格统计与字数提示。
   *
   * ⚠️ `limitRaw` 只能显式传进**函数体里**再取 `this.data` 兜底 ——
   * 写成默认参数值（`limitRaw = this.data.limitRaw`）会撞上 TS2683
   * （"this 隐式具有 any 类型"），Page 的 ThisType 推断在参数位置不生效。
   * 传显式值还有一个好处：`setData` 之后立刻读 `this.data` 在部分基础库上是异步可见的。
   */
  refresh(text: string, limitRaw?: string) {
    const counts = countText(text);
    this.setData({
      stats: toStats(counts),
      wordTotal: String(wordCount(counts)),
      hasText: text.trim() !== '',
      long: counts.charsWithSpace > LONG_CHARS,
      limitHint: wordLimitHint(counts, parseLimit(limitRaw ?? this.data.limitRaw)),
    });
  },

  onTextInput(e: WechatMiniprogram.Input) {
    const text = e.detail.value;
    this.setData({ text });
    this.refresh(text);
  },

  onLimitInput(e: WechatMiniprogram.Input) {
    const raw = e.detail.value;
    this.setData({ limitRaw: raw });
    this.refresh(this.data.text, raw);
  },

  onClearText() {
    this.setData({ text: '', resultText: '', resultTitle: '', resultCount: '', hasResult: false });
    this.refresh('');
  },

  /* ---------- 整理 ---------- */

  /**
   * 应用一个操作：结果只进结果卡，**不动原文**。
   *
   * op 来自 WXML 的 `data-op`（字符串），先回查清单再动手 ——
   * 清单和界面万一不同步，这里就当没发生，而不是把一串 `undefined` 写进结果。
   */
  onOpTap(e: WechatMiniprogram.TouchEvent) {
    const raw = (e.currentTarget.dataset as { op?: string }).op ?? '';
    const op = TEXT_OPS.find((item) => item.key === raw);
    if (!op) return;

    const { text } = this.data;
    if (text.trim() === '') {
      wx.showToast({ title: '先粘进一段文字', icon: 'none' });
      return;
    }

    const out = applyTextOp(text, op.key);
    const counts = countText(out);
    this.setData({
      resultText: out,
      resultTitle: op.label,
      resultCount: `${String(wordCount(counts))} 字 · ${String(counts.charsWithSpace)} 字符`,
      hasResult: true,
    });
  },

  /** 复制结果：成功与失败都要说出来，不能静默 */
  onCopyResult() {
    const data = this.data.resultText;
    if (!data) {
      wx.showToast({ title: '没有可复制的结果', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data,
      success: () => wx.showToast({ title: '已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请长按结果手动复制', icon: 'none' }),
    });
  },

  /** 显式确认才替换原文：替换完结果卡就收起，避免出现两份不一样的"当前文本" */
  onUseResult() {
    if (!this.data.hasResult) return;
    const text = this.data.resultText;
    this.setData({ text, resultText: '', resultTitle: '', resultCount: '', hasResult: false });
    this.refresh(text);
    wx.showToast({ title: '已替换原文', icon: 'none' });
  },
});
