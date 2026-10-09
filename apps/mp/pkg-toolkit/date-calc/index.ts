/**
 * 日期差计算（校园小工具）
 *
 * ## 为什么是本地页面，而不是工具箱里的"工具"
 *
 * 与绩点 / 考试倒计时同因：工具箱的执行路径会留下作业记录并预扣额度，
 * 而"两个日期差几天"是**零副作用的纯计算** —— 本地算、秒出结果、不上传、不占额度。
 * 本页**没有任何 `wx.request`**：用户选的两个日期不会离开这台手机。
 *
 * ## 算法不在这里
 *
 * 全部在 `utils/date-calc.ts`（纯函数、有单测），页面只收集输入与展示。
 * 日历日原语（`parseDate` / `formatDate` / `todayParts`）继续复用
 * `utils/date-parts.ts`，**不在页面里另写一套 `new Date(...)`**。
 *
 * ## 为什么所有文案都在 TS 里算好
 *
 * WXML 不能调用函数。`还有 / 已经过去`、`28 周 6 天`、按钮该不该出现，
 * 都在这里算完再 `setData`，模板里只做插值 —— 否则同类文案会在各个页面各写一遍并漂移。
 */
import {
  fxDisableTilt,
  fxEnableTilt,
  fxEnd,
  fxMove,
  fxStart,
} from '../../utils/fx';
import {
  addDaysLabel,
  dateRangeHint,
  diffSummary,
  spanLabel,
  type AddedDay,
  type DiffDirection,
  type DiffSummary,
} from '../../utils/date-calc';
import { formatDate, parseDate, todayParts } from '../../utils/date-parts';

/** 天数快捷 chip（只是**填入输入框**，不是预置结果） */
interface QuickOffset {
  label: string;
  /** 送进输入框的字符串，负数表示往前推 */
  text: string;
}

const QUICK_OFFSETS: QuickOffset[] = [
  { label: '7 天后', text: '7' },
  { label: '30 天后', text: '30' },
  { label: '100 天后', text: '100' },
  { label: '30 天前', text: '-30' },
];

/** 方向 → 人话（`past` 说"已经过去"而不是"相差 -8 天"） */
const LEAD_LABELS: Record<DiffDirection, string> = {
  future: '还有',
  past: '已经过去',
  same: '起止是同一天',
};

/**
 * 天数输入解析。
 *
 * `type="digit"` 的键盘**能打出小数点**，而"半天"不是学生要的东西，
 * 所以这里四舍五入到整天；空串、纯符号（`-`）一律当"还没填完"返回 `null`。
 */
function parseOffset(text: string): number | null {
  const t = text.trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? Math.round(n) : null;
}

Page({
  data: {
    fxStyle: '',
    /** 只用于日期滚轮的初始位置；**不作为已选值显示**，所以不会像预填数据 */
    todayText: '',
    fromText: '',
    toText: '',
    baseText: '',
    offsetText: '',
    quickOffsets: QUICK_OFFSETS,
    /** 第一段：两个日期的间隔 */
    diff: null as DiffSummary | null,
    spanText: '',
    leadText: '',
    hint: '',
    canSwap: false,
    /** 第二段：基准日期 ± 天数 */
    added: null as AddedDay | null,
    addedNote: '',
    canUseToday: false,
  },

  onLoad() {
    this.setData({ todayText: formatDate(todayParts()) });
  },

  /**
   * 每次显示都重算：用户可能挂着页面过了午夜，
   * 那时"还有 1 天"其实已经变成"就是这一天"。
   * 倾斜视差也在这里开（**不能放 onLoad**，见 docs/dev/MP-VISUAL-SYSTEM.md §六）。
   */
  onShow() {
    fxEnableTilt(this);
    this.recomputeDiff();
    this.recomputeAdd();
  },

  onHide() {
    fxDisableTilt();
  },

  /* ---------- 装饰视差（只动装饰层，内容区不跟随） ---------- */

  onFxStart(e: WechatMiniprogram.TouchEvent) {
    fxStart(this, e);
  },

  onFxMove(e: WechatMiniprogram.TouchEvent) {
    fxMove(this, e);
  },

  onFxEnd() {
    fxEnd(this);
  },

  /* ---------- 第一段：两个日期相差几天 ---------- */

  onFromChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ fromText: String(e.detail.value) }, () => this.recomputeDiff());
  },

  onToChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ toText: String(e.detail.value) }, () => this.recomputeDiff());
  },

  /** 只差一次点击就能反着看"这段已经过了多久"，值得给 */
  onSwap() {
    const { fromText, toText } = this.data;
    if (!fromText || !toText) return;
    this.setData({ fromText: toText, toText: fromText }, () => this.recomputeDiff());
  },

  recomputeDiff() {
    const from = parseDate(this.data.fromText);
    const to = parseDate(this.data.toText);
    const diff = diffSummary(from, to);
    this.setData({
      diff,
      canSwap: Boolean(from && to),
      spanText: diff ? spanLabel(diff) : '',
      leadText: diff ? LEAD_LABELS[diff.direction] : '',
      hint: dateRangeHint(from, to),
    });
  },

  /* ---------- 第二段：某个日期之后（或之前）是哪天 ---------- */

  onBaseChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ baseText: String(e.detail.value) }, () => this.recomputeAdd());
  },

  onOffsetInput(e: WechatMiniprogram.Input) {
    this.setData({ offsetText: e.detail.value }, () => this.recomputeAdd());
  },

  onQuickOffset(e: WechatMiniprogram.TouchEvent) {
    const value = (e.currentTarget.dataset as { value: string }).value;
    this.setData({ offsetText: value }, () => this.recomputeAdd());
  },

  onBaseToday() {
    this.setData({ baseText: this.data.todayText }, () => this.recomputeAdd());
  },

  recomputeAdd() {
    const base = parseDate(this.data.baseText);
    const n = parseOffset(this.data.offsetText);
    const added = n === null ? null : addDaysLabel(base, n);
    this.setData({
      added,
      addedNote: added ? this.addedNoteText(n) : '',
      // 已经是今天就不用再按这一下（少一个无效点击）
      canUseToday: Boolean(base) && this.data.baseText !== this.data.todayText,
    });
  },

  /** "2026-06-01 往后 100 天" —— 让用户确认结果对应的是哪一次输入 */
  addedNoteText(n: number | null): string {
    if (n === null) return '';
    if (n === 0) return `${this.data.baseText} 就是基准日当天`;
    return `${this.data.baseText} ${n > 0 ? '往后' : '往前'} ${Math.abs(n)} 天`;
  },
});
