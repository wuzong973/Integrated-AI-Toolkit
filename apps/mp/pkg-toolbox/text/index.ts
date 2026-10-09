/**
 * 文本产物预览（.md / .txt / .csv / .json）
 *
 * ## 为什么需要它
 *
 * 小程序**没有**"另存为 / 选择本地文件夹"的能力 —— 文件只能落在自己的沙箱
 *（`wx.env.USER_DATA_PATH`）。而 LLM 类工具的产物恰好是 `.md`，
 * 系统预览器（`wx.openDocument`）打不开它，于是以前只弹一句"内容已复制到剪贴板"：
 * 用户既看不到内容，也不知道文件到底存到哪了。
 *
 * 这个页面把内容直接摊开，并给出两个真正有用的动作：
 *   · 复制全文 —— 粘到别处继续用
 *   · 转发文件 —— 导出到微信，是小程序里唯一能把文件"带出去"的方式
 *     （转发后可在微信里"用其他应用打开"，或在电脑上收下）
 */
import { readLocalText, shareLocalFile } from '../../utils/file-transfer';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { toastError } from '../../utils/request';

/**
 * 容错解码页面参数。
 *
 * 调用方用 `encodeURIComponent` 拼的 URL，但小程序**可能已经替我们解过一次**
 * （各基础库行为不一致）。再解一次通常无害，只有当路径里恰好含 `%`
 * （文件名允许出现）时才会抛 `URIError` —— 所以解不动就原样返回。
 */
function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

Page({
  data: {
    name: '',
    path: '',
    content: '',
    loading: true,
    error: '',
    /** 纯展示：行数 / 字符数 */
    lineCount: 0,
    charCount: 0,
    /** 装饰层视差位移（由 utils/fx.ts 写入） */
    fxStyle: '',
  },

  onLoad(query: Record<string, string>) {
    // 路径与文件名由调用方 encodeURIComponent 过（可能含中文与斜杠）。
    // ⚠️ 小程序对 query 的解码行为在不同基础库上不一致（有的已解一次），
    // 所以这里做**容错解码**：能解就解，解不动就原样用，两种情况都正确。
    const path = safeDecode(query.path || '');
    const name = safeDecode(query.name || '文本文件');
    this.setData({ path, name });
    wx.setNavigationBarTitle({ title: name });
    void this.load(path);
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

  async load(path: string) {
    if (!path) {
      this.setData({ loading: false, error: '缺少文件路径' });
      return;
    }
    try {
      const content = await readLocalText(path);
      this.setData({
        content,
        loading: false,
        error: '',
        lineCount: content.split('\n').length,
        charCount: content.length,
      });
    } catch (e) {
      this.setData({ loading: false, error: (e as Error).message || '读取失败' });
    }
  },

  /**
   * 复制全文。
   *
   * `success` 不必自己补 toast（`wx.setClipboardData` 自带"内容已复制"提示），
   * 但 `fail` **必须补** —— 复制在部分机型/权限异常下会失败，
   * 没有反馈时用户会以为已经复制好了，切到别处粘贴却是空的
   * （所以这里不只说"复制失败"，还顺手给出一条退路：长按选择文本）。
   */
  onCopy() {
    wx.setClipboardData({
      data: this.data.content,
      fail: () => wx.showToast({ title: '复制失败，请长按选择文本', icon: 'none' }),
    });
  },

  /** 转发文件到微信（导出到沙箱之外的唯一途径） */
  async onShare() {
    try {
      await shareLocalFile(this.data.path, this.data.name);
    } catch (e) {
      toastError(e);
    }
  },

  onRetry() {
    void this.load(this.data.path);
  },

  /** 空态主按钮：退回上一页（来源是「我的文件」或结果页的下载动作） */
  onBack() {
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/toolbox/index' }),
    });
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
