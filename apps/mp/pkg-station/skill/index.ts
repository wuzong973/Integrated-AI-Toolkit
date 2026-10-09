/**
 * 技能画像 —— 技能标签 / 认证材料 / 信用（服务者只读视图）
 *
 * ## 这一页以前是"硬编码空壳"
 *
 * `data.empty` 写死 `true`、`load()` 只把 `loading` 置 false —— 页面上那颗
 * "刷新试试"按钮**点了必然零效果**。与其说"功能开发中"，不如说"这页没接数据"。
 *
 * ## 数据源其实是真的
 *
 * `GET /provider/profile`（M3-02 已落地）返回 `isProvider`、画像技能标签、信用分、
 * 完成单数，以及最近一次入驻申请 `verification`（含技能标签、认证材料与审核状态）。
 * 所以这一页该做的是把**真实状态摊开**，而不是继续写"开发中"。
 *
 * ## 只读：不给"保存"按钮
 *
 * 后端没有"单独改一个技能标签"的接口（技能随入驻申请一起提交、一起审核），
 * 所以主操作只能把用户带回认证流程；在这里摆一个"保存修改"就是假功能（红线 1）。
 *
 * 视觉：青柠主题 · 大圆角 + 上翻波浪 + 光斑，突出"往上长"的成长感。
 */
import type { ProviderProfile } from '../../utils/api';
import { providerApi } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';

/** 页面阶段：只读画像 / 从未提交认证 / 加载中 / 出错 */
type Stage = 'loading' | 'none' | 'profile' | 'error';

/** 认证状态 → 徽章文案（`tone` 对应 index.scss 里的修饰类） */
const BADGE: Record<string, { label: string; tone: string }> = {
  approved: { label: '已认证服务者', tone: 'ok' },
  pending: { label: '认证审核中', tone: 'wait' },
  rejected: { label: '认证未通过', tone: 'bad' },
  none: { label: '未认证', tone: 'idle' },
};

/** 主按钮文案：四种状态各对应一个**真实可达**的动作 */
const ACTION: Record<string, string> = {
  approved: '修改认证资料',
  pending: '刷新认证状态',
  rejected: '重新提交认证',
  none: '去入驻认证',
};

Page({
  data: {
    stage: 'loading' as Stage,
    error: '',
    /** approved | pending | rejected | none */
    status: 'none',
    badge: BADGE.none,
    actionText: ACTION.none,
    /** 技能标签：画像里有就用画像，否则用上次认证申请里填的 */
    skills: [] as string[],
    /**
     * 认证材料份数。⚠️ 后端把学生证与作品集**合并**存成一个 `materials`
     * 数组（见 `provider.service.ts` 的 `apply`），分不清哪张是作品，
     * 所以界面只能说"认证材料 N 份"，把它写成"作品集 N 张"就是假数据。
     */
    materialCount: 0,
    creditScore: 0,
    completedOrders: 0,
    /** 装饰层视差位移（由 utils/fx.ts 写入） */
    fxStyle: '',
  },

  onLoad() {
    void this.load();
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

  /** 下拉刷新：重拉 profile 后必须 stop，否则顶部转圈不停 */
  async onPullDownRefresh() {
    try {
      await this.load();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  /** 数据加载：`GET /provider/profile` */
  async load() {
    try {
      const p = await providerApi.profile();
      const status = p.isProvider ? 'approved' : (p.verification?.status ?? 'none');
      this.setData(this.viewOf(status, p));
    } catch (e) {
      this.setData({ stage: 'error', error: (e as Error).message || '技能画像加载失败' });
    }
  },

  /**
   * profile → 视图数据。
   *
   * 单独抽一个方法是为了让"状态怎么映射成界面"这件事只有一处，
   * 而不是把五六个三元堆在 `load` 里（编译期不报错，改状态时必然漏改一个）。
   */
  viewOf(status: string, p: ProviderProfile) {
    const declared = p.verification?.skillTags ?? [];
    return {
      stage: (status === 'none' ? 'none' : 'profile') as Stage,
      error: '',
      status,
      badge: BADGE[status] ?? BADGE.none,
      actionText: ACTION[status] ?? ACTION.none,
      // 画像里有就用画像（审核通过时后端会写进 user_profile），否则用这次提交的材料
      skills: p.skills.length ? p.skills : declared,
      materialCount: p.verification?.materials.length ?? 0,
      creditScore: p.creditScore,
      completedOrders: p.completedOrders,
    };
  },

  onRetry() {
    this.setData({ stage: 'loading', error: '' });
    void this.load();
  },

  /** 主操作：审核中留在本页重拉状态，其余回认证流程（apply 页自己决定给什么表单） */
  async onAction() {
    if (this.data.status !== 'pending') {
      wx.navigateTo({ url: '/pkg-station/apply/index' });
      return;
    }
    this.setData({ stage: 'loading' });
    await this.load();
    wx.showToast({ title: '状态已刷新', icon: 'none' });
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
