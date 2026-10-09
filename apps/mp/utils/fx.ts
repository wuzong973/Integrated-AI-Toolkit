/**
 * 交互动效工具（任务：小程序视觉升级）
 *
 * 职责：给页面提供"随指针移动的动态响应"与"动效重播"能力，
 *       纯逻辑、无副作用渲染，页面只需在根节点绑定事件并透传 this。
 *
 * 用法（页面四步）：
 *   ① data 里加 `fxStyle: ''`
 *   ② 根节点：`bindtouchstart="onFxStart" bindtouchmove="onFxMove"
 *              bindtouchend="onFxEnd" bindtouchcancel="onFxEnd"`
 *   ③ 装饰层：`<view class="qz-fx" style="{{fxStyle}}"> … </view>`
 *   ④ 页面方法：`onFxStart(e) { fxStart(this, e) }` 等四行转发
 *   真机上再调一次 `fxEnableTilt(this)`，即可用陀螺仪做倾斜视差。
 *
 * 性能：位移写入做了 30fps 节流；只写 1 个内联 transform，不触发内容区重排。
 * 可读性：视差只作用于装饰层，内容区不跟随（规范硬要求）。
 */

/** 视差最大位移（rpx）。26 是"明显但不晃"的甜点值，超过 40 会让人晕 */
const FX_RANGE = 26;
/** 节流间隔（ms），约 30fps */
const FX_THROTTLE = 32;
/** 倾斜视差的灵敏度：分母越大越迟钝 */
const TILT_GAMMA_SPAN = 28;
const TILT_BETA_SPAN = 34;
/** 手机正常握持时 beta 大约在 40° 附近，以此为零点 */
const TILT_BETA_BASE = 40;

/** 页面宿主：只要能 setData 即可（Page 实例天然满足） */
export interface FxHost {
  setData(data: Record<string, unknown>): void;
}

let lastEmit = 0;
let winW = 0;
let winH = 0;
let tiltHost: FxHost | null = null;
/** 倾斜回调是否已绑定（**全局只绑一次**，否则每次页面 onShow 都会注册一个新监听器） */
let tiltListenerBound = false;
/** 传感器当前是否在采集 */
let tiltActive = false;
/** 当前环境是否不支持倾斜（开发者工具、或部分机型）。一旦确认不支持就不再重试 */
let tiltUnsupported = false;

function clamp(v: number, min = -1, max = 1): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/** 窗口尺寸只取一次，避免每次移动都调同步 API */
function winSize(): { w: number; h: number } {
  if (winW > 0 && winH > 0) return { w: winW, h: winH };
  try {
    const info = wx.getWindowInfo();
    winW = info.windowWidth;
    winH = info.windowHeight;
  } catch {
    try {
      const info = wx.getSystemInfoSync();
      winW = info.windowWidth;
      winH = info.windowHeight;
    } catch {
      winW = 375;
      winH = 667;
    }
  }
  return { w: winW, h: winH };
}

/** 把归一化位移写成装饰层的内联 transform（只写一个字段，开销最小） */
function emit(host: FxHost, nx: number, ny: number): void {
  const x = (nx * FX_RANGE).toFixed(2);
  const y = (ny * FX_RANGE).toFixed(2);
  host.setData({ fxStyle: `transform: translate3d(${x}rpx, ${y}rpx, 0)` });
}

/** 触摸/鼠标按下：立即响应，不等节流 */
export function fxStart(host: FxHost, e: WechatMiniprogram.TouchEvent): void {
  lastEmit = 0;
  fxMove(host, e);
}

/** 触摸/鼠标移动：以屏幕中心为原点映射到 -1~1 */
export function fxMove(host: FxHost, e: WechatMiniprogram.TouchEvent): void {
  const touch = e.touches && e.touches[0];
  if (!touch) return;

  const now = Date.now();
  if (now - lastEmit < FX_THROTTLE) return;
  lastEmit = now;

  const { w, h } = winSize();
  const nx = clamp((touch.clientX - w / 2) / (w / 2));
  const ny = clamp((touch.clientY - h / 2) / (h / 2));
  emit(host, nx, ny);
}

/** 抬手：缓缓回正 */
export function fxEnd(host: FxHost): void {
  emit(host, 0, 0);
}

/**
 * 开启陀螺仪倾斜视差。
 *
 * ⚠️ **`fail` 回调必须写，不能省**（这里踩过坑）：
 *   两个传感器 API 都是**异步回调式**的，失败不会抛异常、try/catch 抓不到。
 *   不传 `fail` 时 SDK 会把它当成未捕获异常打印成红色 `appServiceSDKError`
 *   （开发者工具里就是 `startDeviceMotionListening:fail 开发者工具暂时不支持此 API 调试`）
 *   —— 噪音会淹没真正的报错，而且看起来像代码崩了。
 *   倾斜视差只是**装饰增强**：不支持时触摸视差照常工作，因此这里静默降级。
 */
export function fxEnableTilt(host: FxHost): void {
  tiltHost = host;
  if (tiltUnsupported) return;

  // 监听器全局只绑一次；重复绑定会让同一个数据被 N 个回调处理，且无法解绑
  if (!tiltListenerBound) {
    wx.onDeviceMotionChange((res) => {
      const target = tiltHost;
      if (!target) return;

      const now = Date.now();
      if (now - lastEmit < FX_THROTTLE) return;
      lastEmit = now;

      const nx = clamp((res.gamma ?? 0) / TILT_GAMMA_SPAN);
      const ny = clamp(((res.beta ?? 0) - TILT_BETA_BASE) / TILT_BETA_SPAN);
      emit(target, nx, ny);
    });
    tiltListenerBound = true;
  }

  if (tiltActive) return;
  wx.startDeviceMotionListening({
    interval: 'normal',
    success: () => {
      tiltActive = true;
    },
    fail: () => {
      tiltUnsupported = true;
    },
  });
}

/**
 * 页面隐藏时调用：停止采集并解除宿主。
 * 这里要真的 `stop`，不能只把宿主置空 —— 那样传感器会一直开着耗电，
 * 而注释写着"避免后台继续接收传感器数据"，行为与注释必须一致。
 */
export function fxDisableTilt(): void {
  tiltHost = null;
  if (!tiltActive) return;
  tiltActive = false;
  // 同样必须传 fail：停采集在未开启/不支持的环境下会失败
  wx.stopDeviceMotionListening({ fail: () => undefined });
}

/**
 * 重播入场动画：先关掉开关再打开，让 CSS 动画重新跑一遍。
 * 用于 Tab 切换、筛选条件变化等"内容整体换了一批"的场景。
 */
export function replayAnim(host: FxHost, field = 'animOn'): void {
  host.setData({ [field]: false });
  setTimeout(() => host.setData({ [field]: true }), 32);
}

/**
 * 列表逐项延迟类名（配合 motion.scss 的 `.qz-d1` ~ `.qz-d8`）。
 *
 * WXML 不能调函数，所以在造列表数据时把结果塞进每一行（`anim: staggerClass(i)`），
 * 模板里 `class="… {{item.anim}}"` 渲染 —— 既有样板见 `pages/station`。
 *
 * `anim` 传 `'qz-an-spring'` 就是**逐条弹性向上滑入**（上浮 + 过冲落定），
 * 默认 `'qz-an-in'` 保持原有的分区上浮语气。第 8 项之后延迟封顶，
 * 否则长列表尾项要等半秒才动，看起来像卡住。
 */
export function staggerClass(index: number, anim: 'qz-an-in' | 'qz-an-spring' = 'qz-an-in'): string {
  return `${anim} qz-d${Math.min(index + 1, 8)}`;
}
