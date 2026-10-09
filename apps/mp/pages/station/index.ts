/**
 * 青智驿站（文档 5.3.7）
 * 两个 Tab：任务大厅 / 服务市场（M3-05）；共用一套分类筛选 + 关键词搜索。
 *
 * 视觉升级：分类带糖果图标、任务卡左侧彩条、装饰层随指针视差。
 *
 * ## 服务市场 Tab 的两个纪律
 *
 * ① **筛选必须两侧同时生效**：分类胶囊与搜索框是共用的，切 Tab、点分类、按搜索
 *    都走 `reload()` 重新拉当前 Tab —— 只换数据不重拉的写法，会让用户点了「摄影」
 *    却看到全量列表，而界面看上去完全正常。
 * ② **"上架服务"入口只给能上架的人**：`POST /services` 仅认证服务者可用（40312），
 *    所以入口按 `isProvider` 显示。判断优先读 App 的用户态，拿不到再问
 *    `GET /provider/profile`；**拉不到就按"不可见"处理** ——
 *    给一个点了必然被拒的按钮比少一个入口更糟。
 */
import type { ServiceItem, TaskItem } from '../../utils/api';
import { providerApi, serviceApi, stationApi } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart, staggerClass } from '../../utils/fx';

/**
 * 分类**兜底表**（文档 5.3.7 分类横滑；icon 为糖果图标类名）
 *
 * ⚠️ 运行时优先用 `GET /station/categories`（`loadCategories()`）的真实数据，
 * 这份常量只在**接口拉不到时**兜底。之所以还留着它：
 *
 * ① 分类横滑是首屏的第一交互，接口抖动不该让筛选栏空掉；
 * ② `check:categories` 守卫靠读这份字面量与 `seed.ts` 的 `SERVICE_CATEGORIES`
 *    做对齐断言 —— 它校验的是"两端枚举不许漂移"，删掉它等于把守卫的眼蒙上。
 *
 * 两者不冲突：远端为准、本表兜底，而本表由守卫保证与后端一致。
 */
const CATEGORIES = [
  { id: '', name: '全部', icon: 'qz-i-star' },
  { id: 'photo', name: '摄影摄像', icon: 'qz-i-photo' },
  { id: 'design', name: 'PPT设计', icon: 'qz-i-design' },
  { id: 'copy', name: '文案', icon: 'qz-i-copy' },
  { id: 'code', name: '编程', icon: 'qz-i-code' },
  { id: 'tutor', name: '家教', icon: 'qz-i-tutor' },
  { id: 'host', name: '主持', icon: 'qz-i-host' },
  { id: 'video', name: '剪辑', icon: 'qz-i-clip' },
  { id: 'rent', name: '跑腿', icon: 'qz-i-errand' },
  { id: 'other', name: '其他', icon: 'qz-i-other' },
];

/**
 * id → 糖果图标类名。
 *
 * 后端 `GET /station/categories` 的 `icon` 字段是 **emoji**（`📷`/`🎨`…，
 * 给 H5 与后台用的），小程序统一走糖果图标库，所以这里按 id 映射，
 * 不把 emoji 塞进 `.qz-i` 底座里 —— 那会让同一排胶囊里出现两种图标风格。
 * 表外的 id 落到 `qz-i-other`：**能点、能筛**，只是图标通用。
 */
const CATEGORY_ICON: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.id, c.icon]),
);


/** 服务地区：后端下发的是枚举码，界面说人话；表外的码显示为空（不编一个说法） */
const AREA_LABEL: Record<string, string> = { school: '校内', city: '同城', remote: '远程' };

/** 空态文案：全站一条服务都没有 vs 这次筛选没命中，是两种不同的下一步 */
const SERVICE_EMPTY_FIRST =
  '同学们还没有把自己会做的事挂上来。你可以先去任务大厅发一条需求，' +
  '或者完成服务者认证后成为第一个上架的人。';
const SERVICE_EMPTY_FILTERED = '这个分类或关键词下暂时没有服务，换个条件试试。新上架的服务会第一时间出现在这里。';

/**
 * 服务卡（**展示串在 TS 侧算好**）。
 *
 * 为什么不在 WXML 里换算：`¥{{item.price / 100}}` 会让 19900 显示成 `¥199`、
 * 19950 显示成 `¥199.5`、19999 显示成 `¥199.99` —— 三种宽度混在一屏里，
 * 用户分不清"199.5"是缺了角分还是就这个价。金额是"分"整数（红线 4），
 * 展示成什么样必须由代码唯一裁定（`yuan()` 固定两位小数）。
 */
interface ServiceCard {
  id: string;
  title: string;
  description: string;
  /** 已带 ¥ 与计价后缀（"¥199.00/小时" / "价格面议"） */
  priceText: string;
  categoryName: string;
  areaText: string;
  deliveryText: string;
  skillTags: string[];
  providerId: string;
  providerName: string;
  /** 评分文案。**无评价时是"暂无评价"**，不兜 0 分（0 分读起来像差评） */
  ratingText: string;
  /** 逐项延迟入场类名 */
  anim: string;
}

/** 分 → 带 ¥ 的元字符串（两位小数，固定长度才不会忽长忽短；拿不到金额显示 "—"，不兜 0） */
function yuan(fen: number): string {
  return Number.isFinite(fen) ? `¥${(fen / 100).toFixed(2)}` : '—';
}

/** 价格文案：面议不显示数字，按小时带后缀 */
function priceText(item: ServiceItem): string {
  if (item.priceUnit === 'negotiable') return '价格面议';
  return item.priceUnit === 'hourly' ? `${yuan(item.price)}/小时` : yuan(item.price);
}

/** 评分文案：`rating` 为 null（后端在无评价时下发 null，不是 0）表示"没人评过"，与"打了零分"是两件事 */
function ratingText(p: ServiceItem['provider']): string {
  if (typeof p.rating !== 'number') return '暂无评价';
  return `${p.rating.toFixed(1)} 分 · ${p.ratingCount} 条评价`;
}

function toServiceCard(item: ServiceItem, index: number): ServiceCard {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    priceText: priceText(item),
    categoryName: item.categoryName ?? '',
    areaText: AREA_LABEL[item.serviceArea ?? ''] ?? '',
    deliveryText: item.deliveryDays ? `交付 ${item.deliveryDays} 天` : '',
    skillTags: item.skillTags ?? [],
    providerId: item.provider.id,
    providerName: item.provider.nickname || '同学',
    ratingText: ratingText(item.provider),
    anim: staggerClass(index),
  };
}

/** App 里那份用户态（`globalData.user` 是 `Record<string, unknown>`，这里只取两个字段） */
interface CachedUser {
  isProvider?: boolean;
}

Page({
  data: {
    tab: 'task' as 'task' | 'service',
    categories: CATEGORIES,
    activeCategory: '',
    keyword: '',
    tasks: [] as TaskItem[],
    total: 0,
    /** 列表里是否含示例数据（服务端下发的 isDemo）→ 决定是否显示"演示数据"提示 */
    hasDemoTasks: false,
    loading: true,
    error: '',

    /** 服务市场（M3-05） */
    services: [] as ServiceCard[],
    serviceTotal: 0,
    serviceLoading: false,
    serviceError: '',
    /** 空态说明：带筛选与不带筛选是两句话，别让用户以为搜索没生效 */
    serviceEmptyText: '',
    /** 认证服务者才看得到"上架服务"入口 */
    isProvider: false,

    fxStyle: '',
  },

  onLoad(query: Record<string, string>) {
    if (query.tab === 'service' || query.tab === 'task') {
      this.setData({ tab: query.tab });
    }
    void this.reload();
    void this.loadCategories();
    void this.loadProviderState();
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

  /** 当前 Tab 重新拉一次（分类 / 关键词 / 切 Tab / 下拉刷新都走这里） */
  reload(): Promise<void> {
    return this.data.tab === 'service' ? this.loadServices() : this.loadTasks();
  },

  /**
   * 分类横滑：优先用后端真实分类。
   *
   * ## 为什么不能一直写死
   *
   * 后端新增一个分类（例如「翻译」）时，写死的列表**不会报错**，
   * 只是用户永远选不到它 —— 那个分类下的任务会一直"看起来还没人发布"。
   * `check:categories` 守卫能拦下这种漂移，但它只在交付前跑；
   * 真正的修法是**运行时以后端为准**。
   *
   * 失败时**静默回落到 `CATEGORIES`**：分类栏是首屏第一交互，
   * 因为它拉不到就整条空掉（或者弹一个错误条），比用兜底表更糟。
   * 兜底表由守卫保证与后端一致，所以回落不是"猜"。
   *
   * 当前选中的分类若不在新列表里（后端删掉了它），退回「全部」——
   * 否则筛选栏会处于"没有任何胶囊高亮"的状态，看起来像卡死了。
   */
  async loadCategories() {
    try {
      const rows = await stationApi.categories();
      // 空数组同样视为无效数据：宁可回落到兜底表，也不要一条胶囊都没有
      if (!Array.isArray(rows) || rows.length === 0) return;
      const list = [
        { id: '', name: '全部', icon: 'qz-i-star' },
        ...rows.map((r) => ({
          id: r.id,
          name: r.name,
          icon: CATEGORY_ICON[r.id] ?? 'qz-i-other',
        })),
      ];
      const stillValid = list.some((c) => c.id === this.data.activeCategory);
      this.setData({ categories: list });
      if (!stillValid) {
        this.setData({ activeCategory: '' });
        void this.reload();
      }
    } catch {
      // 兜底表已在 data.categories 里，这里不需要任何动作
    }
  },

  async loadTasks() {
    this.setData({ loading: true });
    try {
      const res = await stationApi.tasks({
        categoryId: this.data.activeCategory || undefined,
        keyword: this.data.keyword || undefined,
        status: 'published',
      });
      const tasks = res.list ?? [];
      /**
       * 红线 10：只要列表里**混有**示例数据，整块列表就要挂"演示数据"提示。
       *
       * 为什么按"整块"而不是"逐条角标"：seed 的 4 条任务占满了首屏，
       * 逐条挂角标在窄屏上会挤掉标题；而用户真正需要知道的是
       * "这个大厅现在展示的不是真实数据"，一句话说清比四个角标更有效。
       */
      this.setData({
        tasks,
        total: res.total ?? 0,
        hasDemoTasks: tasks.some((t) => t.isDemo),
        error: '',
        loading: false,
      });
    } catch (e) {
      this.setData({
        tasks: [],
        total: 0,
        hasDemoTasks: false,
        error: (e as Error).message || '加载失败',
        loading: false,
      });
    }
  },

  /**
   * 服务市场列表（`GET /services`，公开接口，服务端只出已上架）。
   *
   * 首期库里没有任何服务商品（`seed.ts` 不写 service 表），所以**空态才是这一屏的
   * 常态**：文案说"还没有服务上架"，不说"功能开发中"，也不摆一屏演示卡冒充有货。
   */
  async loadServices() {
    this.setData({ serviceLoading: true, serviceError: '' });
    const categoryId = this.data.activeCategory || undefined;
    const keyword = this.data.keyword || undefined;
    try {
      const res = await serviceApi.list({ categoryId, keyword, page: 1, pageSize: 20 });
      const list = res.list ?? [];
      this.setData({
        services: list.map(toServiceCard),
        serviceTotal: res.total ?? 0,
        serviceEmptyText: categoryId || keyword ? SERVICE_EMPTY_FILTERED : SERVICE_EMPTY_FIRST,
        serviceError: '',
        serviceLoading: false,
      });
    } catch (e) {
      this.setData({
        services: [],
        serviceTotal: 0,
        serviceError: (e as Error).message || '服务列表加载失败',
        serviceLoading: false,
      });
    }
  },

  /**
   * 是否认证服务者。
   *
   * 先读 App 缓存的用户态（登录时 `/auth/me` 已带 `isProvider`），
   * 没登录或字段缺失时才打 `GET /provider/profile`；两条路都失败就保持"不显示入口"。
   */
  async loadProviderState() {
    const g = getApp<IAppOption>();
    const cached = (g.globalData.user ?? null) as CachedUser | null;
    if (g.globalData.isLoggedIn && typeof cached?.isProvider === 'boolean') {
      this.setData({ isProvider: cached.isProvider });
      return;
    }
    if (!g.globalData.isLoggedIn) return;
    try {
      const profile = await providerApi.profile();
      this.setData({ isProvider: profile.isProvider });
    } catch {
      // 拉不到就按"不可见"处理：宁少一个入口，不给一个点了必被拒的按钮
    }
  },

  onRetry() {
    void this.reload();
  },

  onTabTap(e: WechatMiniprogram.TouchEvent) {
    this.applyTab(e.currentTarget.dataset.tab as 'task' | 'service');
  },

  /**
   * 切 Tab。
   *
   * 两个 Tab 各有各的加载态与错误态，切过去**必须各自重拉**；
   * 只换 `tab` 不换数据的话，用户看到的是"上一屏的列表换了个标题"。
   */
  applyTab(tab: 'task' | 'service') {
    if (tab === this.data.tab) return;
    this.setData({ tab, error: '', serviceError: '' });
    void this.reload();
  },

  onCategoryTap(e: WechatMiniprogram.TouchEvent) {
    this.setData({ activeCategory: e.currentTarget.dataset.id as string });
    void this.reload();
  },

  onKeywordInput(e: WechatMiniprogram.Input) {
    this.setData({ keyword: e.detail.value });
  },

  onSearch() {
    void this.reload();
  },

  onTaskTap(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pkg-station/task/index?id=${e.currentTarget.dataset.id}` });
  },

  /** 服务详情（M3-05）：只带 id，详情接口自己判"下架了对谁可见" */
  onServiceTap(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pkg-station/service/index?id=${e.currentTarget.dataset.id}` });
  },

  /** 发布需求（AI 极速发布入口） */
  onPublish() {
    wx.navigateTo({ url: '/pkg-station/publish/index' });
  },

  /** 上架服务（M3-05）：仅认证服务者可见，见 `loadProviderState` */
  onCreateService() {
    wx.navigateTo({ url: '/pkg-station/service-new/index' });
  },

  /**
   * 服务市场空态的次按钮：去做服务者认证（M3-02）。
   * 分包页、非 tabBar，可以直接 navigateTo。
   */
  onGoApply() {
    wx.navigateTo({ url: '/pkg-station/apply/index' });
  },

  /** 空态主按钮：切到任务大厅（同一页面内切 Tab，不需要 switchTab） */
  onGoTaskHall() {
    this.applyTab('task');
  },

  onPullDownRefresh() {
    void this.reload().finally(() => wx.stopPullDownRefresh());
  },
});
