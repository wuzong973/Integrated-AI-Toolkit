/**
 * 任务详情（文档 5.3.9）：报名 / 选定服务者
 * 视觉：装饰层随指针视差（utils/fx.ts），内容区不跟随。
 */
import type { TaskItem } from '../../utils/api';
import { stationApi } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { toastError } from '../../utils/request';

/** 状态 → 展示文案 */
const STATUS_TEXT: Record<string, string> = {
  draft: '草稿',
  reviewing: '审核中',
  published: '招募中',
  assigned: '已选定',
  in_progress: '进行中',
  pending_acceptance: '待验收',
  completed: '已完成',
  closed: '已关闭',
  canceled: '已取消',
};

Page({
  data: {
    taskId: '',
    task: null as (TaskItem & { statusText: string; budgetYuan: string }) | null,
    /** 当前用户是否为发布者 */
    isPublisher: false,
    /** 当前用户是否可报名 */
    canApply: false,
    applications: [] as {
      id: string;
      providerId: string;
      providerName: string;
      /** 信用分（此前误标为"评分"；评分来自评价，信用分来自平台规则，两者不同） */
      rating: number;
      quote: number;
      /** 报价展示文案；未报价时为空串（模板据此显示"待议"，而不是"¥0"） */
      quoteYuan: string;
      message: string;
      matchScore?: number;
      hasMatch: boolean;
      matchWhy: string;
    }[],
    /** 推荐服务者（仅发布者、且无人报名时加载，M3-09） */
    recommended: [] as {
      userId: string;
      nickname: string;
      score: number;
      matchWhy: string;
    }[],
    loading: true,
    error: '',
    /** 装饰层视差位移（由 utils/fx.ts 写入） */
    fxStyle: '',
  },

  onLoad(query: Record<string, string>) {
    const taskId = query.id || '';
    this.setData({ taskId });
    void this.loadTask(taskId);
  },

  onShow() {
    // 真机上开启陀螺仪倾斜视差；开发者工具无传感器时会静默跳过
    fxEnableTilt(this);
  },

  onHide() {
    fxDisableTilt();
  },

  onUnload() {
    fxDisableTilt();
  },

  /** 下拉刷新：详情 + （发布者视角的）报名列表一起重拉 */
  async onPullDownRefresh() {
    try {
      await this.loadTask(this.data.taskId);
      if (this.data.isPublisher) await this.loadApplications(this.data.taskId);
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  async loadTask(taskId: string) {
    if (!taskId) {
      this.setData({ loading: false, error: '缺少任务 ID' });
      return;
    }

    try {
      const task = await stationApi.task(taskId);
      const app = getApp<IAppOption>();
      const me = app?.globalData?.user as { id?: string } | null;

      this.setData({
        task: {
          ...task,
          statusText: STATUS_TEXT[task.status] ?? task.status,
          budgetYuan: (task.budget / 100).toFixed(0),
        },
        isPublisher: !!me?.id && task.publisher?.id === me.id,
        canApply: task.status === 'published' && task.source !== 'os_plan',
        loading: false,
        error: '',
      });

      // 发布者才拉报名情况。以前这段完全没有 —— `applications` 恒为空数组，
      // 于是无论有多少人报名，发布者看到的都是"还没有人报名"（静默空态）。
      if (this.data.isPublisher) void this.loadApplications(taskId);
    } catch (e) {
      this.setData({ loading: false, error: (e as Error).message || '任务加载失败' });
    }
  },

  /** 报名者列表（仅发布者） */
  async loadApplications(taskId: string) {
    try {
      const list = await stationApi.applications(taskId);
      this.setData({
        applications: (list ?? []).map((a) => ({
          id: a.id,
          providerId: a.providerId,
          providerName: a.nickname,
          rating: a.creditScore,
          quote: a.quote,
          message: a.message ?? '',
          quoteYuan: a.quote > 0 ? (a.quote / 100).toFixed(0) : '',
          matchScore: a.matchScore,
          hasMatch: typeof a.matchScore === 'number',
          matchWhy: (a.matchReasons ?? []).join(' · '),
        })),
      });
      // 没人报名时给"这条需求适合谁"——否则发布者只看到一句"还没有人报名"就无路可走
      if (!list?.length) await this.loadRecommended(taskId);
    } catch (e) {
      toastError(e);
    }
  },

  /**
   * 推荐服务者（M3-09，仅在没有报名时展示）。
   *
   * 刻意**不给"邀请"按钮**：主动邀请要发订阅消息（M3-19），
   * 而那个模块还没开工 —— 摆一个点了没反应的按钮就是又一个"假成功"。
   * 这里只呈现事实（谁合适、为什么合适），发布者可以自己线下联系。
   */
  async loadRecommended(taskId: string) {
    try {
      const list = await stationApi.match(taskId);
      this.setData({
        recommended: (list ?? []).slice(0, 5).map((p) => ({
          userId: p.userId,
          nickname: p.nickname,
          score: p.score,
          matchWhy: (p.reasons ?? []).join(' · '),
        })),
      });
    } catch {
      // 推荐失败不影响报名情况展示
    }
  },

  /** 服务者报名 / 抢单 */
  onApply() {
    wx.showModal({
      title: '报名接单',
      editable: true,
      placeholderText: '可以留一句话说明你的优势（可选）',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await stationApi.apply(this.data.taskId, { message: res.content });
          wx.showToast({ title: '报名成功，等待发布者选定', icon: 'success' });
          void this.loadTask(this.data.taskId);
        } catch (e) {
          toastError(e);
        }
      },
    });
  },

  /** 私聊发布者（首版轻量会话） */
  onChat() {
    wx.navigateTo({ url: `/pkg-station/chat/index?taskId=${this.data.taskId}` });
  },

  /** 发布者：编辑 */
  onEdit() {
    wx.navigateTo({ url: `/pkg-station/publish/index?taskId=${this.data.taskId}` });
  },

  /**
   * 发布者：选定服务者。
   *
   * ⚠️ 以前是**假成功**：弹一句"已选定，请完成支付"就把用户送去订单列表 ——
   * 但**没有任何接口被调用**，订单也不存在。用户被引到一条死路上，且一路都显示"成功"。
   *
   * 现在 `POST /station/tasks/:id/select` 会在**同一事务**里把任务置为已选定
   * 并生成担保订单，所以拿到 `orderId` 就能直接进支付流程。
   */
  onSelect(e: WechatMiniprogram.TouchEvent) {
    const providerId = e.currentTarget.dataset.id as string;
    if (!providerId) return;

    wx.showModal({
      title: '选定服务者',
      content: '选定后会生成担保订单并进入支付流程，确认吗？',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中…', mask: true });
        try {
          const result = await stationApi.select(this.data.taskId, providerId);
          wx.hideLoading();
          wx.showToast({ title: '已选定，去支付', icon: 'success' });
          // 带着订单 id 进订单详情：支付在那一页完成
          setTimeout(() => {
            wx.navigateTo({ url: `/pkg-station/order-detail/index?id=${result.orderId}` });
          }, 700);
        } catch (err) {
          wx.hideLoading();
          toastError(err);
        }
      },
    });
  },

  /**
   * 发布者：关闭需求。
   *
   * ⚠️ 以前同样是假成功：弹"已关闭"、跳回大厅，但需求状态从未改变。
   */
  onClose() {
    wx.showModal({
      title: '关闭需求',
      content: '关闭后其他同学将无法再报名，确认关闭吗？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await stationApi.close(this.data.taskId);
          wx.showToast({ title: '已关闭', icon: 'success' });
          setTimeout(() => wx.switchTab({ url: '/pages/station/index' }), 700);
        } catch (e) {
          toastError(e);
        }
      },
    });
  },

  onGoLogin() {
    wx.navigateTo({ url: '/pages/common/login' });
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
