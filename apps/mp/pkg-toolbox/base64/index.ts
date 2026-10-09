/**
 * Base64 / URL 编解码 —— 纯本地计算。
 *
 * 算法在 `./logic.ts`（手写 UTF-8 + Base64，避开真机上不保证存在的
 * btoa / TextEncoder）。页面只做模式切换与即时重算；
 * 解码失败给一句人话并清空输出，绝不把上一份结果留在屏上。
 */
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';

import { runCodec, type CodecMode } from './logic';

interface ModeChip {
  key: CodecMode;
  label: string;
}

const MODE_CHIPS: ModeChip[] = [
  { key: 'b64enc', label: 'Base64 编码' },
  { key: 'b64dec', label: 'Base64 解码' },
  { key: 'urlenc', label: 'URL 编码' },
  { key: 'urldec', label: 'URL 解码' },
];

Page({
  data: {
    modeChips: MODE_CHIPS,
    mode: 'b64enc' as CodecMode,
    inputText: '',
    outputText: '',
    error: '',
    fxStyle: '',
  },

  onShow() {
    fxEnableTilt(this);
  },

  onHide() {
    fxDisableTilt();
  },

  onUnload() {
    fxDisableTilt();
  },

  /* ---------- 模式 ---------- */

  onModeTap(e: WechatMiniprogram.TouchEvent) {
    const key = (e.currentTarget.dataset as { key: string }).key;
    const chip = MODE_CHIPS.find((c) => c.key === key);
    if (!chip) return;
    this.setData({ mode: chip.key }, () => this.recompute());
  },

  /* ---------- 输入 ---------- */

  onInput(e: WechatMiniprogram.Input) {
    this.setData({ inputText: e.detail.value }, () => this.recompute());
  },

  onClear() {
    this.setData({ inputText: '', outputText: '', error: '' });
  },

  /** 输入或模式变化后重算；失败态清空输出 —— 留着旧结果会让人以为算的是新输入 */
  recompute() {
    const r = runCodec(this.data.mode, this.data.inputText);
    const patch = r.ok ? { outputText: r.output, error: '' } : { outputText: '', error: r.error };
    this.setData(patch);
  },

  /* ---------- 复制 ---------- */

  onCopy() {
    if (!this.data.outputText) return;
    wx.setClipboardData({
      data: this.data.outputText,
      fail: () => wx.showToast({ title: '复制失败，请长按选择文本', icon: 'none' }),
    });
  },

  /* ---------- 指针视差（装饰层动，内容不动） ---------- */

  onFxStart(e: WechatMiniprogram.TouchEvent) {
    fxStart(this, e);
  },

  onFxMove(e: WechatMiniprogram.TouchEvent) {
    fxMove(this, e);
  },

  onFxEnd() {
    fxEnd(this);
  },
});
