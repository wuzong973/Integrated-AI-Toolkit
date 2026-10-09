/**
 * 文本对比 —— 两段文本按行 diff（LCS），纯本地计算。
 *
 * 算法在 `./logic.ts`（规模上限两侧各 1500 行，超出截断并在结果里明说）。
 * 页面只收集两段输入：改了任何一段就清掉旧结果 —— 拿旧结论配新输入
 * 是这类工具最容易骗到人的地方。
 */
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';

import { diffLines, type DiffKind } from './logic';

/** WXML 渲染用的一行（补一个稳定的 wx:key 下标） */
interface DiffRowView {
  idx: number;
  cls: DiffKind;
  text: string;
}

interface DiffView {
  rows: DiffRowView[];
  adds: number;
  dels: number;
  truncated: boolean;
}

Page({
  data: {
    oldText: '',
    newText: '',
    result: null as DiffView | null,
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

  onOldInput(e: WechatMiniprogram.Input) {
    this.setData({ oldText: e.detail.value, result: null });
  },

  onNewInput(e: WechatMiniprogram.Input) {
    this.setData({ newText: e.detail.value, result: null });
  },

  onClear() {
    this.setData({ oldText: '', newText: '', result: null });
  },

  /* ---------- 对比 ---------- */

  onDiff() {
    const { oldText, newText } = this.data;
    if (!oldText.trim() && !newText.trim()) {
      wx.showToast({ title: '先粘入要对比的文本', icon: 'none' });
      return;
    }
    const r = diffLines(oldText, newText);
    const view: DiffView = {
      rows: r.rows.map((row, idx) => ({ ...row, idx })),
      adds: r.adds,
      dels: r.dels,
      truncated: r.truncated,
    };
    this.setData({ result: view });
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
