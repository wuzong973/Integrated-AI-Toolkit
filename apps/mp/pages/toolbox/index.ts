/**
 * AI 工具箱（文档 5.3.4）
 * 左侧分类固定 + 右侧工具列表；支持搜索与一句话直达 OS
 *
 * 视觉升级：分类/工具都带糖果图标，工具卡顶部是流动的渐变线（.qz-topline），
 * 装饰层随指针视差（双流线 + 光点），换分类后整批重播入场。
 */
import type { ToolCategoryItem, ToolItem } from '../../utils/api';
import { toolboxApi } from '../../utils/api';
import { isBillingFree, loadBillingMode, priceText } from '../../utils/billing';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart, replayAnim } from '../../utils/fx';
import { openOs } from '../../utils/nav';

/** 分类兜底（接口未就绪时仍可用，保证页面不空） */
const FALLBACK_CATEGORIES: ToolCategoryItem[] = [
  { id: 'ai_office', name: 'AI办公', scene: 'ai_office' },
  { id: 'image', name: '图片工具', scene: 'image' },
  { id: 'video', name: '视频工具', scene: 'video' },
  { id: 'audio', name: '音频工具', scene: 'audio' },
  { id: 'pdf', name: 'PDF', scene: 'pdf' },
  { id: 'file', name: '文件处理', scene: 'file' },
  { id: 'ai_learn', name: 'AI学习', scene: 'ai_learn' },
];

/** 分类 → 糖果图标（新增分类必须在此登记，避免出现无图标项） */
const CATEGORY_ICONS: Record<string, string> = {
  ai_office: 'qz-i-office',
  image: 'qz-i-image',
  video: 'qz-i-video',
  audio: 'qz-i-audio',
  pdf: 'qz-i-pdf',
  file: 'qz-i-file',
  ai_learn: 'qz-i-learn',
};

type CatRow = ToolCategoryItem & { count: number; icon: string };
type ToolRow = ToolItem & { iconClass: string; priceLabel: string; free: boolean };

/**
 * 本地小工具（纯前端计算：无网络请求、不建作业、不消耗额度），
 * 与上面的"校园小工具"入口、下面的服务端工具列表都互相独立。
 * ⚠️ url 必须整条写死成字面量 —— 分包注册检查要能在源码里找到完整路径。
 */
const LOCAL_TOOLS: Array<{ name: string; label: string; icon: string; url: string }> = [
  { name: 'timestamp', label: '时间戳', icon: 'qz-i-clock', url: '/pkg-toolbox/timestamp/index' },
  { name: 'base64', label: 'Base64', icon: 'qz-i-code', url: '/pkg-toolbox/base64/index' },
  { name: 'password', label: '密码生成', icon: 'qz-i-lock', url: '/pkg-toolbox/password/index' },
  { name: 'json', label: 'JSON 格式化', icon: 'qz-i-office', url: '/pkg-toolbox/json/index' },
  { name: 'diff', label: '文本对比', icon: 'qz-i-files', url: '/pkg-toolbox/diff/index' },
  { name: 'unit', label: '单位换算', icon: 'qz-i-chart', url: '/pkg-toolbox/unit/index' },
  { name: 'datecalc', label: '日期计算', icon: 'qz-i-calendar', url: '/pkg-toolbox/datecalc/index' },
];

function catIcon(id: string): string {
  return CATEGORY_ICONS[id] ?? 'qz-i-doc';
}

Page({
  data: {
    categories: [] as CatRow[],
    activeCategory: 'ai_office',
    allTools: [] as ToolRow[],
    tools: [] as ToolRow[],
    keyword: '',
    /** 是否免费开放（价格角标改为"限时免费"） */
    billingFree: false,
    loading: true,
    error: '',
    fxStyle: '',
    /** 入场动画开关：换分类时先关再开，让工具列表整批重播上浮（见 replayAnim） */
    animOn: true,
    /** 本地小工具入口卡（写死在前端，不走接口） */
    localTools: LOCAL_TOOLS,
  },

  onLoad() {
    void this.bootstrap();
  },

  onShow() {
    fxEnableTilt(this);
    // 从执行页返回时刷新使用次数
    if (this.data.allTools.length) void this.loadTools();
  },

  onHide() {
    fxDisableTilt();
  },

  onUnload() {
    fxDisableTilt();
  },

  async bootstrap() {
    await Promise.allSettled([this.loadCategories(), this.loadTools()]);
    this.setData({ loading: false });
  },

  async loadCategories() {
    let cats: ToolCategoryItem[] = [];
    try {
      cats = await toolboxApi.categories();
    } catch {
      cats = FALLBACK_CATEGORIES;
    }
    if (!cats.length) cats = FALLBACK_CATEGORIES;

    // 统计各分类工具数（右侧显示 (n)）
    const counts: Record<string, number> = {};
    for (const t of this.data.allTools) counts[t.categoryId] = (counts[t.categoryId] ?? 0) + 1;

    const categories: CatRow[] = cats.map((c) => ({
      ...c,
      count: counts[c.id] ?? 0,
      icon: catIcon(c.id),
    }));
    this.setData({
      categories,
      activeCategory: this.data.activeCategory || categories[0]?.id || 'ai_office',
    });
    this.applyFilter();
  },

  async loadTools() {
    try {
      // 价格文案依赖计费模式，先取一次（已缓存则不发请求）
      await loadBillingMode();
      const tools = await toolboxApi.list();
      const rows: ToolRow[] = tools.map((t) => ({
        ...t,
        iconClass: catIcon(t.categoryId),
        priceLabel: priceText(t.price),
        free: isBillingFree(),
      }));
      this.setData({ allTools: rows, billingFree: isBillingFree(), error: '' });
      await this.loadCategories();
    } catch (e) {
      this.setData({
        allTools: [],
        tools: [],
        error: (e as Error).message || '工具列表加载失败',
      });
    }
  },

  /** 按分类 + 关键词过滤 */
  applyFilter() {
    const { allTools, activeCategory, keyword } = this.data;
    const kw = keyword.trim().toLowerCase();

    let list = allTools;
    if (!kw) {
      list = list.filter((t) => t.categoryId === activeCategory);
    } else {
      // 有关键词时跨分类搜索（文档 5.3.4）
      list = list.filter(
        (t) =>
          t.displayName.toLowerCase().includes(kw) ||
          t.description.toLowerCase().includes(kw) ||
          t.name.toLowerCase().includes(kw),
      );
    }
    this.setData({ tools: list });
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

  onRetry() {
    void this.bootstrap();
  },

  onCategoryTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    this.setData({ activeCategory: id, keyword: '' });
    this.applyFilter();
    // 换分类等于整批换内容：重播入场上浮，让"列表真的换了"一眼可见
    // （关键词过滤刻意不重播——每敲一个字就闪一次比没有动效更糟）
    replayAnim(this);
  },

  onKeywordInput(e: WechatMiniprogram.Input) {
    this.setData({ keyword: e.detail.value });
    this.applyFilter();
  },

  onClearKeyword() {
    this.setData({ keyword: '' });
    this.applyFilter();
  },

  /**
   * 打开校园小工具。
   *
   * ⚠️ 它是**分包页**，用 `navigateTo`；`switchTab` 只用于 tabBar 页，用错会静默失败。
   *
   * 落点是**列表页**而不是某个具体工具：工具会越加越多，
   * 入口直指其中一个，就等于把"有哪些工具"这件事藏起来了。
   */
  onOpenToolkit() {
    wx.navigateTo({ url: '/pkg-toolkit/home/index' });
  },

  /** 点击本地小工具 → 对应页面（url 整条由 data-url 带过来） */
  onLocalToolTap(e: WechatMiniprogram.TouchEvent) {
    const url = (e.currentTarget.dataset as { url: string }).url;
    if (!url) return;
    wx.navigateTo({ url });
  },

  /** 点击工具 → 执行页（未实现的工具给出明确提示，而不是静默失败） */
  onToolTap(e: WechatMiniprogram.TouchEvent) {
    const { name, status } = e.currentTarget.dataset as { name: string; status: string };
    if (status === 'planned') {
      wx.showModal({
        title: '功能开发中',
        content: '该工具已规划但尚未上线，可先试试 AI PPT 生成、图片压缩、OCR 等已上线工具。',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    wx.navigateTo({ url: `/pkg-toolbox/run/index?toolName=${name}` });
  },

  onMyFiles() {
    wx.navigateTo({ url: '/pkg-toolbox/files/index' });
  },

  /**
   * 搜索框内容像一句话时，直接跳 AI 页（文档 5.3.4）。
   * ⚠️ AI 页是 tabBar 页：必须 `openOs`（switchTab），`navigateTo` 会静默失败。
   *
   * 达不到"一句话"的门槛时只做本地过滤 —— 但要说明为什么没跳 AI，
   * 否则用户以为搜索坏了（点了没反应是最难自查的体验问题）。
   */
  onSmartSubmit() {
    const kw = this.data.keyword.trim();
    if (kw.length >= 6 && /[，。？！,?!]|帮我|我要|怎么/.test(kw)) {
      openOs(kw);
      return;
    }
    wx.showToast({ title: '输入更完整的描述可让 AI 直接处理', icon: 'none' });
    this.applyFilter();
  },

  onPullDownRefresh() {
    void this.bootstrap().finally(() => wx.stopPullDownRefresh());
  },
});
