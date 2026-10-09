/**
 * 服务者工作台（文档 5.3.10）
 * 视觉：装饰层随指针视差（utils/fx.ts），内容区不跟随。
 */
import type { OrderItem } from '../../utils/api';
import { orderApi, stationApi } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';

interface RecommendedTask {
  id: string;
  title: string;
  budget: number;
  skillTags: string[];
  location: string;
  /**
   * 匹配度。**可能是 undefined** —— 服务端只在能算出来时才下发。
   * 以前这里是必填的 `number`，而页面为了填上它编了一个按序号递减的假分数
   * （红线 10）。类型改成可选，就是在编译期阻止"再编一个"。
   */
  matchScore?: number;
  /** 服务端是否真的给出了匹配度（模板据此决定要不要渲染这一行） */
  hasMatch: boolean;
  /** 匹配依据（已拼成一句） */
  matchWhy: string;
}

/**
 * 经营指标。**一律是"算好的展示串"**，不再放原始数字 ——
 * 页面曾写死 `{ todayIncome: 0, pendingCount: 0, completionRate: 100 }` 且永不更新，
 * 于是新人一进来就看到"完单率 100%"（红线：不许假数据冒充业绩）。
 */
interface WorkbenchStats {
  /** 今日收入（含 ¥，两位小数；没加载出来是 '—'） */
  todayIncome: string;
  /** 进行中的单数（担保中 / 服务中 / 待验收） */
  pendingCount: string;
  /** 完单率，已带百分号；一笔都没结算过时是 '—'（没有分母的 100% 不是成绩，是空集） */
  completionRate: string;
  /** 本月收入 / 累计收入（含 ¥） */
  monthIncome: string;
  totalIncome: string;
  /** 已完成订单数：决定收入 Tab 显示明细还是空态 */
  completedCount: number;
}

/** 收入明细行（已完成订单，真实数据） */
interface IncomeRow {
  id: string;
  title: string;
  amountText: string;
  dateText: string;
}

/** 还欠着活的订单状态 —— 计入"待处理" */
const PENDING_STATUSES = ['paid', 'in_service', 'pending_acceptance'];
/** 已结算的订单状态 —— 完单率的分母（进行中的单不进分母，否则新人永远是 0%） */
const SETTLED_STATUSES = ['completed', 'refunded', 'canceled', 'closed'];

/** 经营数据拉不到时的占位：全 '—'，不兜 0 也不兜 100% */
const BLANK_STATS: WorkbenchStats = {
  todayIncome: '—',
  pendingCount: '—',
  completionRate: '—',
  monthIncome: '—',
  totalIncome: '—',
  completedCount: 0,
};

/** 分 → 带 ¥ 的元字符串（库里金额一律是「分」，只在展示时换算） */
function yuan(fen: number): string {
  return `¥${(fen / 100).toFixed(2)}`;
}

/** 本地日期键：`withDay` 给 '年-月-日'，否则给 '年-月'；解析失败返回空串（宁可不计，也不猜） */
function dateKey(d: Date, withDay: boolean): string {
  if (Number.isNaN(d.getTime())) return '';
  const base = `${d.getFullYear()}-${d.getMonth() + 1}`;
  return withDay ? `${base}-${d.getDate()}` : base;
}

/** createdAt 是否落在今天（按设备本地时区） */
function isToday(iso: string): boolean {
  return dateKey(new Date(iso), true) === dateKey(new Date(), true);
}

/** createdAt 是否落在本月 */
function isThisMonth(iso: string): boolean {
  return dateKey(new Date(iso), false) === dateKey(new Date(), false);
}

/** 一批订单的服务者实收合计（分） */
function sumIncome(rows: OrderItem[]): number {
  return rows.reduce((acc, o) => acc + (o.providerIncome ?? 0), 0);
}

Page({
  data: {
    /** 经营指标：由 loadStats 用订单接口真实计算 */
    stats: BLANK_STATS,
    /** 经营数据加载失败的原因（显示错误条，不把 0 演成真实业绩） */
    statsError: '',
    /**
     * 统计口径说明。后端 `GET /orders` 只返回**最近 50 笔**（`take: 50`），
     * 单子多的服务者会算少 —— 必须把这个前提写出来，
     * 不能让用户把"最近 50 笔的合计"读成"全部累计"。
     */
    statsNote: '',
    tab: 'hall' as 'hall' | 'mine' | 'income',
    recommended: [] as RecommendedTask[],
    /** 收入 Tab 的明细（已完成订单） */
    incomeRows: [] as IncomeRow[],
    myTasks: [] as {
      id: string;
      title: string;
      status: string;
      statusText: string;
      deadline: string;
    }[],
    acceptOrders: true,
    loading: false,
    /**
     * 两个列表各自的加载失败原因。**不能静默** ——
     * 失败时显示"暂无推荐任务"会把"没加载出来"演成"真的没有"，
     * 用户会以为是自己技能画像不够，而不是网络/服务的问题（红线 1）。
     */
    hallError: '',
    mineError: '',
    /** 装饰层视差位移（由 utils/fx.ts 写入） */
    fxStyle: '',
  },

  onShow() {
    void this.loadAll();
    // 真机上开启陀螺仪倾斜视差；开发者工具无传感器时会静默跳过
    fxEnableTilt(this);
  },

  onHide() {
    fxDisableTilt();
  },

  onUnload() {
    fxDisableTilt();
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
    this.setData({ loading: true });
    await Promise.allSettled([this.loadRecommended(), this.loadMyTasks(), this.loadStats()]);
    this.setData({ loading: false });
  },

  /**
   * 经营指标：全部由 `GET /orders?role=provider` 真实计算。
   *
   * ⚠️ 以前 data 里写死 `{ todayIncome: 0, pendingCount: 0, completionRate: 100 }`
   * 且没有任何一处更新它 —— 界面永远显示"完单率 100%"，一个没结过单的新号
   * 看起来像满绩老服务者（红线：不许假数据冒充业绩）。
   * 拉不到就整块标 '—' 并给错误条，绝不兜一个好看的数。
   *
   * 口径：
   *   · 今日 / 本月 / 累计收入 = 对应区间内 `completed` 订单的 `providerIncome` 之和
   *     （服务者**实收**，已扣平台服务费，单位分 → 展示为元）；
   *   · 待处理 = `paid` / `in_service` / `pending_acceptance` 的条数；
   *   · 完单率 = completed /（completed + refunded + canceled + closed），
   *     分母为 0（一笔都没结算过）时显示 '—' 而不是 100%。
   */
  async loadStats() {
    try {
      const res = await orderApi.list({ role: 'provider' });
      const list = res.list ?? [];
      const completed = list.filter((o) => o.status === 'completed');
      const settledCount = list.filter((o) => SETTLED_STATUSES.includes(o.status)).length;
      this.setData({
        stats: {
          todayIncome: yuan(sumIncome(completed.filter((o) => isToday(o.createdAt)))),
          pendingCount: String(list.filter((o) => PENDING_STATUSES.includes(o.status)).length),
          completionRate: settledCount
            ? `${Math.round((completed.length / settledCount) * 100)}%`
            : '—',
          monthIncome: yuan(sumIncome(completed.filter((o) => isThisMonth(o.createdAt)))),
          totalIncome: yuan(sumIncome(completed)),
          completedCount: completed.length,
        },
        incomeRows: completed.slice(0, 10).map((o) => ({
          id: o.id,
          // 订单没带任务标题时退到订单号 —— 宁可显示单号，也不编一个"某服务"
          title: o.task?.title || o.orderNo,
          amountText: yuan(o.providerIncome ?? 0),
          dateText: o.createdAt.slice(0, 10),
        })),
        statsError: '',
        // 后端只给最近 50 笔：拿 total 一比就知道有没有被截断
        statsNote:
          (res.total ?? 0) > list.length
            ? `按最近 ${list.length} 笔订单统计（共 ${res.total} 笔）`
            : '',
      });
    } catch (e) {
      this.setData({
        stats: BLANK_STATS,
        incomeRows: [],
        statsNote: '',
        statsError: (e as Error).message || '经营数据加载失败',
      });
    }
  },

  /** 经营指标重试（指标卡与收入 Tab 共用一条错误条） */
  onRetryStats() {
    void this.loadStats();
  },

  /** 收入 Tab 空态的主操作：去接单大厅（tabBar 页只能 switchTab） */
  onGoHall() {
    wx.switchTab({ url: '/pages/station/index' });
  },

  /**
   * 推荐任务。
   *
   * ⚠️ 这里以前**编了一个匹配度**：`matchScore: Math.max(60, 95 - i * 7)` ——
   * 按列表序号递减，与技能、信用、距离毫无关系，却以"匹配度 95%"展示给服务者。
   * 用户完全无法分辨它是算出来的还是编的，而它看起来非常可信（红线 10）。
   *
   * 现在匹配度由服务端 `calcMatchScore`（技能 40 + 信用 20 + 完成率 15 +
   * 距离 15 + 价格 10 + 活跃度 5）真实计算，并附 `matchReasons` 说明依据。
   * **服务端没给就不显示**，绝不在这里兜一个数字 —— 那正是上次的做法。
   */
  async loadRecommended() {
    try {
      const res = await stationApi.tasks({ status: 'published' });
      const list = (res.list ?? []).slice(0, 5).map((t) => ({
        id: t.id,
        title: t.title,
        budget: t.budget,
        skillTags: t.skillTags ?? [],
        location: t.location ?? '本校',
        matchScore: t.matchScore,
        hasMatch: typeof t.matchScore === 'number',
        // WXML 里数组会被逗号拼起来，很难读；这里先拼成一句
        matchWhy: (t.matchReasons ?? []).join(' · '),
      }));
      this.setData({ recommended: list, hallError: '' });
    } catch (e) {
      this.setData({ hallError: (e as Error).message || '推荐任务加载失败' });
    }
  },

  /**
   * 我接的单。
   *
   * ⚠️ 以前用的是 `status: 'assigned'`，拿到的是**全站所有已选定任务** ——
   * 别人接的单会出现在我的工作台上。这不是显示问题，是**越权看到他人订单**，
   * 而且从界面上完全看不出是错的（列表里有内容、状态也对）。
   * 现在走服务端过滤 `role=provider`（`selectedProviderId = 我`）。
   */
  async loadMyTasks() {
    try {
      const res = await stationApi.tasks({ role: 'provider' });
      this.setData({
        myTasks: (res.list ?? []).map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          statusText: statusText(t.status),
          deadline: t.deadline ?? '待协商',
        })),
        mineError: '',
      });
    } catch (e) {
      this.setData({ mineError: (e as Error).message || '我的任务加载失败' });
    }
  },

  /** 错误条重试：分别重拉对应列表 */
  onRetryHall() {
    void this.loadRecommended();
  },
  onRetryMine() {
    void this.loadMyTasks();
  },

  onTabTap(e: WechatMiniprogram.TouchEvent) {
    this.setData({ tab: e.currentTarget.dataset.tab as 'hall' | 'mine' | 'income' });
  },

  /**
   * 工作台上的「报名接单」。
   *
   * 导航到任务详情 —— 那里的报名是**真实调用**（`POST /station/tasks/:id/apply`
   * 已于 M3-10 后端上线）。以前这里弹"开发中"，是因为当时报名接口实测 404，
   * 导航过去也只是把失败推后一步；现在两端都就绪，直接进详情页完成报名+报价。
   */
  onAcceptTap(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pkg-station/task/index?id=${e.currentTarget.dataset.id}` });
  },

  onTaskTap(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pkg-station/task/index?id=${e.currentTarget.dataset.id}` });
  },

  /**
   * 接单开关。
   *
   * ⚠️ 它**只改本机状态** —— 后端没有"服务者是否接收推送"的设置接口，
   * 所以提示必须写清"本地"：以前弹一句"已关闭接单"，用户以为平台不再派单了，
   * 实际推送照旧（红线：不许把本地开关说成服务端生效）。
   */
  onToggleAccept() {
    const next = !this.data.acceptOrders;
    this.setData({ acceptOrders: next });
    wx.showToast({
      title: next ? '已在本地恢复接单（推送设置开发中）' : '已在本地暂停（平台推送设置开发中）',
      icon: 'none',
    });
  },

  onSkill() {
    wx.navigateTo({ url: '/pkg-station/skill/index' });
  },

  onSwitchRole() {
    wx.switchTab({ url: '/pages/mine/index' });
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

function statusText(s: string): string {
  const m: Record<string, string> = {
    assigned: '待支付',
    in_progress: '服务中',
    pending_acceptance: '待验收',
    completed: '已完成',
  };
  return m[s] ?? s;
}
