/**
 * 服务者主页（M3-05）
 *
 * ## 数据源与它的边界
 *
 * 服务列表走**市场接口**：`GET /services?providerId=xxx`（后端本期新增的筛选，
 * 与大厅同一套规则 —— 只出这个人**已上架**的服务，下架的连链接都打不开）。
 *
 * ⚠️ "认证信息"这一屏**故意只有四件事**：昵称、信用分、完单数、评分。
 * 后端只有 `GET /provider/profile`，它看的是"**我自己**"（需登录），
 * 没有 `GET /providers/:id` 这类**他人主页**接口，所以学校 / 学院 / 作品集 / 技能画像
 * 这些真拿不到 —— 拿不到就不摆出来，也不用"暂无"占一排空位。
 * 这四项是从服务列表下发的服务者摘要里读的（真实字段，不是拼的）。
 *
 * ## 为什么没有"联系 TA"按钮
 *
 * 会话（M3-19）要 `taskId` 或 `orderId` 才建得起来，从主页直接发起会话的接口还没有。
 * 所以主操作是**去发布需求**：发布者发出需求后，服务者在工作台报名、发布者选定，
 * 这才是现在真能走完的那条路。
 *
 * 视觉：葡萄紫主题 · 圆角 28 · 双光斑 + 呼吸光点。
 */
import type { ServiceItem } from '../../utils/api';
import { serviceApi } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart, staggerClass } from '../../utils/fx';

/** 服务者摘要：从 TA 任意一条在架服务里取（同一个人，字段值一致） */
interface ProviderHead {
  nickname: string;
  creditText: string;
  completedText: string;
  /** 无评价时是"暂无评价"，**不兜 0 分** */
  ratingText: string;
}

/** TA 的一条服务（展示串在 TS 侧算好，金额「分」→「元」不在 WXML 里做除法） */
interface ProviderServiceRow {
  id: string;
  title: string;
  description: string;
  priceText: string;
  metaText: string;
  skillTags: string[];
  anim: string;
}

const AREA_LABEL: Record<string, string> = { school: '校内', city: '同城', remote: '远程' };

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

/** 一行服务的次要信息：分类 · 地区 · 交付，缺哪项就不拼哪项（不显示"undefined"） */
function metaText(item: ServiceItem): string {
  const area = AREA_LABEL[item.serviceArea ?? ''];
  return [
    item.categoryName,
    area,
    item.deliveryDays ? `${item.deliveryDays} 天交付` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function toRow(item: ServiceItem, index: number): ProviderServiceRow {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    priceText: priceText(item),
    metaText: metaText(item),
    skillTags: item.skillTags ?? [],
    anim: staggerClass(index),
  };
}

function toHead(item: ServiceItem): ProviderHead {
  return {
    nickname: item.provider.nickname || '同学',
    creditText: `信用分 ${item.provider.creditScore}`,
    completedText: `完成 ${item.provider.completedOrders} 单`,
    ratingText: ratingText(item.provider),
  };
}

/** 一条服务都没有时的说明：能公开的信息都来自服务本身，所以这时确实什么都没有 */
const EMPTY_NO_SERVICE =
  'TA 还没有把服务挂上来。这个页面能公开的信息都来自 TA 的服务，一条都没有时也就没有资料可展示。';
/** 深链没带编号时**不能**说成"TA 没有服务"——那是两件事 */
const EMPTY_NO_ID = '这次进入没带服务者编号。从服务详情页点服务者卡进来，这里会展示 TA 的在架服务。';

/**
 * `serviceApi.list` 的入参类型里**还没有** `providerId`
 * （`utils/api.ts` 由并行任务持有，本期不可改），而后端已经认这个查询参数。
 *
 * 所以这里过一次局部类型再传：断言只影响编译期，
 * `appendQuery` 会把对象上的每个键都拼进 query string，`providerId` 真的会发出去。
 * api.ts 补上这个字段后，本函数与这个断言一起删掉。
 */
function listParams(providerId: string): Parameters<typeof serviceApi.list>[0] {
  const query = { providerId, page: 1, pageSize: 50 };
  return query as Parameters<typeof serviceApi.list>[0];
}

Page({
  data: {
    providerId: '',
    loading: true,
    error: '',
    /** 一条服务都没有时不给"认证信息卡"—— 摘要本来就来自服务，没服务就没摘要 */
    head: null as ProviderHead | null,
    emptyTitle: '',
    emptyText: EMPTY_NO_SERVICE,
    services: [] as ProviderServiceRow[],
    total: 0,
    fxStyle: '',
  },

  onLoad(query: Record<string, string>) {
    this.setData({ providerId: query?.providerId ?? '' });
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

  onPullDownRefresh() {
    void this.load().finally(() => wx.stopPullDownRefresh());
  },

  /**
   * 拉 TA 的服务（`GET /services?providerId=`）。
   *
   * 上限一次拉 50（后端 `pageSize` 的硬上限，超了是 40001）：
   * 服务者主页不是列表页，50 条足够看完，不做分页器。
   */
  async load(): Promise<void> {
    const providerId = this.data.providerId;
    if (!providerId) {
      this.setData({
        loading: false,
        error: '',
        services: [],
        head: null,
        emptyTitle: '缺少服务者编号',
        emptyText: EMPTY_NO_ID,
      });
      return;
    }
    this.setData({ loading: true, error: '' });
    try {
      const res = await serviceApi.list(listParams(providerId));
      const list = res.list ?? [];
      this.setData({
        services: list.map(toRow),
        head: list.length ? toHead(list[0]) : null,
        total: res.total ?? list.length,
        emptyTitle: list.length ? '' : 'TA 还没有上架服务',
        emptyText: EMPTY_NO_SERVICE,
        loading: false,
      });
    } catch (e) {
      this.setData({
        services: [],
        head: null,
        total: 0,
        error: (e as Error).message || '加载失败，请稍后重试',
        loading: false,
      });
    }
  },

  onRetry() {
    void this.load();
  },

  onServiceTap(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pkg-station/service/index?id=${e.currentTarget.dataset.id}` });
  },

  /** 去发布需求：这才是现在真能走完的"找 TA 做"的路径（详见文件头） */
  onGoPublish() {
    wx.navigateTo({ url: '/pkg-station/publish/index' });
  },

  /** 服务市场在驿站 Tab 上，tabBar 页必须 switchTab */
  onGoMarket() {
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
