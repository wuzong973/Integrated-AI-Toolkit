/**
 * 编排结果 —— 交付包（M2-16）占位页
 *
 * ## 这一页确实没有数据可加载，而且要说清为什么
 *
 * 交付包要汇总**一次编排运行**的全部节点产物，而运行数据本身（M2-06）还没落地 ——
 * `GET /os/runs/:id` 目前不存在。之前的写法是 `data.empty` 写死 `true`，
 * 页面上两颗"重新加载"按钮点了只把 `loading` 置 false：
 * 拿死按钮冒充"正在加载"，比报错更难排查（红线 1）。
 *
 * ## 现在这一屏只有一个动作，且它真能走通
 *
 * 回任务看板（有上一页就 navigateBack；被深链直接打开时没有上一页，
 * `navigateBack` 会静默失败，所以退回 switchTab 到 AI 页）。
 *
 * 视觉：幻紫主题 · 圆角 36 · 流线感。
 */
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { OS_PAGE } from '../../utils/nav';

Page({
  data: {
    /**
     * 从任务看板带过来的运行编号。
     * 只为让用户确认"我看的是哪一次运行"，并**不**代表后端有这次运行可查。
     */
    runId: '',
    /** 装饰层视差位移（由 utils/fx.ts 写入） */
    fxStyle: '',
  },

  onLoad(query: Record<string, string>) {
    this.setData({ runId: query?.runId ?? '' });
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

  /** 回任务看板：AI 页是 tabBar 页，只能 switchTab（navigateTo 会静默失败） */
  onBack() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }
    wx.switchTab({ url: OS_PAGE });
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
