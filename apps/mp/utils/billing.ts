/**
 * 计费模式（小程序侧）——价格该怎么显示，只看这里
 *
 * ## 背景
 *
 * 前期平台免费开放（`BILLING_ENABLED=false`），后期可能按积分计费。
 * 但界面上的价格位置有七八处（工具卡、执行页费用确认、结果页、积分页……），
 * 如果每处都写 `if (免费) {...} else {...}`，将来切换开关时必然漏改某处，
 * 出现"首页说免费、详情页说 5 积分"这种自相矛盾的界面。
 *
 * 所以：**价格相关的文案一律走本文件的两个函数**，页面里不再出现价格三元判断。
 *
 * ## 缓存必须会过期（曾经踩过的坑）
 *
 * 早期实现是"本地存储里有值就直接用、永不刷新"，结果是：
 * 只要某个时刻落过一次 `points`（例如后端当时确实开着计费、或当时接口不可用回落到了保守默认），
 * **之后每次启动都直接返回这个陈旧值，再也不请求接口** ——
 * 于是后端明明已经改成免费，用户却永远看到价格。
 * 这正是"前台展示与实际行为不一致"，而且现象诡异（接口返回 free，界面却是积分）。
 *
 * 现在改为：**缓存带时间戳、超过 TTL 就重新拉取**，且 `app.onLaunch` 会强制刷新一次。
 * 旧版本存储里没有时间戳，会被读成 0 → 判为过期 → 自动重新拉取（无需用户清缓存）。
 *
 * ## 为什么默认值是"按计费显示"（fail-safe）
 *
 * 拿不到配置时（断网、接口挂了、**后端还是旧版本没有这个接口**）必须选一个默认值：
 *   · 默认"免费"→ 若实际在计费，**用户会在没看到价格的情况下被扣费** → 不可接受；
 *   · 默认"计费"→ 若实际免费，用户看到价格但没被扣 → 只是多问一句，无害。
 * 因此**首次**拉取失败时按 `points` 处理。这是"宁可显得贵，也不能显得骗人"。
 * 注意这只影响"从未成功拉取过"的情况，不会让已缓存的正确值被覆盖。
 *
 * ## 与后端的关系
 *
 * 真相只有一份：后端的 `BillingService.enabled`（`BILLING_ENABLED` 环境变量），
 * 经 `GET /config/public` 暴露。前端**不猜、不配置第二份开关**。
 *
 * ## 积分账户界面：免费期整体不展示
 *
 * 免费开放期积分不参与任何扣费，把余额/流水摆出来只会让用户困惑
 *（"我有 120 积分，为什么显示免费？"）。所以整块积分账户 UI 由 `showPoints()` 控制，
 * 免费期一律隐藏。为此**所有含"积分"二字的文案都收敛在本文件**
 *（见文件末的"积分账户文案"区），这样：
 *   ① 界面里不可能出现"积分"字样（免费期这些块不渲染）；
 *   ② 可以用静态脚本断言"`apps/mp` 下除本文件外不含'积分'"，杜绝遗漏与回归。
 */
import { configApi } from './api';

export type BillingMode = 'free' | 'points';

/** 本地存储键：缓存上次成功拉取到的模式 */
const MODE_KEY = 'qz_billing_mode';
const NOTICE_KEY = 'qz_billing_notice';
const AT_KEY = 'qz_billing_mode_at';

/**
 * 缓存有效期。取 5 分钟是个折中：
 * 太短则每个页面都打一次接口（无谓请求），太长则运营改了开关后客户端迟迟不生效。
 * 冷启动另有 `app.onLaunch` 的强制刷新兜底，所以这里只管"长时间挂着不重启"的场景。
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** 兜底文案：与后端 `BILLING_FREE_NOTICE` 保持一致（仅用于配置拉取失败时） */
const FALLBACK_NOTICE = '限时免费开放中';

/** 进程内缓存（小程序生命周期内有效） */
let cachedMode: BillingMode | null = null;
let cachedNotice = FALLBACK_NOTICE;
/** 上次成功拉取的时间戳（0 = 未知/旧格式存储，一律视为过期） */
let cachedAt = 0;

/** 从本地存储恢复（避免冷启动时先闪一下价格） */
function restoreFromStorage(): void {
  if (cachedMode) return;
  try {
    const mode = wx.getStorageSync<string>(MODE_KEY);
    if (mode === 'free' || mode === 'points') {
      cachedMode = mode;
      const notice = wx.getStorageSync<string>(NOTICE_KEY);
      if (notice) cachedNotice = notice;
      // 旧版本没写过这个键 → 读到 undefined → cachedAt 保持 0 → 判为过期并重新拉取
      const at = wx.getStorageSync<number>(AT_KEY);
      cachedAt = typeof at === 'number' && at > 0 ? at : 0;
    }
  } catch {
    // 存储不可用（罕见）时忽略：后续会走接口拉取
  }
}

/** 写入本地存储（失败不影响本次使用） */
function persist(mode: BillingMode, notice: string): void {
  try {
    wx.setStorageSync(MODE_KEY, mode);
    wx.setStorageSync(NOTICE_KEY, notice);
    wx.setStorageSync(AT_KEY, cachedAt);
  } catch {
    // 存储写失败只影响"下次冷启动的体验"，不影响当前展示
  }
}

/** 缓存是否仍在有效期内 */
function isCacheFresh(): boolean {
  return cachedAt > 0 && Date.now() - cachedAt < CACHE_TTL_MS;
}

/**
 * 拉取并缓存计费模式。**可重复调用**（缓存新鲜则直接返回，不发请求）。
 * 页面 onLoad 里 `await loadBillingMode()` 之后就能同步用 `currentBillingMode()`。
 *
 * @param force 忽略缓存强制拉取。`app.onLaunch` 用它，保证每次冷启动都拿到真实模式。
 */
export async function loadBillingMode(force = false): Promise<BillingMode> {
  restoreFromStorage();
  if (cachedMode && !force && isCacheFresh()) return cachedMode;

  try {
    const cfg = await configApi.public();
    cachedMode = cfg.billing.enabled ? 'points' : 'free';
    cachedNotice = cfg.billing.notice || FALLBACK_NOTICE;
    cachedAt = Date.now();
    persist(cachedMode, cachedNotice);
  } catch {
    // 刻意不把失败记成"免费"：见文件头的 fail-safe 说明。
    // 已有缓存时保留旧值（哪怕是陈旧的），总比把价格闪回来强。
    if (!cachedMode) cachedMode = 'points';
  }
  return cachedMode;
}

/** 同步读取已知模式（未拉取过时按 fail-safe 返回 'points'） */
export function currentBillingMode(): BillingMode {
  restoreFromStorage();
  return cachedMode ?? 'points';
}

/** 当前是否免费开放（页面据此决定要不要显示"免费"角标） */
export function isBillingFree(): boolean {
  return currentBillingMode() === 'free';
}

/**
 * 免费期的完整说明文案（用于有空间展开的地方，如积分页的规则说明）。
 * 价格角标请用 `priceText()`（那边是短文案"免费"）。
 */
export function freeNotice(): string {
  restoreFromStorage();
  return cachedNotice || FALLBACK_NOTICE;
}

/**
 * 价格文案 —— **价格位置一律用它**。
 *
 * 免费开放期返回**"免费"**（短、直接，适合角标与费用行）；
 * 计费期返回"N 积分"，工具本身免费（price=0）时也返回"免费"。
 *
 * @param price 工具标价（积分）。注意：前端不要因为免费就把 price 改成 0，
 *              标价是恢复计费后的依据，应该原样保留在数据里。
 */
export function priceText(price: number): string {
  if (isBillingFree()) return '免费';
  return price > 0 ? `${price} 积分` : '免费';
}

/** 已消耗积分文案（结果页用）：免费期不能说"消耗了 N 积分" */
export function costText(cost: number): string {
  if (isBillingFree()) return '本次免费';
  return cost > 0 ? `消耗 ${cost} 积分` : '免费';
}

/**
 * 失败时的兜底文案。
 *
 * 免费期**不能出现"积分"二字**：既不能写"积分已退回"（压根没扣过），
 * 也不能写"未消耗积分"（用户会问"什么积分？"）。
 * 只有计费模式才提积分 —— 那时用户确实被扣过、也确实退回了。
 */
export function failureHint(): string {
  return isBillingFree() ? '本次免费，可以重新生成' : '积分已退回，可以重新生成';
}

/**
 * 是否展示"积分账户"相关的界面（余额、流水、如何获得）。
 *
 * 免费开放期返回 `false`：积分此刻不参与任何扣费，摆出来只会让用户困惑。
 * 切到计费模式后自动恢复 —— 页面用 `wx:if="{{showPoints}}"` 控制即可，
 * 不需要在各页写 `billingFree ? ... : ...` 的判断。
 */
export function showPoints(): boolean {
  return !isBillingFree();
}

// ---------- 积分账户文案（全站唯一出处） ----------
/**
 * ⚠️ **含"积分"二字的用户可见文案只允许写在本文件**。
 *
 * 原因有二：
 *   1. 免费期这些界面整体不渲染（`showPoints()` 为 false），所以界面里不会出现"积分"；
 *   2. 集中一处之后，可以用静态脚本断言"`apps/mp` 下除本文件外不含'积分'"
 *      （见 `scripts/dev/check-no-points-copy.mjs`），把"改漏一处"变成机器可查的失败，
 *      而不是等用户截图来发现。
 *
 * 新增含"积分"的界面文案时，请加在这里并由页面 import，不要在页面里直接写字面量。
 */

/** 「我的」页统计项标签 */
export const POINTS_STAT_LABEL = '积分';

/** 信用/积分页顶部副标题（计费模式版） */
export const POINTS_HEAD_SUB = '信用分、加减分规则与积分流水';

/**
 * 信用/积分页顶部副标题。
 * 免费期不能提"积分流水"——那个 Tab 根本不存在，提了用户会去找。
 */
export function creditHeadSub(): string {
  return isBillingFree() ? '信用分、加减分规则与流水' : POINTS_HEAD_SUB;
}

/** 积分 Tab 文案（带余额） */
export function pointsTabLabel(points: number): string {
  return `积分（${points}）`;
}

/** 「如何获得积分」卡片标题 */
export const POINTS_EARN_TITLE = '如何获得积分';

/** 流水区标题 / 副标题 */
export const POINTS_LEDGER_TITLE = '积分流水';
export const POINTS_LEDGER_SUB = '收入与消耗记录';

/** 流水空态 */
export const POINTS_EMPTY_TITLE = '暂无积分流水';
export const POINTS_EMPTY_TEXT = '签到、完成任务与首单奖励都会记录在这里';

/** 规则说明（仅计费模式展示） */
export const POINTS_RULES_TIP = '积分用于调用 AI 工具；签到积分 30 天有效';

/** 钱包页积分卡文案 */
export const POINTS_WALLET_LABEL = '可用积分 · 用于调用 AI 工具';
