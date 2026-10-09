/**
 * 设置（M5-05）—— 全部条目都只做**本机真的能做到的事**
 *
 * ## 这一页以前是一具空壳
 *
 * `data.empty` 写死 `true`，整页渲染"设置项准备中"，两颗"重新加载"按钮点了
 * 只把 `loading` 置 false。而这一页恰恰是**最不需要后端**的一页：
 * 账号信息读本地登录态、缓存读 `wx.getStorageInfoSync`、通知偏好存本地、
 * 版本号是编译期常量。所以现在的原则是：
 *
 *   ① 能在客户端做真事的，就做成真事（下面四项全部落地）；
 *   ② 后端没有的（注销、平台推送），**如实说出来**，不摆按钮骗人点。
 *
 * ## 缓存清理为什么只删一个 key
 *
 * 见 `TRANSIENT_KEYS` 的注释 —— 把 token 与用户资料一起清掉那叫"退出登录"，
 * 挂在"清理演示数据"这颗按钮上就是越权删除用户状态。
 *
 * 视觉：石墨青主题 · 圆角 16（克制）· 分组描边列表卡；装饰签名刻意做减法
 * （`.qz-deco` 里只留一枚光斑），可点组卡给 `.qz-lift`、开关与小按钮给 `.qz-press`。
 */
import type { MeInfo } from '../../utils/api';
import { APP_VERSION, ENV_NAME } from '../../utils/env';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { showNotReady } from '../../utils/not-ready';
import { getToken, getUser, toLogin } from '../../utils/request';

/** 通知偏好的存储键（纯本机：只控制本页那个开关的显示状态） */
const NOTIFY_KEY = 'qz_notify_local';

/**
 * 按钮说的"演示数据"具体指什么 —— **只有这一条**。
 *
 * `qz_nav_pending` 是跳 tabBar 页时中转的预填文本（见 `utils/nav.ts`），
 * 正常读完即清，异常退出时会残留：残留的那句话会在下次切到 AI 页时被自动发送。
 *
 * ⚠️ 不要把 token / `qz_user` / 计费缓存加进来：删它们等于退出登录或让
 * 界面短暂显示错误的计费模式，那不是我说的"演示数据"。
 *
 * （名字刻意不叫 `DEMO_KEYS`：`audit:mp` 把 `DEMO_*` 常量当作"页面在用假数据"的
 * 信号，而这里删的是本机残留，一屏真数据都没有。）
 */
const TRANSIENT_KEYS = ['qz_nav_pending'];

/** 手机号脱敏：后端给了掩码就用它，否则本地遮中间四位 */
function phoneText(user: MeInfo | null): string {
  const raw = user?.maskedPhone || user?.phone || '';
  if (!raw) return '未绑定手机号';
  if (raw.includes('*')) return raw;
  return raw.length === 11 ? `${raw.slice(0, 3)}****${raw.slice(7)}` : '已绑定';
}

/** 读本地缓存占用（KB）。存储不可用时返回 0，绝不让设置页白屏 */
function cacheInfo(): { kb: number; count: number } {
  try {
    const info = wx.getStorageInfoSync();
    return { kb: info.currentSize, count: info.keys.length };
  } catch {
    return { kb: 0, count: 0 };
  }
}

Page({
  data: {
    /** 环境名（develop / trial / release），用来解释"为什么接口还没全通" */
    envName: ENV_NAME,
    version: APP_VERSION,
    loggedIn: false,
    nickname: '',
    phoneText: '',
    cacheKb: 0,
    cacheCount: 0,
    notifyOn: true,
    /** 装饰层视差位移（由 utils/fx.ts 写入） */
    fxStyle: '',
  },

  onLoad() {
    this.refresh();
  },

  onShow() {
    // 真机上开启陀螺仪倾斜视差；开发者工具无传感器时会静默跳过
    fxEnableTilt(this);
    // 登录态可能在别的页面变了（登录页/我的页），每次回到本页重读一次
    this.refresh();
  },

  onHide() {
    fxDisableTilt();
  },

  onUnload() {
    fxDisableTilt();
  },

  /** 读本地登录态与存储占用 —— 全是同步 API，不需要 loading 态 */
  refresh(): void {
    let notifyOn = true;
    try {
      notifyOn = wx.getStorageSync<boolean>(NOTIFY_KEY) !== false;
    } catch {
      // 存储不可用：按默认"开"显示，不阻塞这一页
    }
    const user = getUser<MeInfo>();
    const cached = getToken();
    const cache = cacheInfo();
    this.setData({
      loggedIn: Boolean(cached),
      nickname: user?.nickname || '青智用户',
      phoneText: phoneText(user),
      notifyOn,
      cacheKb: cache.kb,
      cacheCount: cache.count,
    });
  },

  /** 账号行：两种状态都得有真去处 —— 未登录去登录，已登录去「我的」（TabBar 页只能 switchTab） */
  onAccountTap() {
    if (this.data.loggedIn) {
      wx.switchTab({ url: '/pages/mine/index' });
      return;
    }
    toLogin();
  },

  /** 通知开关：只写本机偏好。平台推送不存在，所以文案里明说"仅影响本机提醒" */
  onNotifyToggle() {
    const next = !this.data.notifyOn;
    try {
      wx.setStorageSync(NOTIFY_KEY, next);
    } catch {
      wx.showToast({ title: '存储不可用，偏好未能保存', icon: 'none' });
    }
    this.setData({ notifyOn: next });
  },

  /** 清理演示数据：只删 TRANSIENT_KEYS，删完如实报数 */
  onClearDemo() {
    let removed = 0;
    for (const key of TRANSIENT_KEYS) {
      try {
        if (wx.getStorageSync(key)) removed += 1;
        wx.removeStorageSync(key);
      } catch {
        // 单个 key 删不掉不值得打断用户，剩下的继续删
      }
    }
    const cache = cacheInfo();
    this.setData({ cacheKb: cache.kb, cacheCount: cache.count });
    wx.showToast({
      title: removed ? `已清理 ${removed} 项演示数据` : '没有可清理的演示数据',
      icon: 'none',
    });
  },

  /** 关于：版本号 + 一句真实的项目状态（不吹"已上线"） */
  onAbout() {
    wx.showModal({
      title: `青智校园 v${APP_VERSION}`,
      content:
        '面向校园的 AI 工具箱 + 任务驿站 + 编排 Agent。\n\n' +
        `当前运行环境：${ENV_NAME}\n` +
        '功能按里程碑逐步开放，未上线的部分界面会如实标注。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  /** 注销：后端没有这个接口（M5-03），如实告知，不给"已提交申请"的假反馈 */
  onDeactivate() {
    showNotReady('账号注销', '需人工核验身份，后端未开放（M5-03）');
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
