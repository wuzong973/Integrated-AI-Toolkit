/**
 * 密码生成 —— 长度滑块 + 四类字符集开关，纯本地随机。
 *
 * 生成与强度判定在 `./logic.ts`：保证每种选中字符集至少出现一次、
 * 生成后整体洗牌。页面只收集开关状态；一类字符都没选时提示而不是硬给。
 */
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';

import { generatePassword, strengthLabel, type PwdOptions } from './logic';

interface CharSetChip {
  key: keyof Omit<PwdOptions, 'length'>;
  label: string;
}

const CHAR_SETS: CharSetChip[] = [
  { key: 'lower', label: '小写字母' },
  { key: 'upper', label: '大写字母' },
  { key: 'digit', label: '数字' },
  { key: 'symbol', label: '符号' },
];

const MIN_LEN = 6;
const MAX_LEN = 32;
const DEFAULT_LEN = 16;

Page({
  data: {
    charSets: CHAR_SETS,
    minLength: MIN_LEN,
    maxLength: MAX_LEN,
    /** 滑块的当前值（PwdOptions.length 与它同步） */
    length: DEFAULT_LEN,
    opts: {
      length: DEFAULT_LEN,
      lower: true,
      upper: true,
      digit: true,
      symbol: false,
    } as PwdOptions,
    password: '',
    strength: '',
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

  /* ---------- 规则 ---------- */

  /** 滑块拖动中与拖完共用：只改长度与强度预览，已生成的密码不动 */
  onLength(e: { detail: { value: number } }) {
    const len = Math.round(e.detail.value);
    const opts: PwdOptions = { ...this.data.opts, length: len };
    this.setData({ length: len, opts, strength: strengthLabel(opts) });
  },

  onToggle(e: WechatMiniprogram.TouchEvent) {
    const key = (e.currentTarget.dataset as { key: string }).key;
    if (key !== 'lower' && key !== 'upper' && key !== 'digit' && key !== 'symbol') return;
    const opts: PwdOptions = { ...this.data.opts, [key]: !this.data.opts[key] };
    this.setData({ opts, strength: strengthLabel(opts) });
  },

  /* ---------- 生成 ---------- */

  onGenerate() {
    const pwd = generatePassword(this.data.opts);
    if (pwd === null) {
      wx.showToast({ title: '请至少选择一类字符', icon: 'none' });
      return;
    }
    this.setData({ password: pwd, strength: strengthLabel(this.data.opts) });
  },

  onCopy() {
    if (!this.data.password) {
      wx.showToast({ title: '先生成一个再复制', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: this.data.password,
      fail: () => wx.showToast({ title: '复制失败，请重试一次', icon: 'none' }),
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
