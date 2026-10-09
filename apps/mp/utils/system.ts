/**
 * 系统信息（状态栏高度 / 顶部避让）
 *
 * ## 为什么需要它
 *
 * 首页是**自定义导航**（`pages/home/index.json` 里的 `navigationStyle: "custom"`），
 * 顶部避让只能自己做。此前用的是 CSS 的 `env(safe-area-inset-top)`，但
 * **微信小程序的 Android WebView 根本不注入这个变量（恒为 0）**，iOS 上部分基础库
 * 同样返回 0 —— 于是 `$nav-height: 88rpx`（只有导航条内容高度、不含状态栏）
 * 成了唯一高度，标题被顶到屏幕最上沿、被状态栏压住（2026-09-20 真机截图）。
 *
 * 结论：**顶部避让只能用 JS 读到的 `statusBarHeight`**。它由系统给出，
 * 刘海屏 / 挖孔屏的高度已经含在里面，不需要按机型写死；CSS 的 `env()` 只留作兜底。
 *
 * 底部安全区（`env(safe-area-inset-bottom)`）不在本文件范围内 —— 它在各家 WebView
 * 上都可靠，且语义是"有就避让、没有也无所谓"，继续用 CSS 即可。
 */

/** 读不到系统信息时的兜底高度（px）。宁可有间距，也不要让内容贴到屏幕顶 */
const FALLBACK_STATUS_BAR = 24;

/**
 * 从系统信息对象里取状态栏高度（纯函数，便于单测）。
 *
 * `IAppOption.globalData.systemInfo` 声明为 `unknown`，所以这里逐层校验：
 * 字段缺失、类型不对、非正数，一律退回 `fallback`。
 *
 * @param info      `wx.getWindowInfo()` / `wx.getSystemInfoSync()` 的返回值
 * @param fallback  取不到时的返回值（默认 24px）
 */
export function readStatusBarHeight(info: unknown, fallback = FALLBACK_STATUS_BAR): number {
  if (!info || typeof info !== 'object') return fallback;
  const { statusBarHeight } = info as { statusBarHeight?: unknown };
  if (typeof statusBarHeight !== 'number' || !Number.isFinite(statusBarHeight)) return fallback;
  return statusBarHeight > 0 ? statusBarHeight : fallback;
}

/** 现场读一次系统信息；老基础库退回 `getSystemInfoSync`，都失败返回 null */
function readWindowInfo(): unknown {
  try {
    return wx.getWindowInfo();
  } catch {
    try {
      return wx.getSystemInfoSync();
    } catch {
      return null;
    }
  }
}

/**
 * 状态栏高度（px）。
 *
 * 优先用 `app.ts` 启动时存在 `globalData` 里的那份（`onLaunch` 早于页面 `onLoad`，
 * 到这里一定就绪），缺失时现场读一次，仍拿不到才用兜底值。
 */
export function statusBarHeight(): number {
  const cached = readStatusBarHeight(getApp<IAppOption>().globalData.systemInfo, 0);
  if (cached > 0) return cached;
  return readStatusBarHeight(readWindowInfo(), FALLBACK_STATUS_BAR);
}

/**
 * 页面根节点的内联样式：把状态栏高度挂成 CSS 变量 `--qz-sb`。
 *
 * 为什么走 CSS 变量、而不是给 `.nav` 直接写内联 padding：
 * 页面里有**多处**需要避让顶部的元素（`.nav` 是 fixed、`.hero` 是普通容器），
 * 变量挂在根节点上两处都能继承到，也不会因为将来漏改某一处而再次错位。
 */
export function statusBarStyle(): string {
  return `--qz-sb:${statusBarHeight()}px;`;
}
