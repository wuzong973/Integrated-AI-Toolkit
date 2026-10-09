/**
 * 我上架的服务（服务者的"资产清单"）
 *
 * ## 这一页为什么必须存在
 *
 * 下架是**软删除**：`POST /services/:id/off` 之后，服务只是从市场里消失，
 * 数据还在。而后端 `GET /services/:id` 的语义是「**已下架只有本人打得开**」——
 * 它需要 token 才能识别"你是不是本人"。
 *
 * 此前 `serviceApi.detail` 写的是 `auth: false`（不发 token），
 * 于是连本人打开自己的下架服务都拿到 40401，页面如实显示「该服务已下架」；
 * 而能列出下架服务的 `serviceApi.mine()` 当时**全项目零调用**。
 * 两个缺口叠在一起 = **服务一被下架就再也找不回来**，界面上完全看不出是 bug
 * （看起来只是"这条确实没了"）。
 *
 * 所以本页是「找回来」的唯一入口：列出**含已下架**的全部服务，
 * 点进详情即可重新上架（`/services/:id/on`）。
 *
 * ## 数据源
 *
 * `GET /services/mine`（仅本人，含 draft / on / off），后端一次全给，
 * 筛选在本页做（数据量是"一个学生上架的服务"，个位数到几十条，
 * 再为它加一个筛选参数没有收益）。
 *
 * 视觉：葡萄紫主题（与"服务者主页/服务详情"同一套色板）· 圆角 28 + 光斑 + 扇贝波浪。
 */
import type { ServiceItem } from '../../utils/api';
import { serviceApi } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';

/** 筛选档：全部 / 已上架 / 已下架（草稿并入"已下架"一起管，都是"市场里看不到"） */
type Filter = 'all' | 'on' | 'off';

interface ServiceRow {
  id: string;
  title: string;
  /** 已算好的价格串（含单位），不在 WXML 里做算术 */
  priceText: string;
  statusText: string;
  /** 是否在架：决定徽标颜色，也是"重新上架"按钮的显隐依据 */
  onSale: boolean;
  categoryName: string;
  skillTags: string[];
  /** 「3 单成交 · 120 次浏览」 */
  metaText: string;
}

const STATUS_LABEL: Record<string, string> = { on: '已上架', off: '已下架', draft: '草稿' };

/** 分 → 「¥12.00」；拿不到金额显示「—」，不兜 0（金额永远是"分"整数，核心约束） */
function yuan(fen: number): string {
  return Number.isFinite(fen) ? `¥${(fen / 100).toFixed(2)}` : '—';
}

function priceText(item: ServiceItem): string {
  if (item.priceUnit === 'negotiable') return '价格面议';
  const base = yuan(item.price);
  return item.priceUnit === 'hourly' ? `${base}/小时` : base;
}

function toRow(item: ServiceItem): ServiceRow {
  return {
    id: item.id,
    title: item.title,
    priceText: priceText(item),
    statusText: STATUS_LABEL[item.status] ?? item.status,
    onSale: item.status === 'on',
    categoryName: item.categoryName ?? '',
    skillTags: item.skillTags ?? [],
    metaText: `${item.orderCount} 单成交 · ${item.viewCount} 次浏览`,
  };
}

Page({
  /**
   * 全量行（不放进 data）。
   *
   * 筛选与渲染需要的不是同一份数据：`data.list` 只放**当前档位可见**的行
   * （WXML 只认它），全量留在实例上供切换档位时重新切片 ——
   * 这样切 tab 不需要重新请求，也不会出现"data 里同时有两份列表"的歧义。
   */
  allRows: [] as ServiceRow[],

  data: {
    loading: true,
    /** 拉取失败的如实提示（与"没有服务"是两件事，不能混成空态） */
    error: '',
    filter: 'all' as Filter,
    /** 当前档位可见的行 */
    list: [] as ServiceRow[],
    empty: false,
    /** 空态文案：区分"一条都没有"与"这个档位下没有" */
    emptyHint: '',
    counts: { all: 0, on: 0, off: 0 },
    fxStyle: '',
  },

  onShow() {
    fxEnableTilt(this);
    // 从详情页上架/下架返回时要看到最新状态，放 onShow 而不是 onLoad
    void this.load();
  },

  onHide() {
    fxDisableTilt();
  },

  onUnload() {
    fxDisableTilt();
  },

  async onPullDownRefresh() {
    try {
      await this.load();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  async load(): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const res = await serviceApi.mine();
      const rows = (res.list ?? []).map(toRow);
      const on = rows.filter((r) => r.onSale).length;
      this.allRows = rows;
      this.setData({
        counts: { all: rows.length, on, off: rows.length - on },
        loading: false,
      });
      this.applyFilter(this.data.filter);
    } catch (e) {
      this.allRows = [];
      this.setData({
        list: [],
        empty: false,
        counts: { all: 0, on: 0, off: 0 },
        loading: false,
        // 失败走 error 分支并给"重试"，不用空态掩盖错误
        error: (e as Error).message || '服务列表加载失败',
      });
    }
  },

  /**
   * 按档位切出可见行。
   *
   * 「已下架」档同时收 `off` 与 `draft` —— 它们对用户是同一种状态：
   * 市场里看不到它，需要我去处理。拆成两个 tab 只会多一次点击。
   */
  applyFilter(filter: Filter): void {
    const rows = this.allRows;
    const visible =
      filter === 'all' ? rows : rows.filter((r) => (filter === 'on' ? r.onSale : !r.onSale));
    this.setData({
      filter,
      list: visible,
      empty: visible.length === 0,
      emptyHint: rows.length === 0 ? '上架一项服务，让同学能找到你' : '这个档位下暂时没有服务',
    });
  },

  onFilter(e: WechatMiniprogram.TouchEvent) {
    const filter = e.currentTarget.dataset.filter as Filter;
    if (filter === this.data.filter) return;
    this.applyFilter(filter);
  },

  onRetry() {
    void this.load();
  },

  /** 进详情：那里是上架 / 下架的实操位置（本人视角底部变成"管理"） */
  onOpen(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    if (!id) return;
    wx.navigateTo({ url: `/pkg-station/service/index?id=${id}` });
  },

  /** 新上架一项服务 */
  onNew() {
    wx.navigateTo({ url: '/pkg-station/service-new/index' });
  },

  /** 工作台（接单与收入在那边） */
  onGoWorkbench() {
    wx.navigateTo({ url: '/pkg-station/workbench/index' });
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
