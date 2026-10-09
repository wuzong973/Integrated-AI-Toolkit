/**
 * 通用 H5 容器（协议 / 公告 / 帮助）
 *
 * 加载失败必须**看得见**：`web-view` 白屏时小程序不会给任何提示，
 * 而最常见的真实原因是"业务域名没在小程序后台配置"（上线前必踩）。
 * 所以这里接 `binderror`，把白屏换成一句说实话的错误条 + 返回。
 */
Page({
  data: {
    url: '',
    /** web-view 加载失败：改用 .qz-err 呈现，不再留一屏白 */
    showError: false,
  },

  onLoad(query: Record<string, string>) {
    const url = query.url ? decodeURIComponent(query.url) : '';
    this.setData({ url, showError: false });
    if (url)
      wx.setNavigationBarTitle({ title: query.title ? decodeURIComponent(query.title) : '详情' });
  },

  onLoadError() {
    this.setData({ showError: true });
  },

  /** 返回上一页；本页是直接打开的（无页可退）时回首页（首页是 tabBar 页 → switchTab） */
  onBack() {
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/home/index' }),
    });
  },
});
