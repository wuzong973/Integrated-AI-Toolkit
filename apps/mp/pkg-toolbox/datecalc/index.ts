/**
 * 日期计算 —— 两日期间隔天数 / 从某天推 N 天后的日期，纯本地计算。
 *
 * 口径与文案**零拷贝**：间隔拆周、方向人话、推算越界挡板全在
 * `utils/date-calc.ts`（纯函数、有单测），日历日原语在 `utils/date-parts.ts`。
 * 本页只做：收输入 → 算 → 把算好的字符串 setData 给 WXML（WXML 不能调函数）。
 *
 * 边界（刻意不做）：只数**日历天数**，不含法定节假日与调休 —— 卡片标题写明，
 * 不让用户以为结果里扣过假（"还有几个工作日"本地算不出来，凭印象编必错）。
 */
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { addDaysLabel, dateRangeHint, diffSummary, spanLabel } from '../../utils/date-calc';
import { formatDate, parseDate, todayParts } from '../../utils/date-parts';

type Mode = 'diff' | 'add';

/** 模式 chip（`wx:key="key"`） */
interface ModeChip {
  key: Mode;
  label: string;
}

/** 推算结果区状态：没填天数 / 读不出或越界 / 能算 */
type AddStatus = 'empty' | 'invalid' | 'ok';

const MODE_CHIPS: ModeChip[] = [
  { key: 'diff', label: '间隔天数' },
  { key: 'add', label: '推算日期' },
];

/** picker mode="date" 的合法范围（与 date-parts 的 1970~2999 口径一致） */
const MIN_DATE = '1970-01-01';
const MAX_DATE = '2999-12-31';

/** 推算算不出来时要清掉的展示字段：宁可不给，也不给上一次的旧结果 */
const ADD_CLEARED = {
  addSrc: '',
  addText: '',
  addWd: '',
};

/** 结果卡来源句："2026-10-08 的 30 天后"；n 为 0 说"当天"，负数说"天前" */
function addSrcLabel(baseText: string, n: number): string {
  if (n === 0) return `${baseText} 当天`;
  const walk = n > 0 ? '后' : '前';
  return `${baseText} 的 ${Math.abs(n)} 天${walk}`;
}

Page({
  data: {
    modeChips: MODE_CHIPS,
    mode: 'diff' as Mode,
    minDate: MIN_DATE,
    maxDate: MAX_DATE,
    /** 起止日期默认今天：一进来就是真实结果，不用先点任何东西 */
    fromDate: formatDate(todayParts()),
    toDate: formatDate(todayParts()),
    baseDate: formatDate(todayParts()),
    nText: '30',
    diffDays: '',
    diffSpan: '',
    diffHint: '',
    addStatus: 'empty' as AddStatus,
    addInvalidText: '',
    ...ADD_CLEARED,
    fxStyle: '',
  },

  onLoad() {
    this.recomputeDiff();
    this.recomputeAdd();
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
    const mode = (e.currentTarget.dataset as { mode: string }).mode;
    if (mode !== 'diff' && mode !== 'add') return;
    this.setData({ mode });
  },

  /* ---------- 间隔天数 ---------- */

  onFromChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ fromDate: String(e.detail.value) }, () => this.recomputeDiff());
  },

  onToChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ toDate: String(e.detail.value) }, () => this.recomputeDiff());
  },

  /** 交换起止：绝对天数不变，但"还有 / 已经过去"的方向句会翻过来 */
  onSwapDates() {
    this.setData(
      { fromDate: this.data.toDate, toDate: this.data.fromDate },
      () => this.recomputeDiff(),
    );
  },

  recomputeDiff() {
    const from = parseDate(this.data.fromDate);
    const to = parseDate(this.data.toDate);
    const summary = diffSummary(from, to);
    if (!summary || !from || !to) {
      this.setData({ diffDays: '', diffSpan: '', diffHint: '' });
      return;
    }
    this.setData({
      diffDays: String(summary.days),
      diffSpan: spanLabel(summary),
      diffHint: dateRangeHint(from, to),
    });
  },

  /* ---------- 推算日期 ---------- */

  onBaseChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ baseDate: String(e.detail.value) }, () => this.recomputeAdd());
  },

  onNInput(e: WechatMiniprogram.Input) {
    this.setData({ nText: e.detail.value }, () => this.recomputeAdd());
  },

  /** 空输入 / 非整数 / 越界三种情况分开说，不混成一句"出错了" */
  recomputeAdd() {
    const text = this.data.nText.trim();
    if (text === '') {
      this.setData({ addStatus: 'empty', addInvalidText: '', ...ADD_CLEARED });
      return;
    }
    const base = parseDate(this.data.baseDate);
    const n = Number(text);
    if (base === null || !Number.isInteger(n)) {
      this.setData({
        addStatus: 'invalid',
        addInvalidText: base
          ? `「${text}」不是整数天数，填 30 或 -7 这种`
          : '基准日期读不出来，重新选一天',
        ...ADD_CLEARED,
      });
      return;
    }
    const added = addDaysLabel(base, n);
    if (added === null) {
      this.setData({
        addStatus: 'invalid',
        addInvalidText: '推出来的日期超出 1970~2999 年，换个近一点的天数',
        ...ADD_CLEARED,
      });
      return;
    }
    this.setData({
      addStatus: 'ok',
      addInvalidText: '',
      addSrc: addSrcLabel(this.data.baseDate, n),
      addText: added.date,
      addWd: added.weekday,
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
