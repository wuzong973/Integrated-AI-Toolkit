/**
 * 我的订单（我买到的 / 我卖出的）
 *
 * 后端 `GET /orders`（OrderModule，M3-11）已就绪，本页直连接口渲染。
 * 视觉：装饰层随指针视差（utils/fx.ts），内容区不跟随。
 */
import type { OrderItem } from '../../utils/api';
import { orderApi } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { orderStatusText } from '../../utils/order-status';

/** 列表行 = 接口字段 + 展示用派生字段 */
type OrderRow = OrderItem & {
  statusText: string;
  amountYuan: string;
  /** 对方称呼：买家视角看服务者，服务者视角看买家 */
  partyLabel: string;
};

Page({
  data: {
    loading: true,
    error: '',
    role: 'buyer' as 'buyer' | 'provider',
    list: [] as OrderRow[],
    empty: false,
    /** 装饰层视差位移（由 utils/fx.ts 写入） */
    fxStyle: '',
  },

  onLoad(query: Record<string, string>) {
    this.setData({ role: query.role === 'provider' ? 'provider' : 'buyer' });
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

  /** 下拉刷新：重拉后必须 stop，否则顶部转圈不停 */
  async onPullDownRefresh() {
    try {
      await this.load();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  /**
   * 拉取订单列表。
   *
   * 以前这里**刻意不发请求**（订单模块后端不存在，`GET /orders` 实测 404）。
   * 现在后端已注册，改为真实调用 —— 失败时走 error 分支并给"重试"，
   * 不再用空态掩盖错误。
   */
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const res = await orderApi.list({ role: this.data.role });
      const list = res.list.map((o) => toRow(o, this.data.role));
      this.setData({ list, empty: list.length === 0, loading: false });
    } catch (e) {
      this.setData({ loading: false, error: (e as Error).message || '订单加载失败' });
    }
  },

  onRetry() {
    void this.load();
  },

  /** 切换视角（我买到的 / 我卖出的） */
  onSwitchRole(e: WechatMiniprogram.TouchEvent) {
    const role = (e.currentTarget.dataset.role as 'buyer' | 'provider') ?? 'buyer';
    if (role === this.data.role) return;
    this.setData({ role });
    void this.load();
  },

  /** 打开订单详情（详情页按 role 决定显示哪些操作按钮） */
  onOpen(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/pkg-station/order-detail/index?id=${id}&role=${this.data.role}` });
  },

  /**
   * 空态引导：去任务大厅。
   *
   * ⚠️ 任务大厅是 **tabBar 页**，必须用 `wx.switchTab` ——
   * `wx.navigateTo` 跳 tabBar 页会**静默失败**（不报错也不跳转）。
   * 这条规则由 `npm run audit:mp` 静态守卫。
   */
  onGoHall() {
    wx.switchTab({ url: '/pages/station/index' });
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

/** 接口条目 → 列表行 */
function toRow(o: OrderItem, role: 'buyer' | 'provider'): OrderRow {
  const counterpart = role === 'provider' ? o.buyer : o.provider;
  const who = role === 'provider' ? '买家' : '服务者';
  return {
    ...o,
    statusText: orderStatusText(o.status),
    amountYuan: (o.amount / 100).toFixed(2),
    partyLabel: counterpart?.nickname ? `${who}：${counterpart.nickname}` : '',
  };
}
