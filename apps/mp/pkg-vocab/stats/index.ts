/**
 * 记单词 · 学习统计
 *
 * ## 数据只有一处口径
 *
 * "已学 / 掌握 / 累计到期"复用后端 `plan.totals()`（与首页同一份实现），
 * 不在这里重算 —— 两页各算一遍，表现是首页说"待复习 12"、统计页说"待复习 8"，
 * 而这种漂移用户看得见、代码里查不到。
 *
 * ## 日历补零由后端做
 *
 * `calendar` 是**最近 30 天、含没学的那几天**（缺的补零）。
 * 界面不做补零：前端补零就得自己处理时区与月界，而后端已经在业务日口径下算好了。
 *
 * ## 深色格子的分级阈值写在这里，是有意的
 *
 * 三档（1-9 / 10-29 / 30+）是**界面表达**，不是业务规则 —— 后端不该知道
 * "多少题算颜色深"。所以它不进 `packages/core`。
 */
import { vocabApi } from '../../utils/api';
import type { VocabDayLog, VocabStatsResult } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';

/** 打卡格子（`level` 决定深浅，`today` 画出今天的圈） */
interface CellRow {
  key: string;
  dayNum: number;
  level: number;
  today: boolean;
  /** 点格子时显示的那一天明细 */
  detail: string;
}

Page({
  data: {
    loading: true,
    error: '',
    bookName: '',
    streak: 0,
    totalLearned: 0,
    mastered: 0,
    accuracy: 0,
    dueToday: 0,
    cells: [] as CellRow[],
    /** 日历下方的说明行：默认提示怎么用，点格子后显示那一天的明细 */
    detail: '点一下格子，看那天的记录',
    fxStyle: '',
  },

  onShow() {
    fxEnableTilt(this);
    // 从学习页返回时数据会变，所以每次显示都重拉
    void this.load();
  },

  onHide() {
    fxDisableTilt();
  },

  onUnload() {
    fxDisableTilt();
  },

  async load() {
    try {
      const res = await vocabApi.stats();
      this.setData({ ...toView(res), error: '', loading: false });
    } catch (e) {
      this.setData({ error: (e as Error).message || '加载失败', loading: false });
    }
  },

  /** 点格子看那一天：数字只在点了之后才出现，界面平时保持安静 */
  onCellTap(e: WechatMiniprogram.TouchEvent) {
    const key = e.currentTarget.dataset.key as string;
    const cell = this.data.cells.find((c) => c.key === key);
    if (cell) this.setData({ detail: cell.detail });
  },

  /** 还有到期的词 → 直接去学（redirectTo：学完再回来统计是新的数据） */
  onStudy() {
    wx.redirectTo({ url: '/pkg-vocab/study/index' });
  },

  onBack() {
    wx.navigateBack();
  },

  onRetry(): Promise<void> {
    this.setData({ loading: true, error: '' });
    return this.load();
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

/** 响应 → 视图（日历补零已在后端完成，这里只做分级与文案） */
function toView(res: VocabStatsResult) {
  return {
    bookName: res.book?.name ?? '',
    streak: res.streak,
    totalLearned: res.totalLearned,
    mastered: res.mastered,
    accuracy: res.accuracy,
    dueToday: res.dueToday,
    // 日历是"最早 → 今天"，所以最后一格就是今天
    cells: res.calendar.map((log, i) => toCell(log, i === res.calendar.length - 1)),
  };
}

/** 一格：答得越多颜色越深（0 题 = 空档，一眼看出哪几天断了） */
function toCell(log: VocabDayLog, today: boolean): CellRow {
  const answered = log.correctCount + log.wrongCount;
  return {
    key: log.day,
    dayNum: Number(log.day.slice(8, 10)),
    level: answered === 0 ? 0 : answered < 10 ? 1 : answered < 30 ? 2 : 3,
    today,
    detail: detailOf(log),
  };
}

/** 那一天的明细（点格子时显示）：没学也要说清是"没学"，而不是留一片空白 */
function detailOf(log: VocabDayLog): string {
  const answered = log.correctCount + log.wrongCount;
  if (answered === 0) return `${monthDay(log.day)}：没有学习记录`;
  return `${monthDay(log.day)}：新学 ${log.newCount} · 复习 ${log.reviewCount} · 答对 ${log.correctCount}/${answered}`;
}

function monthDay(day: string): string {
  return `${Number(day.slice(5, 7))} 月 ${Number(day.slice(8, 10))} 日`;
}