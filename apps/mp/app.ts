/**
 * 小程序入口（任务清单 M0-17 / M0-20）
 * 职责：静默登录、登录态冷启动恢复、全局配置
 */
import { authApi } from './utils/api';
import { loadBillingMode } from './utils/billing';
import { API_BASE, ENV_NAME, envConfigProblems, envConfigWarnings } from './utils/env';
import { clearSession, getToken, getUser, setSession } from './utils/request';

App<IAppOption>({
  globalData: {
    user: null,
    isLoggedIn: false,
    systemInfo: null,
    demoMode: true,
  },

  onLaunch() {
    this.reportEnvConfig();
    this.initSystemInfo();
    /**
     * 计费模式：冷启动**强制**拉取一次，不走缓存。
     *
     * 为什么必须强制：缓存带 TTL 只能解决"长时间挂着"的场景，
     * 而"上次落了一次陈旧值"必须靠每次冷启动的真实拉取来纠正 ——
     * 否则后端已改成免费、界面却一直显示价格（前台展示与真实行为不一致）。
     * 这里不 await：登录与首屏渲染不该等它，各页面自己会 await 同一个 Promise。
     */
    void loadBillingMode(true);
    void this.silentLogin();
  },

  /**
   * 由请求层回调：同步最近一次响应头 X-Provider 的判定结果（红线 10）。
   * 页面读 getApp<IAppOption>().globalData.demoMode 即可决定是否显示"演示模式"角标。
   */
  setDemoMode(demo: boolean) {
    this.globalData.demoMode = demo;
  },

  /**
   * 环境配置自检（排查报告 P0-3）。
   *
   * 为什么要在启动时喊出来：地址仍是占位域名时**所有**请求都会失败，
   * 而这个现象看起来和"后端挂了/网络不好"完全一样，开发者会去查网络和后端，
   * 就是不查地址配置。启动日志是唯一能一眼定位的地方。
   *
   * 只打日志、不弹窗：弹窗会打断正常开发流程，而开发者工具的 Console 足够醒目。
   */
  reportEnvConfig() {
    // eslint-disable-next-line no-console
    console.info(`[env] 环境=${ENV_NAME} 基址=${API_BASE}`);
    const problems = envConfigProblems();
    if (problems.length) {
      // eslint-disable-next-line no-console
      console.error(`[env] 后端地址配置有误，所有请求都会失败：\n  - ${problems.join('\n  - ')}`);
    }
    for (const w of envConfigWarnings()) {
      // eslint-disable-next-line no-console
      console.warn(`[env] ${w}`);
    }
  },

  /** 采集系统信息（顶部胶囊对齐与底部安全区适配，文档 5.1.1） */
  initSystemInfo() {
    try {
      const windowInfo = wx.getWindowInfo();
      this.globalData.systemInfo = windowInfo;
    } catch {
      // 老版本基础库兜底
      this.globalData.systemInfo = wx.getSystemInfoSync();
    }
  },

  /**
   * 静默登录：拿到 openid 即建账号，不强制授权头像昵称（降低流失，文档 6.1.1）
   * 已登录时用 /auth/me 恢复用户态，避免每次启动都登录。
   */
  async silentLogin() {
    const token = getToken();

    // 已有 token：直接恢复用户态
    if (token) {
      try {
        const me = await authApi.me();
        this.globalData.user = me as unknown as Record<string, unknown>;
        this.globalData.isLoggedIn = true;
        return;
      } catch {
        clearSession();
      }
    }

    // 无 token 或恢复失败：走静默登录
    try {
      const result = await new Promise<WechatMiniprogram.LoginSuccessCallbackResult>(
        (resolve, reject) => {
          wx.login({ success: resolve, fail: reject });
        },
      );

      const res = await authApi.login(result.code);
      setSession(res);
      this.globalData.user = res.user as unknown as Record<string, unknown>;
      this.globalData.isLoggedIn = true;
    } catch (e) {
      // 静默登录失败不阻塞使用（游览态可用），但记录日志
      // eslint-disable-next-line no-console
      console.warn('[app] 静默登录失败：', (e as Error).message);
      this.globalData.user = getUser();
    }
  },

  /** 供页面在需要时主动刷新用户态 */
  async refreshUser(): Promise<void> {
    try {
      const me = await authApi.me();
      this.globalData.user = me as unknown as Record<string, unknown>;
      this.globalData.isLoggedIn = true;
      wx.setStorageSync('qz_user', me);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[app] 刷新用户态失败：', (e as Error).message);
    }
  },
});
