/**
 * 首页（文档 5.3.1，任务清单 M0-17）
 * 主入口：搜索框（进 OS）、快捷指令、金刚区、热门工具、进行中、热门服务、活动/公告
 *
 * 视觉升级：装饰层随指针视差（utils/fx.ts）、滚动渐白导航、糖果图标映射。
 */
import type { HealthInfo, TaskItem, ToolItem } from '../../utils/api';
import { healthApi, stationApi, toolboxApi } from '../../utils/api';
import { isBillingFree, loadBillingMode, priceText } from '../../utils/billing';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { openOs } from '../../utils/nav';
import { showNotReady } from '../../utils/not-ready';
import { statusBarStyle } from '../../utils/system';

/** 快捷指令（点击后进 OS 并自动发送，文档 5.3.1 交互要点） */
const QUICK_COMMANDS = [
  '帮我做一份 PPT',
  '帮我把视频压缩到 50MB',
  '我要找一个同学拍毕业照',
  '帮我策划一次社团活动',
];

/** 金刚区入口（icon 为糖果图标类名，见 styles/icons.scss） */
const GRID_ENTRIES = [
  { key: 'os', name: 'AI 员工', icon: 'qz-i-ai', url: '/pages/os/index', ai: true },
  { key: 'toolbox', name: '工具箱', icon: 'qz-i-toolbox', url: '/pages/toolbox/index', tab: true },
  {
    key: 'station',
    name: '青智驿站',
    icon: 'qz-i-station',
    url: '/pages/station/index',
    tab: true,
  },
  { key: 'workbench', name: '工作台', icon: 'qz-i-workbench', url: '/pkg-station/workbench/index' },
  // 记单词（M4-15）：独立分包页，不属于任何 tab
  { key: 'vocab', name: '记单词', icon: 'qz-i-learn', url: '/pkg-vocab/home/index' },
  // 练习中心（M4-16）：四六级句子 / 口语 / 作文三种练习，与「记单词」并列
  { key: 'practice', name: '练习中心', icon: 'qz-i-tutor', url: '/pkg-practice/home/index' },
];

/** 工具分类 → 糖果图标（新增分类时在此登记，保证列表不出现"无图标"） */
const TOOL_ICONS: Record<string, string> = {
  ai_office: 'qz-i-office',
  image: 'qz-i-image',
  video: 'qz-i-video',
  audio: 'qz-i-audio',
  pdf: 'qz-i-pdf',
  file: 'qz-i-file',
  ai_learn: 'qz-i-learn',
};

/** 带图标的工具条目 */
type HotTool = ToolItem & { iconClass: string; priceLabel: string; free: boolean };

function toolIcon(categoryId: string): string {
  return TOOL_ICONS[categoryId] ?? 'qz-i-doc';
}

Page({
  data: {
    quickCommands: QUICK_COMMANDS,
    gridEntries: GRID_ENTRIES,
    /** 后端连通状态（用于首屏自检，也是 M0 验收要求的"首页显示版本号"） */
    health: null as HealthInfo | null,
    healthError: '',
    hotTools: [] as HotTool[],
    hotTasks: [] as TaskItem[],
    /** 是否免费开放（价格位置改为显示"限时免费"） */
    billingFree: false,
    loading: true,
    /** 滚动后导航变白 */
    scrolled: false,
    /** 装饰层视差位移（由 utils/fx.ts 写入） */
    fxStyle: '',
    /** 根节点内联样式：把状态栏高度挂成 CSS 变量 --qz-sb（自定义导航只能靠它避让顶部） */
    sbStyle: '',
  },

  onLoad() {
    // 顶部避让必须在首帧前就位，否则会先闪一下"贴顶"再跳下来
    this.setData({ sbStyle: statusBarStyle() });
    void this.bootstrap();
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

  /**
   * 屏幕尺寸变化（横竖屏切换 / 折叠屏展开）后状态栏高度会变，重算一次。
   * 当前未开横屏（app.json 没有 pageOrientation），正常不会触发；
   * 但一旦将来打开横屏，缺了这个回调就会立刻重现"内容被状态栏压住"。
   */
  onResize() {
    this.setData({ sbStyle: statusBarStyle() });
  },

  /** 首屏拉取：计费模式 + 健康检查 + 热门工具 + 热门服务（并行，互不阻塞） */
  async bootstrap() {
    // 先取计费模式：价格文案依赖它，否则会先闪一下"5 积分"再变成"限时免费"
    await loadBillingMode();
    const tasks = [this.loadHealth(), this.loadHotTools(), this.loadHotTasks()];
    await Promise.allSettled(tasks);
    this.setData({ loading: false });
  },

  /** 健康检查：证明前后端真实联通（M0 验收） */
  async loadHealth() {
    try {
      const health = await healthApi.check();
      this.setData({ health, healthError: '' });
    } catch (e) {
      this.setData({
        health: null,
        healthError: (e as Error).message || '后端未连接',
      });
    }
  },

  async loadHotTools() {
    try {
      const list = await toolboxApi.list();
      // 热门：按使用次数排序取前 6
      const hot = [...list]
        .sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0))
        .slice(0, 6)
        .map((tool) => ({
          ...tool,
          iconClass: toolIcon(tool.categoryId),
          // 价格文案走统一的计费模式判断（免费期显示"限时免费开放中"）
          priceLabel: priceText(tool.price),
          free: isBillingFree(),
        }));
      this.setData({ hotTools: hot, billingFree: isBillingFree() });
    } catch {
      // 静默失败：热门工具不是主链路
    }
  },

  async loadHotTasks() {
    try {
      const res = await stationApi.tasks({ status: 'published' });
      this.setData({ hotTasks: (res.list ?? []).slice(0, 3) });
    } catch {
      // 静默失败
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

  /** 滚动渐白导航 */
  onPageScroll(e: { scrollTop: number }) {
    const scrolled = e.scrollTop > 24;
    if (scrolled !== this.data.scrolled) this.setData({ scrolled });
  },

  /**
   * 点击搜索框 → 跳 AI（OS）页。
   * ⚠️ 必须走 `openOs`：OS 是 tabBar 页，`wx.navigateTo` 跳不过去且不报错。
   */
  onSearchTap() {
    openOs();
  },

  /** 学校名（多校区选择 M4-10）：后端未开放，如实告知，不留一个点了没反应的假箭头 */
  onSchoolTap() {
    showNotReady('切换学校', '多校区选择（M4-10）后端未开放');
  },

  /**
   * 铃铛 → 消息中心（站内消息 M3-19 已上线：`GET /notifications` 真实读写）。
   *
   * 红点由消息中心的另一条任务负责渲染，本页只负责"点得进去"；
   * 未读数由 `pkg-mine/notifications` 拉列表时写进 `globalData.unreadCount`。
   */
  onBellTap() {
    wx.navigateTo({ url: '/pkg-mine/notifications/index' });
  },

  /** 连通自检失败后的重试：只重拉健康检查，不必整页重来 */
  onRetryHealth() {
    this.setData({ healthError: '' });
    void this.loadHealth();
  },

  /** 空态主按钮 → 工具箱（tabBar 页，必须 switchTab） */
  onGoToolbox() {
    wx.switchTab({ url: '/pages/toolbox/index' });
  },

  /** 快捷指令 → AI 页并自动发送（tabBar 页不能带 query，参数经本地存储中转） */
  onQuickCommand(e: WechatMiniprogram.TouchEvent) {
    openOs(e.currentTarget.dataset.cmd as string);
  },

  /** 金刚区跳转 */
  onGridTap(e: WechatMiniprogram.TouchEvent) {
    const { url, tab } = e.currentTarget.dataset as { url: string; tab?: boolean };
    if (tab) wx.switchTab({ url });
    else wx.navigateTo({ url });
  },

  onToolTap(e: WechatMiniprogram.TouchEvent) {
    const name = e.currentTarget.dataset.name as string;
    wx.navigateTo({ url: `/pkg-toolbox/run/index?toolName=${name}` });
  },

  onTaskTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/pkg-station/task/index?id=${id}` });
  },

  onMoreTools() {
    wx.switchTab({ url: '/pages/toolbox/index' });
  },

  onMoreTasks() {
    wx.switchTab({ url: '/pages/station/index' });
  },

  /** 悬浮 AI 球 → AI 页（同样是 tabBar 页，必须 switchTab） */
  onFloatAi() {
    openOs();
  },

  onPullDownRefresh() {
    void this.bootstrap().finally(() => wx.stopPullDownRefresh());
  },

  /** 分享 */
  onShareAppMessage() {
    return { title: '青智校园 · 让 AI 理解需求，让青年创造价值', path: '/pages/home/index' };
  },
});
