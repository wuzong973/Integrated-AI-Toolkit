/**
 * 我的（文档 5.3.11）
 * 展示用户画像、信用、身份切换与二级入口
 */
import type { MeInfo } from '../../utils/api';
import { authApi } from '../../utils/api';
import { POINTS_STAT_LABEL, loadBillingMode, showPoints } from '../../utils/billing';
import { ADMIN_CONSOLE_IS_PLACEHOLDER, ADMIN_CONSOLE_URL, ENV_NAME } from '../../utils/env';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { MENU_GROUPS, showsAdminEntry } from '../../utils/mine-menu';
import { clearSession, getToken } from '../../utils/request';

/** 后端"鉴权类"错误码（与 utils/request.ts 一致：401 会先自动刷新并重放一次） */
const AUTH_ERROR_CODES = [40101, 40102, 40103];

/**
 * 是否"确实未登录 / 登录已失效"。
 *
 * 判据刻意保守：宁可报"加载失败"，也不要把网络抖动说成用户没登录 ——
 * 后者会让用户退出再登录一遍，而真正的问题（断网 / 后端没起）依旧没解决。
 */
function isUnauthorized(err: unknown): boolean {
  const e = err as { code?: number; statusCode?: number; configError?: boolean };
  if (e?.configError) return false;
  if (e?.statusCode === 401) return true;
  if (e?.code !== undefined && AUTH_ERROR_CODES.includes(e.code)) return true;
  // 刷新失败时 request.ts 会 clearSession：走到这里 token 已经没了，才是真未登录
  return !getToken();
}

function errorMessage(err: unknown): string {
  return (err as Error)?.message || '资料加载失败，请检查网络后重试';
}

Page({
  data: {
    me: null as MeInfo | null,
    menuGroups: MENU_GROUPS,
    /** 底部固定栏的后台入口要不要亮：判据是后端的 isAdmin，缺省按非管理员 */
    showAdmin: false,
    loading: true,
    notLoggedIn: false,
    /** 资料拉取失败的如实提示（区别于"未登录"） */
    loadError: '',
    /** 身份切换（一账号多身份，ADR-06） */
    roles: [] as { role: string; label: string }[],
    currentRole: 'student',
    /** 是否展示"积分"统计项：免费开放期不展示（界面里不出现"积分"二字） */
    showPoints: false,
    /** 标签文案。含"积分"二字的用户可见文案统一出自 utils/billing */
    pointsLabel: POINTS_STAT_LABEL,
    fxStyle: '',
  },

  onShow() {
    fxEnableTilt(this);
    void this.loadMe();
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

  async loadMe() {
    // 先取计费模式：决定要不要展示"积分"统计项（免费期整项隐藏）
    await loadBillingMode();
    this.setData({ showPoints: showPoints(), loadError: '' });

    if (!getToken()) {
      this.setData({ notLoggedIn: true, loading: false });
      return;
    }

    try {
      const me = await authApi.me();
      this.setData({
        me,
        loading: false,
        notLoggedIn: false,
        roles: this.buildRoles(me),
        // 后台入口与 me 同一次 setData：分两次会让底栏闪一下
        showAdmin: showsAdminEntry(me),
      });
    } catch (e) {
      // 只有"确实没登录"才走未登录分支；其它错误如实报错 + 可重试（见 isUnauthorized）
      if (isUnauthorized(e)) {
        clearSession();
        this.setData({
          me: null,
          roles: [],
          notLoggedIn: true,
          loading: false,
        });
        return;
      }
      this.setData({ loadError: errorMessage(e), loading: false });
    }
  },

  /** 错误态的"重试"：重新拉一次资料（成功后 loadError 会被清掉） */
  onRetryMe() {
    void this.loadMe();
  },

  /** 统计项 → 对应详情页（信用 / 钱包 / 订单列表都是分包页，非 tabBar） */
  onStatTap(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: e.currentTarget.dataset.url as string });
  },

  /** 未认证学生 → 学生认证 */
  onGoVerify() {
    wx.navigateTo({ url: '/pkg-mine/verify/index' });
  },

  /** 未认证服务者 → 服务者入驻认证 */
  onGoProviderApply() {
    wx.navigateTo({ url: '/pkg-station/apply/index' });
  },

  /** 角色列表（学生 + 已认证服务者才显示切换器） */
  buildRoles(me: MeInfo): { role: string; label: string }[] {
    const list = [{ role: 'student', label: '我是学生' }];
    if (me.isProvider) list.push({ role: 'provider', label: '我是服务者' });
    return list;
  },

  /**
   * 菜单分派。
   *
   * 有 `url` 的直接跳；「管理后台」没有 url，交给 `onAdminTap`。
   * 每一项都必然带 `url`（`MineMenuItem.url` 已改成必填），所以这里不再做
   * "按 key 分派"的特殊分支 —— 那种分支的存在意义是「管理后台」这个网页入口，
   * 它现在挪到了底部固定栏（`onGoAdmin` / `onOpenAdminConsole`）。
   */
  onMenuTap(e: WechatMiniprogram.TouchEvent) {
    const { url } = e.currentTarget.dataset as { url?: string };
    if (url) wx.navigateTo({ url });
  },

  /** 点头像区进个人信息编辑页（整块 profile-top 都是热区，不只是那个圆） */
  onEditProfile() {
    wx.navigateTo({
      url: '/pkg-mine/profile/index',
      fail: () => wx.showToast({ title: '打开失败，请退出重试', icon: 'none' }),
    });
  },

  /** 底部固定栏的主入口：小程序内的后台页 */
  onGoAdmin() {
    wx.navigateTo({
      url: '/pkg-mine/admin/index',
      fail: () => wx.showToast({ title: '后台页打开失败，请退出重试', icon: 'none' }),
    });
  },

  /**
   * 「网页版后台」入口（底部固定栏的次要按钮）。
   *
   * 小程序内已经有一套后台页（`onGoAdmin`），这一条留给**宽表格场景**：
   * 用户列表、作业列表在手机上只能看个大概，真正要筛要翻页还是电脑上的
   * `apps/admin` 好用。所以两条路并存，而不是用网页版取代原生页。
   *
   *  ① 复制地址 → 电脑浏览器打开（推荐）；
   *  ② 小程序内用 `web-view` 打开（只在**开发者工具**里可用 ——
   *     真机/体验版要求该域名已备案且已加入小程序后台「业务域名」，`webview` 页
   *     会把白屏换成一句可读的错误条，不会假装成功）。
   */
  onOpenAdminConsole() {
    // 未配置真实域名时**如实说明**，而不是给一个点开必然失败的入口
    if (ADMIN_CONSOLE_IS_PLACEHOLDER) {
      wx.showModal({
        title: '管理后台未配置',
        content: `当前环境「${ENV_NAME}」的后台地址仍是占位域名，请到 apps/mp/config/endpoints.ts 填入真实域名。`,
        showCancel: false,
        confirmText: '知道了',
        fail: () => undefined,
      });
      return;
    }

    const url = ADMIN_CONSOLE_URL;
    wx.showActionSheet({
      itemList: ['复制地址（推荐，电脑浏览器打开）', '在小程序内打开'],
      success: (res) => {
        if (res.tapIndex === 0) {
          // 复制后系统自带"内容已复制"提示，这里不叠加 toast
          wx.setClipboardData({ data: url, fail: () => undefined });
          return;
        }
        const q = `url=${encodeURIComponent(url)}&title=${encodeURIComponent('管理后台')}`;
        wx.navigateTo({
          url: `/pages/common/webview?${q}`,
          fail: () => wx.showToast({ title: '打开失败', icon: 'none' }),
        });
      },
      // 用户取消也会走 fail，这里必须接住且**不能报错**（否则每次取消都弹一条错误）
      fail: () => undefined,
    });
  },

  onRoleSwitch(e: WechatMiniprogram.TouchEvent) {
    const role = e.currentTarget.dataset.role as string;
    this.setData({ currentRole: role });
    if (role === 'provider') {
      wx.navigateTo({ url: '/pkg-station/workbench/index' });
    }
  },

  onGoLogin() {
    wx.navigateTo({ url: '/pages/common/login' });
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新登录才能使用交易功能。',
      success: (res) => {
        if (!res.confirm) return;
        clearSession();
        this.setData({ me: null, notLoggedIn: true, roles: [] });
        wx.showToast({ title: '已退出', icon: 'success' });
      },
    });
  },

  onPullDownRefresh() {
    void this.loadMe().finally(() => wx.stopPullDownRefresh());
  },
});
