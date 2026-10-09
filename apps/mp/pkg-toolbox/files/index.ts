/** 文件资产中心（文档 6.5.6） */
import type { FileItem } from '../../utils/api';
import { fileApi } from '../../utils/api';
import { downloadToLocal, formatBytes, isPlayableMedia, openLocalFile, shareLocalFile, stopAudio } from '../../utils/file-transfer';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { toastError } from '../../utils/request';

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'ai_generated', label: 'AI 生成' },
  { key: 'uploaded', label: '上传素材' },
  { key: 'order_delivery', label: '订单交付' },
];

/** 文件类型 → 糖果图标类名（纯展示映射，见 styles/icons.scss） */
const TYPE_ICONS: Record<string, string> = {
  image: 'qz-i-image',
  video: 'qz-i-video',
  audio: 'qz-i-audio',
  document: 'qz-i-doc',
};

/** 来源场景 → 中文标签（纯展示） */
const SCENE_TEXT: Record<string, string> = {
  ai_generated: 'AI 生成',
  uploaded: '上传素材',
  order_delivery: '订单交付',
};

/** 文件列表条目（在 FileItem 之上补四个纯展示字段） */
type FileRow = FileItem & {
  sizeText: string;
  iconClass: string;
  sceneText: string;
  createdAtText: string;
};

Page({
  data: {
    filters: FILTERS,
    activeFilter: 'all',
    /** 当前筛选分类的中文名（空态文案要用，WXML 里不写嵌套三元） */
    activeFilterLabel: '全部',
    allFiles: [] as FileRow[],
    files: [] as FileRow[],
    loading: true,
    error: '',
    /** 存储用量（免费 2GB，文档 6.5.6） */
    storageUsedMb: 0,
    storageQuotaMb: 2048,
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
    stopAudio();
  },

  onUnload() {
    fxDisableTilt();
    stopAudio();
  },

  /**
   * 拉取我的文件。
   *
   * 这里**故意没有** `onReachBottom` 分页：`GET /files` 返回的是**裸数组**，
   * 服务端 `FileService.list` 写死 `take: 200` 且 `FileListQuerySchema` 只认
   * `scene` / `trashed` 两个查询参数 —— 没有 cursor / page，客户端无从"取下一页"。
   * 真要分页得先给接口加 cursor（属后端改动，不在本页范围内）。
   */
  async load() {
    this.setData({ loading: true });
    try {
      const list = await fileApi.list();
      const decorated = list.map((f) => ({
        ...f,
        sizeText: formatBytes(f.size),
        iconClass: iconOf(f.type),
        sceneText: SCENE_TEXT[f.scene] ?? '其他',
        createdAtText: formatDateTime(f.createdAt),
      }));
      const used = Math.round(list.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024));
      this.setData({ allFiles: decorated, storageUsedMb: used, error: '', loading: false });
      this.applyFilter();
    } catch (e) {
      this.setData({
        allFiles: [],
        files: [],
        error: (e as Error).message || '加载失败',
        loading: false,
      });
    }
  },

  applyFilter() {
    const { allFiles, activeFilter } = this.data;
    this.setData({
      files: activeFilter === 'all' ? allFiles : allFiles.filter((f) => f.scene === activeFilter),
      // 空态文案要说得出"筛的是什么"，所以把当前分类名也带上
      activeFilterLabel: FILTERS.find((x) => x.key === activeFilter)?.label ?? '全部',
    });
  },

  onFilterTap(e: WechatMiniprogram.TouchEvent) {
    this.setData({ activeFilter: e.currentTarget.dataset.key as string });
    this.applyFilter();
  },

  /** 空态里的「清除筛选」：回到全部，而不是让用户自己去点胶囊 */
  onClearFilter() {
    this.setData({ activeFilter: 'all' });
    this.applyFilter();
  },

  onFileTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    const file = this.data.allFiles.find((f) => f.id === id);
    if (!file) return;

    // 动作名写的是它**实际做的事**：
    //   · 「预览/播放」= 取回文件并打开（图/文/音/视频/文档分流见 openLocalFile）；
    //     以前这项叫"下载"——但小程序的"下载"只是存进自己沙箱，用户在系统里
    //     根本看不到，名字反而把人吓住（怕"下载了却什么都没发生"）。
    //   · 「转发到微信」才是真正把文件"存到手机"的出口（对方/文件传输助手里
    //     可用其他应用打开、可转存）。括号里点破这一点，比让用户猜强。
    wx.showActionSheet({
      // 文案跟着文件类型走：对 md/pptx 说"播放"是凑词，对音频说"预览"又太含糊
      itemList: [isPlayableMedia(file.name) ? '播放' : '预览', '转发到微信（存到手机）', '删除'],
      success: (res) => {
        if (res.tapIndex === 0) void this.preview(file);
        else if (res.tapIndex === 1) void this.share(file);
        else if (res.tapIndex === 2) void this.remove(id);
      },
    });
  },

  /**
   * 预览/播放：签发地址 → 下载到临时目录 → 存进用户目录 → 按类型打开。
   *
   * 以前这里只弹一句"下载需接入签名 URL（M1-13）"，但那条链路后端**早就实现了**
   * （`GET /files/:id/download` 签发短时效地址 + `GET /files/local/:token` 回流字节），
   * 缺的只是客户端这一侧 —— 用户点"下载"永远只看到一个说明弹窗。
   *
   * 存下来之后**不再受签名地址有效期约束**，同一次会话内可反复打开
   *（音频再点一次 = 停止播放）。
   */
  async preview(file: FileRow) {
    wx.showLoading({ title: '打开中…', mask: true });
    try {
      const path = await downloadToLocal(file.id, file.name);
      wx.hideLoading();
      const hint = await openLocalFile(path, file.name);
      // 能打开就不再多说一句；打不开时必须说清"文件在哪、怎么拿到内容"
      if (hint) wx.showToast({ title: hint, icon: 'none', duration: 3000 });
    } catch (e) {
      wx.hideLoading();
      toastError(e);
    }
  },

  /**
   * 转发文件到微信。
   *
   * ⚠️ 小程序**没有**"另存为 / 选择本地文件夹"：文件只能落在自己的沙箱
   *（`wx.env.USER_DATA_PATH`），用户在系统里根本看不到它。
   * 转发到聊天是唯一能把文件真正带出去的途径 —— 转发后可以"用其他应用打开"，
   * 或者在电脑上收下。所以这条入口必须和「下载」并列摆出来，
   * 否则用户会以为"点了下载但什么都没拿到"。
   */
  async share(file: FileRow) {
    wx.showLoading({ title: '准备中…', mask: true });
    try {
      // 转发用的是本地文件路径，所以先落盘
      const path = await downloadToLocal(file.id, file.name);
      wx.hideLoading();
      await shareLocalFile(path, file.name);
    } catch (e) {
      wx.hideLoading();
      toastError(e);
    }
  },

  async remove(id: string) {
    wx.showModal({
      title: '删除文件',
      content: '删除后可在回收站保留 30 天。确定删除吗？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await fileApi.remove(id);
          wx.showToast({ title: '已删除', icon: 'success' });
          await this.load();
        } catch (e) {
          wx.showToast({ title: (e as Error).message, icon: 'none' });
        }
      },
    });
  },

  onPullDownRefresh() {
    void this.load().finally(() => wx.stopPullDownRefresh());
  },

  /** 错误条上的"重试"（复用 load，纯 UI 入口） */
  onRetry() {
    void this.load();
  },

  /** 空态引导：去工具箱生成第一个文件（tabBar 页必须用 switchTab） */
  onGoToolbox() {
    wx.switchTab({ url: '/pages/toolbox/index' });
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

function iconOf(type: string): string {
  return TYPE_ICONS[type] ?? 'qz-i-file';
}

/**
 * ISO 时间串 → `2026-09-18 03:21`。
 *
 * 后端给的是 UTC ISO（`2026-09-17T19:21:33.000Z`），以前直接铺在列表里，
 * 用户看到的是一串机器码；这里按本机时区收成一行能读的文字。
 */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
