/**
 * 时间戳转换 —— Unix 时间戳与日期时间双向换算（秒/毫秒口径可切），纯本地计算。
 *
 * 换算口径在 `./logic.ts`；本页只做三件事：收集输入、切换口径、把算好的
 * 字符串 setData 给 WXML（WXML 不能调函数）。"没填"与"读不出"分开显示，
 * 边打字边算的中间态不弹错误。
 */
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';

import { fieldsToStamp, formatStamp, parseStamp, toUnitStamp, type TsUnit } from './logic';

interface UnitChip {
  key: TsUnit;
  label: string;
}

const UNIT_CHIPS: UnitChip[] = [
  { key: 's', label: '秒（10 位）' },
  { key: 'ms', label: '毫秒（13 位）' },
];

/** 结果区状态：没填 / 读不出 / 能算 */
type Status = 'empty' | 'invalid' | 'ok';

/** 日期/时间选择器的默认值 = 此刻（本地时区） */
function nowDefaults(): { date: string; time: string } {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

Page({
  data: {
    unitChips: UNIT_CHIPS,
    unit: 's' as TsUnit,
    tsText: '',
    tsStatus: 'empty' as Status,
    tsResult: '',
    tsOther: '',
    dateValue: '',
    timeValue: '',
    addStatus: 'empty' as Status,
    addResult: '',
    fxStyle: '',
  },

  onLoad() {
    const d = nowDefaults();
    this.setData({ dateValue: d.date, timeValue: d.time }, () => this.recomputeAdd());
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

  /* ---------- 口径 ---------- */

  onUnitTap(e: WechatMiniprogram.TouchEvent) {
    const key = (e.currentTarget.dataset as { key: string }).key;
    if (key !== 's' && key !== 'ms') return;
    this.setData({ unit: key }, () => {
      this.recomputeTs();
      this.recomputeAdd();
    });
  },

  /** 「现在」：把此刻的时间戳按当前口径填进输入框 */
  onNow() {
    const stamp = toUnitStamp(Date.now(), this.data.unit);
    this.setData({ tsText: String(stamp) }, () => this.recomputeTs());
  },

  /* ---------- 时间戳 → 日期 ---------- */

  onTsInput(e: WechatMiniprogram.Input) {
    this.setData({ tsText: e.detail.value }, () => this.recomputeTs());
  },

  recomputeTs() {
    const ms = parseStamp(this.data.tsText, this.data.unit);
    if (ms === null) {
      const blank = !this.data.tsText.trim();
      this.setData({ tsStatus: blank ? 'empty' : 'invalid', tsResult: '', tsOther: '' });
      return;
    }
    const other = toUnitStamp(ms, this.data.unit === 's' ? 'ms' : 's');
    this.setData({ tsStatus: 'ok', tsResult: formatStamp(ms), tsOther: String(other) });
  },

  /* ---------- 日期 → 时间戳 ---------- */

  onDateChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ dateValue: String(e.detail.value) }, () => this.recomputeAdd());
  },

  onTimeChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ timeValue: String(e.detail.value) }, () => this.recomputeAdd());
  },

  recomputeAdd() {
    const date = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(this.data.dateValue);
    const time = /^(\d{1,2}):(\d{1,2})$/.exec(this.data.timeValue);
    if (!date || !time) {
      this.setData({ addStatus: 'empty', addResult: '' });
      return;
    }
    const fields = {
      y: Number(date[1]),
      m: Number(date[2]),
      d: Number(date[3]),
      hh: Number(time[1]),
      mm: Number(time[2]),
    };
    const stamp = fieldsToStamp(fields, this.data.unit);
    if (stamp === null) {
      this.setData({ addStatus: 'invalid', addResult: '' });
      return;
    }
    this.setData({ addStatus: 'ok', addResult: String(stamp) });
  },

  /* ---------- 复制 ---------- */

  onCopyTs() {
    this.copy(this.data.tsResult);
  },

  onCopyAdd() {
    this.copy(this.data.addResult);
  },

  copy(text: string) {
    if (!text) return;
    wx.setClipboardData({
      data: text,
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
