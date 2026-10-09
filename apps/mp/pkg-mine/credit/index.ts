/**
 * 信用与评价（文档 6.6.4）
 * 展示信用分、等级、加减分规则与流水，以及**收到的真实评价**（M3-16）。
 *
 * ⚠️ 评价区与信用分是两条独立的拉取：任何一条失败都只在自己的区块给错误条，
 *    不把"评价没拉下来"演成"你还没有评价"（红线 1）。
 *
 * ⚠️ 计费模式下本页额外提供"积分流水"Tab；**免费开放期整块隐藏**
 *    （积分不参与扣费，摆出来只会让人困惑）。含"积分"二字的文案统一出自 utils/billing。
 * 视觉：琥珀主题 · 糖果圆环信用分 + 彩色指示条流水卡
 */
import { orderApi, userApi } from '../../utils/api';
import type { ReviewItem } from '../../utils/api';
import {
  POINTS_EARN_TITLE,
  POINTS_EMPTY_TEXT,
  POINTS_EMPTY_TITLE,
  POINTS_LEDGER_SUB,
  POINTS_LEDGER_TITLE,
  POINTS_RULES_TIP,
  creditHeadSub,
  loadBillingMode,
  pointsTabLabel,
  showPoints,
} from '../../utils/billing';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';

/** 信用等级（文档 6.6.4） */
function levelOf(score: number): { label: string; desc: string } {
  if (score >= 95) return { label: '优秀', desc: '优先推荐 · 可接高价单' };
  if (score >= 85) return { label: '良好', desc: '正常推荐' };
  if (score >= 70) return { label: '一般', desc: '推荐权重降低' };
  return { label: '风险', desc: '限制接单，需整改' };
}

/** 加减分规则（与文档 6.6.4 表格一致；icon 为纯展示的糖果图标类名） */
const RULES = [
  { action: '完成一单（5 星）', delta: '+2', icon: 'qz-i-star' },
  { action: '完成一单（4 星）', delta: '+1', icon: 'qz-i-star' },
  { action: '收到差评', delta: '-3', icon: 'qz-i-fire' },
  { action: '按时交付', delta: '+1', icon: 'qz-i-clock' },
  { action: '超时交付', delta: '-5', icon: 'qz-i-clock' },
  { action: '违约/取消（服务者责任）', delta: '-10', icon: 'qz-i-close' },
  { action: '被平台仲裁判责', delta: '-15', icon: 'qz-i-close' },
];

interface LogRow {
  delta: string;
  reason: string;
  balance: number;
  time: string;
  positive: boolean;
}

/** 把分数换算成进度条百分比（纯展示） */
function pctOf(score: number): number {
  return Math.min(100, Math.max(0, score));
}

/** 星级（文档 6.6.4：★ 字符渲染即可，不引第三方评分组件） */
const STARS = ['', '★', '★★', '★★★', '★★★★', '★★★★★'];

/**
 * 一条收到的评价 + 展示字段。
 *
 * `stars` / `timeText` / `who` 在 TS 里算好：WXML 不能调函数，
 * 而 `anonymous` 这一项**必须**在前端也判一次 —— 后端匿名时下发的是
 * 「匿名同学」，但只靠服务端字符串的话，任何一处映射漏改就会把昵称漏出去。
 */
interface ReviewView extends ReviewItem {
  stars: string;
  timeText: string;
  who: string;
}

function toReviewView(r: ReviewItem): ReviewView {
  return {
    ...r,
    stars: STARS[Math.min(5, Math.max(1, r.rating))] ?? '',
    timeText: (r.createdAt ?? '').slice(0, 10),
    who: r.anonymous ? '匿名同学' : r.nickname || '同学',
  };
}

Page({
  data: {
    tab: 'credit' as 'credit' | 'points',
    score: 80,
    scorePct: 80,
    level: { label: '一般', desc: '推荐权重降低' },
    rules: RULES,
    creditLogs: [] as LogRow[],
    pointsLogs: [] as LogRow[],
    points: 0,
    /** 是否展示积分相关 UI：免费开放期整块隐藏（界面里不出现"积分"二字） */
    showPoints: false,
    /** 顶部副标题（免费期不提"积分流水"） */
    headSub: '信用分、加减分规则与流水',
    /** 以下标签文案统一出自 utils/billing —— 含"积分"的文案只允许在那里出现 */
    pointsTabLabel: '',
    pointsEarnTitle: POINTS_EARN_TITLE,
    pointsLedgerTitle: POINTS_LEDGER_TITLE,
    pointsLedgerSub: POINTS_LEDGER_SUB,
    pointsEmptyTitle: POINTS_EMPTY_TITLE,
    pointsEmptyText: POINTS_EMPTY_TEXT,
    pointsRulesTip: POINTS_RULES_TIP,

    /* ---------- 收到的评价（M3-16：验收时打的分与写的话） ---------- */
    reviews: [] as ReviewView[],
    reviewsTotal: 0,
    reviewsLoading: true,
    /** 拉取失败的原因：不能退成"还没有收到评价"的空态 —— 那是把失败演成没数据 */
    reviewsError: '',

    loading: true,
    /**
     * 信用/积分数据加载失败的原因。**不能静默** ——
     * 失败时页面仍显示默认 80 分，会把"没加载出来"演成"你信用一般"（红线 1：
     * 不许把失败态伪装成正常态）。有值时分数卡替换为错误条 + 重试。
     */
    creditError: '',
    pointsError: '',
    fxStyle: '',
  },

  onLoad(query: Record<string, string>) {
    if (query.tab === 'points') this.setData({ tab: 'points' });
    void this.loadAll();
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

  /** 下拉刷新：重拉后必须 stop，否则顶部转圈不停 */
  async onPullDownRefresh() {
    try {
      await this.loadAll();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  async loadAll() {
    await loadBillingMode();
    const sp = showPoints();
    this.setData({
      showPoints: sp,
      headSub: creditHeadSub(),
      // 免费期没有积分 Tab：若从外部带 ?tab=points 进来，纠正回信用流水，
      // 否则会停在一个不存在的内容区（界面空白且看不出原因）
      tab: sp ? this.data.tab : 'credit',
    });
    await Promise.allSettled([
      this.loadCredit(),
      this.loadReviews(),
      sp ? this.loadPoints() : Promise.resolve(),
    ]);
    this.setData({ loading: false });
  },

  async loadCredit() {
    try {
      const res = await userApi.credit();
      this.setData({
        creditError: '',
        score: res.score,
        scorePct: pctOf(res.score),
        level: levelOf(res.score),
        creditLogs: (res.logs as Record<string, unknown>[]).map((l) => ({
          delta: Number(l.delta) >= 0 ? `+${l.delta}` : String(l.delta),
          reason: String(l.reason),
          balance: Number(l.balanceAfter),
          time: String(l.createdAt ?? '').slice(0, 10),
          positive: Number(l.delta) >= 0,
        })),
      });
    } catch (e) {
      this.setData({ creditError: (e as Error).message || '信用数据加载失败' });
    }
  },

  /**
   * 收到的评价（`GET /orders/reviews/received`，M3-16）。
   *
   * 这一份数据与信用分是同一件事的两面：分数是结果，评价是原因。
   * 匿名项后端已把昵称换成「匿名同学」并**不下发 peerId**（结构性防泄露），
   * 这里只按 `anonymous` 决定显示什么，不去猜对方是谁。
   */
  async loadReviews() {
    try {
      const res = await orderApi.reviewsReceived();
      this.setData({
        reviews: res.list.map(toReviewView),
        reviewsTotal: res.total,
        reviewsError: '',
        reviewsLoading: false,
      });
    } catch (e) {
      this.setData({ reviewsError: (e as Error).message || '评价加载失败', reviewsLoading: false });
    }
  },

  async loadPoints() {
    try {
      const res = await userApi.points();
      this.setData({
        pointsError: '',
        points: res.points,
        pointsTabLabel: pointsTabLabel(res.points),
        pointsLogs: (res.logs as Record<string, unknown>[]).map((l) => ({
          delta: Number(l.delta) >= 0 ? `+${l.delta}` : String(l.delta),
          reason: String(l.reason),
          balance: Number(l.balanceAfter),
          time: String(l.createdAt ?? '').slice(0, 10),
          positive: Number(l.delta) >= 0,
        })),
      });
    } catch (e) {
      this.setData({ pointsError: (e as Error).message || '流水数据加载失败' });
    }
  },

  /** 错误条上的重试：重拉当前 Tab 对应的数据 */
  onRetry() {
    if (this.data.tab === 'points') {
      void this.loadPoints();
      return;
    }
    void this.loadCredit();
    void this.loadReviews();
  },

  /** 评价区自己的重试：只重拉评价，不动信用分（两者是不同的接口、不同的失败原因） */
  onRetryReviews() {
    this.setData({ reviewsLoading: true, reviewsError: '' });
    void this.loadReviews();
  },

  onTabTap(e: WechatMiniprogram.TouchEvent) {
    this.setData({ tab: e.currentTarget.dataset.tab as 'credit' | 'points' });
  },
});
