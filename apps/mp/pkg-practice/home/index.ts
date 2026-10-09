/**
 * 练习中心 · 首页（首页金刚区「练习中心」的落点）
 *
 * 三个模块的入口 + 今日进度 + 连续打卡。
 *
 * ## 题面不在这里取
 *
 * 本页只调 `GET /practice/today`（计划 + 计数 + 日历），**不调 `cards`**。
 * 三种题面的形状差得太远（句子卡 / 句子卡+录音 / 作文题），在这里预取等于
 * 白白请求两个用不上的模块；进到具体模块页再取，也天然避免"进了又退"时的浪费。
 *
 * ## 所有文案在 TS 里算完
 *
 * WXML 不能调函数，所以百分比、进度文案、模块卡片上的小字全部预计算成字符串。
 */
import { practiceApi } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import type { PracticeModuleItem, PracticeModulePlan, PracticeTodayResult } from '../../utils/api';

/** 一个模块入口卡片（文案已算好，WXML 直接渲染） */
interface ModuleCard {
  module: string;
  title: string;
  hint: string;
  /** 今日配额 / 已做，渲染成 "3/10" */
  quotaText: string;
  /** 0~100 */
  percent: number;
  doneText: string;
  /** 有到期复习时给一个角标（这是 SM-2 在起作用最直接的体现） */
  dueText: string;
  hasDue: boolean;
  canStart: boolean;
  /** 空态原因（原样转述后端那句；不要自己编"暂无数据"） */
  emptyReason: string;
}

/** 打卡日历的一格 */
interface CalendarCell {
  day: string;
  /** 星期几的中文（只显示在首行，避免每格都重复） */
  dow: string;
  count: number;
  has: boolean;
  isToday: boolean;
}

Page({
  data: {
    loading: true,
    loaded: false,
    error: '',

    modules: [] as ModuleCard[],
    calendar: [] as CalendarCell[],

    streak: 0,
    todayDone: 0,
    tracked: 0,
    mastered: 0,
    due: 0,
    sentenceAccuracy: 0,
    speakAvg: 0,
    writeAvg: 0,

    fxStyle: '',
  },

  onShow() {
    fxEnableTilt(this);
    // 从模块页返回时进度会变，所以每次显示都刷一遍；已有数据时不显示骨架
    void this.load(this.data.loaded);
  },

  onHide() {
    fxDisableTilt();
  },

  onUnload() {
    fxDisableTilt();
  },

  async load(silent: boolean) {
    if (!silent) this.setData({ loading: true });
    try {
      const [res, listRes] = await Promise.all([practiceApi.today(), practiceApi.modules()]);
      this.setData({ ...this.toView(res, listRes.modules), error: '', loading: false, loaded: true });
    } catch (e) {
      this.setData({ error: (e as Error).message || '加载失败', loading: false });
    }
  },

  /** 后端响应 → 视图字段（所有文案在此算完） */
  toView(res: PracticeTodayResult, items: PracticeModuleItem[]) {
    // ⚠️ 模块清单与计划**分两次请求**，所以不能假设两边都有对方的数据：
    // `today` 给计划，`modules` 给标题与说明。合并时以 `modules` 的顺序为准
    // （那是后端定义的推荐顺序），并按 module 匹配计划。
    //
    // 这里对 `items` 再做一次数组检查：`/practice/modules` 把清单包在
    // `{modules:[...]}` 里，取错一层就是 `list.map is not a function` ——
    // 一条**看不出是哪出错**的运行时报错。兜住之后界面上会说清"返回结构不对"，
    // 而不是让整页只剩一行英文报错。
    const list = Array.isArray(items) ? items : [];
    const planOf = new Map((res.modules ?? []).map((p) => [p.module, p]));
    const cards = list
      .map((m) => toModuleCard(m, planOf.get(m.module)))
      // 后端加了新模块但 `today` 还没支持时，`plan` 会是 undefined ——
      // 此时**保留卡片但显示"暂不可用"**，而不是把它丢掉（丢掉是静默的）。
      .filter((c): c is ModuleCard => c !== null);

    const todayDone = res.today.sentenceCount + res.today.speakCount + res.today.writeCount;

    return {
      modules: cards,
      calendar: toCalendar(res.calendar),
      streak: res.streak,
      todayDone,
      tracked: res.totals.tracked,
      mastered: res.totals.mastered,
      due: res.totals.due,
      sentenceAccuracy: res.totals.sentenceAccuracy,
      speakAvg: res.totals.speakAvg,
      writeAvg: res.totals.writeAvg,
    };
  },

  /** 进某个模块 */
  onOpen(e: WechatMiniprogram.TouchEvent) {
    const module = e.currentTarget.dataset.module as string;
    const card = this.data.modules.find((m) => m.module === module);
    if (!card) return;
    if (!card.canStart) {
      // 不能开始时要**说清为什么**（后端给了原因就转述，没有才兜底）
      wx.showToast({ title: card.emptyReason || '这个模块暂时没有可练的题', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `/pkg-practice/session/index?module=${module}` });
  },

  onStats() {
    wx.navigateTo({ url: '/pkg-practice/stats/index' });
  },

  onRetry(): Promise<void> {
    return this.load(false);
  },

  onPullDownRefresh() {
    void this.load(false).finally(() => wx.stopPullDownRefresh());
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
 * 模块元信息 + 今日计划 → 入口卡片。
 *
 * `plan` 可能是 undefined（后端加了模块但 `today` 还没支持）——
 * 那时返回一张**明确写着"暂不可用"的卡片**，而不是 null 丢掉：
 * 丢掉的话用户看到的是"金刚区有这个入口，模块列表里却没有"，没有任何解释。
 */
function toModuleCard(m: PracticeModuleItem, plan: PracticeModulePlan | undefined): ModuleCard | null {
  if (!plan) {
    return {
      module: m.module,
      title: m.title || m.module,
      hint: m.hint || '',
      quotaText: '—',
      percent: 0,
      doneText: '暂不可用',
      dueText: '',
      hasDue: false,
      canStart: false,
      emptyReason: '这个模块还没开放，稍后再来',
    };
  }
  const target = Math.max(1, plan.quota + plan.done);
  const percent = Math.min(100, Math.round((plan.done / target) * 100));
  return {
    module: m.module,
    title: m.title || plan.title || m.module,
    hint: m.hint || '',
    quotaText: `${plan.done}/${plan.quota + plan.done}`,
    percent,
    // 已做完时给一句正向的完成语，而不是干巴巴的 "10/10"
    doneText: plan.done >= plan.quota + plan.done ? '今天已完成' : `今天已练 ${plan.done} 题`,
    dueText: plan.reviewDue > 0 ? `到期复习 ${plan.reviewDue}` : '',
    hasDue: plan.reviewDue > 0,
    canStart: plan.available > 0,
    emptyReason: plan.emptyReason,
  };
}

/**
 * 打卡日历：后端给最近 30 天（缺的补零），这里补上"星期几"与"是不是今天"。
 *
 * ⚠️ 后端返回的 `day` 是 `YYYY-MM-DD`。**不要用 `new Date(day)` 去判星期** ——
 * `new Date('2026-09-21')` 会按 UTC 解析，在东八区会算成前一天，
 * 星期几整体错一格且不报错。这里手工按年月日构造本地时间。
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
