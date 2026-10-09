/**
 * 练习中心 · 统计页
 *
 * 与 `GET /practice/stats` 一一对应（后端与 `today` 是同一个方法，
 * 这里单独调是为了"从入口直接进统计"时不必先画一遍首页）。
 *
 * ## 日历的星期几**不能**用 `new Date('2026-09-21')` 算
 *
 * 那种写法按 **UTC** 解析，在东八区会算成前一天，整行星期几错一格，
 * 而且不报任何错。这里手工按年月日构造本地时间（见 `toCalendar`）。
 */
import { practiceApi } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import type { PracticeTodayResult } from '../../utils/api';

interface CalendarCell {
  day: string;
  dow: string;
  count: number;
  has: boolean;
  isToday: boolean;
}

interface ModuleStat {
  module: string;
  title: string;
  count: number;
  /** 该模块在总数里的占比（画一条细条） */
  percent: number;
}

Page({
  data: {
    loading: true,
    error: '',

    streak: 0,
    todayDone: 0,
    tracked: 0,
    mastered: 0,
    due: 0,
    sentenceAccuracy: 0,
    speakAvg: 0,
    writeAvg: 0,

    modules: [] as ModuleStat[],
    calendar: [] as CalendarCell[],
    /** 最近 30 天里练过的天数（比 streak 更能说明"碎片时间也用上了"） */
    activeDays: 0,

    fxStyle: '',
  },

  onLoad() {
    void this.load();
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

  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const res = await practiceApi.stats();
      this.setData({ ...this.toView(res), loading: false });
    } catch (e) {
      this.setData({ error: (e as Error).message || '加载失败', loading: false });
    }
  },

  toView(res: PracticeTodayResult) {
    const t = res.today;
    const todayDone = t.sentenceCount + t.speakCount + t.writeCount;
    const rows: Omit<ModuleStat, 'percent'>[] = [
      { module: 'sentence', title: '句子练习', count: t.sentenceCount },
      { module: 'speak', title: '口语跟读', count: t.speakCount },
      { module: 'write', title: '作文练习', count: t.writeCount },
    ];
    const max = Math.max(1, ...rows.map((r) => r.count));
    const calendar = toCalendar(res.calendar);

    return {
      streak: res.streak,
      todayDone,
      tracked: res.totals.tracked,
      mastered: res.totals.mastered,
      due: res.totals.due,
      sentenceAccuracy: res.totals.sentenceAccuracy,
      speakAvg: res.totals.speakAvg,
      writeAvg: res.totals.writeAvg,
      // 占比按"今天最多的那个模块"归一，而不是按总数 —— 三个模块题量差 10 倍，
      // 按总数归一的话作文那条永远看不见
      modules: rows.map((r) => ({ ...r, percent: Math.round((r.count / max) * 100) })),
      calendar,
      activeDays: calendar.filter((c) => c.has).length,
    };
  },

  onRetry(): Promise<void> {
    return this.load();
  },

  onBack() {
    wx.navigateBack();
  },

  onPullDownRefresh() {
    void this.load().finally(() => wx.stopPullDownRefresh());
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

/**
 * 打卡日历：补"星期几"与"是不是今天"。
 *
 * ⚠️ 手工按 `年/月/日` 构造 `Date`（走本地时区）。
 * 用 `new Date('2026-09-21')` 会按 UTC 解析 → 东八区算成前一天 → 星期几整行错位，
 * **且不会有任何报错**。
 */
function toCalendar(rows: PracticeTodayResult['calendar']): CalendarCell[] {
  const DOW = ['日', '一', '二', '三', '四', '五', '六'];
  const todayKey = dayKey(new Date());
  return rows.map((r) => {
    const [y, m, d] = r.day.split('-').map(Number);
    const date = new Date(y, (m ?? 1) - 1, d ?? 1);
    const count = r.sentenceCount + r.speakCount + r.writeCount;
    return {
      day: r.day,
      dow: DOW[date.getDay()] ?? '',
      count,
      has: count > 0,
      isToday: r.day === todayKey,
    };
  });
}

/** 本地时区的 `YYYY-MM-DD`（与后端 `bizDayKey` 同口径：东八区的当天） */
function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
