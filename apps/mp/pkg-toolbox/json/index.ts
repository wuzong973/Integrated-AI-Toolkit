/**
 * JSON 格式化 / 校验 —— 纯本地计算。
 *
 * 解析与行号定位在 `./logic.ts`（校验与格式化共用同一条 JSON.parse 路径，
 * 不会出现"校验说合法、格式化却报错"）。页面只做三件事：
 *   · 输入即时校验（错误带行号列号显示）；
 *   · 格式化 / 压缩把结果写到下方输出卡；
 *   · 输入一变就清掉旧输出 —— 留着它会让用户以为还是新输入的结果。
 */
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';

import { formatJson, jsonErrorText } from './logic';

Page({
  data: {
    inputText: '',
    /** 即时校验：当前输入是否合法（空输入也算不合法，但不显示错误详情） */
    valid: false,
    errorText: '',
    outputText: '',
    outputLabel: '',
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

  /* ---------- 输入 ---------- */

  onInput(e: WechatMiniprogram.Input) {
    const inputText = e.detail.value;
    const result = formatJson(inputText, 2);
    this.setData({
      inputText,
      valid: result.ok,
      errorText: result.ok ? '' : jsonErrorText(result.error),
      outputText: '',
      outputLabel: '',
    });
  },

  onClear() {
    this.setData({
      inputText: '',
      valid: false,
      errorText: '',
      outputText: '',
      outputLabel: '',
    });
  },

  /* ---------- 动作 ---------- */

  onFormat() {
    this.run(2, '格式化');
  },

  onMinify() {
    this.run(0, '压缩');
  },

  /** indent 2 = 格式化；0 = 压缩。失败只亮错误行号，不写输出 */
  run(indent: number, label: string) {
    if (!this.data.inputText.trim()) {
      wx.showToast({ title: '先粘贴一段 JSON', icon: 'none' });
      return;
    }
    const result = formatJson(this.data.inputText, indent);
    if (!result.ok) {
      this.setData({ valid: false, errorText: jsonErrorText(result.error), outputText: '' });
      return;
    }
    this.setData({
      valid: true,
      errorText: '',
      outputText: String(result.value),
      outputLabel: label,
    });
  },

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
