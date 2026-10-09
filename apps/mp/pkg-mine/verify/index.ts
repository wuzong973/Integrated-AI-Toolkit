/**
 * 认证中心（学生认证 / 服务者认证状态）
 *
 * ## 这个页面此前是骨架 + 假按钮
 *
 * 它渲染"学生认证功能开发中"，主按钮 `onStart` 弹一句"认证入口即将开放" ——
 * 而**入口其实不存在**（服务者入驻页 `pkg-station/apply` 在静态守卫里是孤岛页，
 * 全仓库零入站跳转）。也就是说：既没有入口，也没有页面。
 *
 * 现在它是**唯一的状态出口**：把 `GET /provider/profile` 的真实状态摊开，
 * 并按状态给出下一步动作。被驳回时**把原因显示在这里** ——
 * M3-02 的验收标准就是"驳回时给出具体原因"，用户从"我的"点进来必须能直接看到。
 *
 * 视觉：靛蓝主题 · 页头 + 状态卡。
 */
import { providerApi } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';

/** 认证状态 → 展示文案与色调（`tone` 对应 scss 里的修饰类） */
const STATUS_TEXT: Record<string, { label: string; desc: string; tone: string }> = {
  none: { label: '未认证', desc: '完成入驻认证后即可在驿站接单', tone: 'idle' },
  pending: { label: '审核中', desc: '平台正在审核你的材料，结果会在这里更新', tone: 'wait' },
  approved: { label: '已认证', desc: '你已可以接单，去工作台看看有哪些活', tone: 'ok' },
  rejected: { label: '未通过', desc: '按下方原因修改后可以重新提交', tone: 'bad' },
};

Page({
  data: {
    loading: true,
    error: '',
    /** none | pending | approved | rejected */
    status: 'none',
    statusLabel: '',
    statusDesc: '',
    tone: 'idle',
    /** 被驳回的原因（M3-02 验收要求必须给出） */
    rejectReason: '',
    /** 已认证时展示的技能标签 */
    skills: [] as string[],
    /** 主按钮文案（按状态变） */
    actionText: '',
    fxStyle: '',
  },

  onLoad() {
    void this.load();
  },

  onShow() {
    fxEnableTilt(this);
    // 从入驻页返回时要刷新状态 —— 用户刚提交完，回来还显示"未认证"会让人以为没提交上
    if (!this.data.loading) void this.load();
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
      await this.load();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  async load() {
    try {
      const profile = await providerApi.profile();
      const status = profile.isProvider ? 'approved' : (profile.verification?.status ?? 'none');
      const meta = STATUS_TEXT[status] ?? STATUS_TEXT.none;

      this.setData({
        loading: false,
        error: '',
        status,
        statusLabel: meta.label,
        statusDesc: meta.desc,
        tone: meta.tone,
        rejectReason: status === 'rejected' ? (profile.verification?.rejectReason ?? '') : '',
        skills: profile.skills ?? [],
        actionText: actionTextOf(status),
      });
    } catch (e) {
      this.setData({ loading: false, error: (e as Error).message || '加载失败' });
    }
  },

  onRetry() {
    this.setData({ loading: true, error: '' });
    void this.load();
  },

  /**
   * 主按钮。
   *
   * 三种状态各去一个**真实存在**的地方，不再有"即将开放"的占位：
   *   未认证 / 未通过 → 入驻页；审核中 → 留在本页刷新；已认证 → 工作台。
   */
  onAction() {
    const { status } = this.data;
    if (status === 'pending') {
      void this.load();
      wx.showToast({ title: '已刷新', icon: 'none' });
      return;
    }
    if (status === 'approved') {
      wx.navigateTo({ url: '/pkg-station/workbench/index' });
      return;
    }
    wx.navigateTo({ url: '/pkg-station/apply/index' });
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

/** 按状态给主按钮文案 */
function actionTextOf(status: string): string {
  if (status === 'pending') return '刷新审核状态';
  if (status === 'approved') return '去工作台接单';
  if (status === 'rejected') return '修改后重新提交';
  return '开始入驻认证';
}
