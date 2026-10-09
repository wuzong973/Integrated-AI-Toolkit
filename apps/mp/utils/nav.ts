/**
 * 页面跳转（tabBar 感知）
 *
 * ## 为什么需要它
 *
 * 两个微信小程序的硬规则，**编译期都不报错**，表现统一是"点了没反应"：
 *
 *   1. `wx.navigateTo` **不能跳 tabBar 页面** —— 调用不报错、也不跳转，静默失败；
 *   2. `wx.switchTab` **不能带 query 参数** —— `?q=xxx` 会被直接丢掉。
 *
 * 本项目曾因此踩坑 6 处：首页搜索框 / 快捷指令 / 悬浮 AI 球、工具箱智能搜索、
 * 结果页"用 AI 修改"与"生成会议纪要"，全部点了不跳。
 *
 * 所以"跳 tabBar 页 + 传参"必须两步走：参数先落到本地存储，目标页在 `onShow`
 * 里取走（取走即清空，避免下次手动切到该 tab 时重复触发）。
 *
 * ⚠️ 新增跳转时优先用本文件的函数，不要直接写 `wx.navigateTo` 跳 tabBar 页。
 *    静态检查见 `scripts/dev/audit-mp-bindings.mjs`。
 */

/** 待处理参数（跳 tabBar 页时中转；读取即清空） */
const PENDING_KEY = 'qz_nav_pending';

/** AI（OS）页路径。它是 tabBar 页，只能 switchTab */
export const OS_PAGE = '/pages/os/index';

/**
 * 跳到 AI 页，可选带上"预填并自动发送"的文本。
 *
 * @param query 要预填到输入框并自动发送的内容；不传则只跳页
 */
export function openOs(query?: string): void {
  try {
    if (query) wx.setStorageSync(PENDING_KEY, query);
    else wx.removeStorageSync(PENDING_KEY);
  } catch {
    // 存储不可用（罕见）：退化为"只跳页、不预填"，不阻塞跳转本身
  }
  wx.switchTab({ url: OS_PAGE });
}

/**
 * 取走待处理参数（读取即清空）。目标页在 `onShow` 里调用。
 * 没有待处理参数时返回空串 —— 此时应保持页面原样，不要清空用户已输入的内容。
 */
export function takePendingQuery(): string {
  try {
    const q = wx.getStorageSync<string>(PENDING_KEY) || '';
    if (q) wx.removeStorageSync(PENDING_KEY);
    return q;
  } catch {
    return '';
  }
}
