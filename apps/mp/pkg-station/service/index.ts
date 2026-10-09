/**
 * 服务详情（M3-04 契约 + M3-05 页面）
 *
 * ## 数据源
 *
 * `GET /services/:id`（公开）。服务端已经判过"下架的商品只有本人打得开"，
 * 所以这一页**不需要**自己再拼一次权限逻辑：非本人拿到 40401 时如实显示
 * "该服务已下架"，而不是兜成详情或报错。
 *
 * ## 为什么没有"下单"按钮
 *
 * 后端没有直接下单接口（`POST /orders` 要的是 `taskId`，服务商品没有对应任务）。
 * 与其摆一颗点了必然失败的"立即下单"（红线 10 的另一种形态），
 * 不如把用户真正能走完的那条路摆出来：**去发布需求**（带上服务标题），
 * 由发布者选服务者或走报名流程。
 *
 * ## 本人视角多出的是"管理"，不是"下单"
 *
 * 自己的服务可以下架 / 重新上架（`POST /services/:id/off`、`/on`）。
 * 已下架的服务只有本人打得开，所以这一屏也是找回它的唯一入口。
 *
 * 视觉：葡萄紫主题 · 大圆角 + 光斑 + 扇贝波浪。
 */
import type { ServiceItem } from '../../utils/api';
import { serviceApi } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { toastError } from '../../utils/request';

/** 页面阶段：详情 / 看不了（下架或不存在）/ 加载失败 / 加载中 */
type Stage = 'loading' | 'ready' | 'gone' | 'error';

const AREA_LABEL: Record<string, string> = { school: '校内', city: '同城', remote: '远程' };
const PRICE_UNIT_LABEL: Record<string, string> = {
  fixed: '一口价',
  hourly: '按小时计价',
  negotiable: '价格面议',
};
const STATUS_LABEL: Record<string, string> = { on: '已上架', off: '已下架', draft: '草稿' };

/** 详情视图模型：枚举码 → 人话，金额「分」→「元」都在 TS 侧算完 */
interface ServiceView {
  id: string;
  title: string;
  description: string;
  priceText: string;
  priceUnitText: string;
  areaText: string;
  deliveryText: string;
  skillTags: string[];
  status: string;
  statusText: string;
  categoryName: string;
  orderCount: number;
  viewCount: number;
  providerId: string;
  providerName: string;
  /** 头像 URL。后端只在有值时下发（无头像时这里空串，用糖果图标底座） */
  providerAvatar: string;
  /** 评分文案。无评价时是"暂无评价"，**不兜 0 分**（后端这时下发 null） */
  ratingText: string;
  creditText: string;
  completedText: string;
}

/** 分 → 带 ¥ 的元（两位小数）；拿不到金额显示"—"，不兜 0 */
function yuan(fen: number): string {
  return Number.isFinite(fen) ? `¥${(fen / 100).toFixed(2)}` : '—';
}

function priceText(item: ServiceItem): string {
  if (item.priceUnit === 'negotiable') return '价格面议';
  return item.priceUnit === 'hourly' ? `${yuan(item.price)}/小时` : yuan(item.price);
}

function ratingText(p: ServiceItem['provider']): string {
  if (typeof p.rating !== 'number') return '暂无评价';
  return `${p.rating.toFixed(1)} 分（${p.ratingCount} 条评价）`;
}

function toView(item: ServiceItem): ServiceView {
  const area = AREA_LABEL[item.serviceArea ?? ''];
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    priceText: priceText(item),
    priceUnitText: PRICE_UNIT_LABEL[item.priceUnit] ?? '按约定计价',
    areaText: area ?? '地区不限',
    deliveryText: item.deliveryDays ? `${item.deliveryDays} 天内交付` : '交付时间可协商',
    skillTags: item.skillTags ?? [],
    status: item.status,
    statusText: STATUS_LABEL[item.status] ?? item.status,
    categoryName: item.categoryName ?? '',
    orderCount: item.orderCount,
    viewCount: item.viewCount,
    providerId: item.provider.id,
    providerName: item.provider.nickname || '同学',
    providerAvatar: item.provider.avatar ?? '',
    ratingText: ratingText(item.provider),
    creditText: `信用分 ${item.provider.creditScore}`,
    completedText: `完成 ${item.provider.completedOrders} 单`,
  };
}

/** 40401 分两种：下架（有直接链接也打不开）与压根不存在 —— 文案要说是哪种 */
function goneTitle(message: string): string {
  return message.includes('下架') ? '该服务已下架' : '服务不存在';
}

Page({
  data: {
    stage: 'loading' as Stage,
    serviceId: '',
    error: '',
    /** 看不了时的标题 */
    goneText: '',
    item: null as ServiceView | null,
    /** 是否本人查看自己的服务：决定底部是"管理"还是"去发布需求" */
    isMine: false,
    acting: false,
    fxStyle: '',
  },

  onLoad(query: Record<string, string>) {
    // `id` 是本页的规范入参；`serviceId` 兼容旧占位页留下的链接
    this.setData({ serviceId: query?.id || query?.serviceId || '' });
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

  /** 下拉刷新：状态变更（下架/重新上架）后也能靠它复位 */
  onPullDownRefresh() {
    void this.load().finally(() => wx.stopPullDownRefresh());
  },

  /** 拉详情。`gone` 与 `error` 是两件事：前者是"这条不该被看到"，后者是"这次没拉到" */
  async load(): Promise<void> {
    const id = this.data.serviceId;
    if (!id) {
      this.setData({ stage: 'gone', goneText: '缺少服务编号', isMine: false, item: null });
      return;
    }
    this.setData({ stage: 'loading', error: '' });
    try {
      const detail = await serviceApi.detail(id);
      this.setData({
        stage: 'ready',
        item: toView(detail),
        isMine: this.isOwnerOf(detail.provider.id),
        goneText: '',
      });
    } catch (e) {
      const err = e as { code?: number; message?: string };
      if (err.code === 40401) {
        this.setData({ stage: 'gone', goneText: goneTitle(err.message ?? ''), item: null });
        return;
      }
      this.setData({ stage: 'error', error: err.message || '加载失败，请稍后重试' });
    }
  },

  /** 登录者 id 与服务者 id 比对。未登录一律 false（不猜） */
  isOwnerOf(providerId: string): boolean {
    const g = getApp<IAppOption>();
    if (!g.globalData.isLoggedIn) return false;
    const me = g.globalData.user as { id?: string } | null;
    return !!me?.id && me.id === providerId;
  },

  onRetry() {
    void this.load();
  },

  /** 服务者主页：昵称行与整张服务者卡都可点 */
  onProviderTap() {
    const item = this.data.item;
    if (!item?.providerId) return;
    wx.navigateTo({ url: `/pkg-station/provider/index?providerId=${item.providerId}` });
  },

  /**
   * 去发布需求（本页的"下单"替身）。
   *
   * 带标题是为了让用户少打一遍字，**不**假装已经下了单：
   * publish 页读 `query.title` 预填，用户仍可改后提交。
   */
  onGoPublish() {
    const raw = this.data.item?.title ?? '';
    // 标题截一下：太长会把发布页的输入框撑满，用户还得自己删
    const short = raw.length > 28 ? `${raw.slice(0, 28)}…` : raw;
    const title = short ? encodeURIComponent(`想找「${short}」`) : '';
    // 参数一律带在 `?` 之后：`audit:mp` 按 `?` 前的路径核对页面是否已注册
    wx.navigateTo({ url: `/pkg-station/publish/index?title=${title}` });
  },

  /** 任务大厅是 tabBar 页，必须 switchTab（navigateTo 会静默失败） */
  onGoHall() {
    wx.switchTab({ url: '/pages/station/index' });
  },

  /** 重新上架：`POST /services/:id/on`，成功后重拉详情（状态徽标要跟着变） */
  async onRelist() {
    const item = this.data.item;
    if (!item || this.data.acting) return;
    this.setData({ acting: true });
    try {
      await serviceApi.on(item.id);
      wx.showToast({ title: '已重新上架', icon: 'success' });
      await this.load();
    } catch (e) {
      toastError(e);
    } finally {
      this.setData({ acting: false });
    }
  },

  /** 下架：二次确认后 `POST /services/:id/off`。下架后市场里就没有它了 */
  async onOffline() {
    const item = this.data.item;
    if (!item || this.data.acting) return;
    const res = await wx
      .showModal({
        title: '下架这个服务？',
        content: '下架后服务市场不再展示它，别人打开链接会看到「该服务已下架」。',
        confirmText: '下架',
      })
      .catch(() => null);
    if (!res?.confirm) return;

    this.setData({ acting: true });
    try {
      await serviceApi.off(item.id);
      wx.showToast({ title: '已下架', icon: 'success' });
      await this.load();
    } catch (e) {
      toastError(e);
    } finally {
      this.setData({ acting: false });
    }
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
