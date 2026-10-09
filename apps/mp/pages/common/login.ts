/**
 * 登录页（任务清单 M0-20）
 * 微信授权登录 → 写入会话 → 回跳原页面
 */
import { authApi } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { setSession, toastError } from '../../utils/request';

/**
 * 协议 / 隐私政策的 H5 正文地址。
 *
 * ⚠️ 现在**没有可用地址**：原先这里写的是 `https://example.com/agreement` 占位域名，
 * 而 `web-view` 组件要求真实 HTTPS 域名、且要在小程序后台配好业务域名，真机上必然白屏 ——
 * 把"协议正文还没发布"演成"页面坏了"是更糟的结果。
 * 所以正文上线前只在本地弹窗给要点；官网协议页上线后把这两个常量填上，
 * 弹窗会自动多出一个「查看全文」入口（走通用 H5 容器 `pages/common/webview`）。
 */
const AGREEMENT_H5_URL = '';
const PRIVACY_H5_URL = '';

/** 要点摘要：只写**已经成立**的事实，不承诺还没做的能力（红线 9） */
const AGREEMENT_SUMMARY =
  '1. 账号：用微信登录创建，同一账号可在学生与服务者身份之间切换。\n' +
  '2. 内容：你在驿站发布的需求与上传的作品，平台仅在撮合与展示范围内使用。\n' +
  '3. 交易：驿站订单采用担保交易，验收通过后才向服务者放款。\n' +
  '4. 边界：不得发布违法违规内容，违规账号将被限制使用。\n\n' +
  '完整协议文本随正式上线发布。';

const PRIVACY_SUMMARY =
  '1. 收集：微信昵称与头像、学校 / 学院 / 年级，以及你主动上传的文件。\n' +
  '2. 用途：仅用于校园身份识别、AI 任务执行与订单结算。\n' +
  '3. 不做：不向第三方广告商出售或共享你的个人信息。\n' +
  '4. 传输：小程序与平台服务器之间通过 HTTPS 通信。\n\n' +
  '完整政策文本随正式上线发布。';

/** 协议弹窗：给要点；配了真实 H5 地址才提供"查看全文" */
function showPolicy(title: string, summary: string, h5Url: string): void {
  wx.showModal({
    title,
    content: summary,
    showCancel: Boolean(h5Url),
    cancelText: '知道了',
    confirmText: h5Url ? '查看全文' : '知道了',
    success: (res) => {
      if (!res.confirm || !h5Url) return;
      wx.navigateTo({
        url:
          '/pages/common/webview?url=' +
          encodeURIComponent(h5Url) +
          '&title=' +
          encodeURIComponent(title),
      });
    },
  });
}

Page({
  data: {
    redirect: '/pages/home/index',
    loading: false,
    agreed: false,
    fxStyle: '',
  },

  onLoad(query: Record<string, string>) {
    if (query.redirect) {
      this.setData({ redirect: decodeURIComponent(query.redirect) });
    }
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

  onAgreeToggle() {
    this.setData({ agreed: !this.data.agreed });
  },

  /** 授权登录 */
  async onLogin() {
    if (!this.data.agreed) {
      wx.showToast({ title: '请先阅读并同意用户协议', icon: 'none' });
      return;
    }
    if (this.data.loading) return;
    this.setData({ loading: true });

    try {
      const loginRes = await new Promise<WechatMiniprogram.LoginSuccessCallbackResult>(
        (resolve, reject) => {
          wx.login({
            success: resolve,
            // 授权是关键业务路径：fail 必须给出"下一步做什么"。
            // 直接把微信原话（`login:fail ...`）弹给用户等于没提示。
            fail: (err) => {
              console.warn('[login] wx.login 失败：', err.errMsg);
              reject(new Error('微信授权未完成，请检查网络后重新登录'));
            },
          });
        },
      );

      const result = await authApi.login(loginRes.code);
      setSession(result);

      // 通知 app 刷新用户态
      const app = getApp<IAppOption>();
      await app?.refreshUser?.();

      wx.showToast({ title: '登录成功', icon: 'success' });
      setTimeout(() => {
        // 回跳（tabBar 页用 switchTab）
        const isTab = [
          '/pages/home/index',
          '/pages/toolbox/index',
          '/pages/os/index',
          '/pages/station/index',
          '/pages/mine/index',
        ].includes(this.data.redirect);
        if (isTab) wx.switchTab({ url: this.data.redirect });
        else wx.redirectTo({ url: this.data.redirect });
      }, 600);
    } catch (e) {
      toastError(e);
    } finally {
      this.setData({ loading: false });
    }
  },

  onOpenAgreement() {
    showPolicy('用户协议', AGREEMENT_SUMMARY, AGREEMENT_H5_URL);
  },

  onOpenPrivacy() {
    showPolicy('隐私政策', PRIVACY_SUMMARY, PRIVACY_H5_URL);
  },
});
