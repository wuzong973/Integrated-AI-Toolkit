/**
 * 看板时间窗口与环比计算（任务清单 M3-20 · 管理后台数据看板）
 *
 * 职责：把「日环比 / 周环比 / 月环比」需要的**窗口边界**与**比率算法**从
 * `admin-dashboard.service.ts` 拆出来。拆开的理由是测试：窗口口径是纯计算，
 * 不拆就只能通过假数据库间接验证（边界差一天，假数据测不出来）；拆开后
 * `admin-dashboard.window.spec.ts` 直接拿确定时刻断言边界与比率，服务层只管发一次事务。
 *
 * ## 窗口口径（对齐微信统计页的「指标 + 日/周/月环比」，但日界用本地时区）
 *
 * - **本期** = `[锚点, now)`，锚点 = `startOfToday() - (days - 1) 天`，
 *   即「含今天的最近 `days` 个日历日」（days=1 就是今天 00:00 起）；
 * - **上期** = 本期整体**前移 `days` 天**，长度与本期完全相同，且按日历日对齐
 *   （今天周三 → 上期窗口的末日也是周三）。
 *
 * 为什么上期用「前移 days 天」而不是「紧贴本期起点的等长窗口」：
 * 后者会把窗口起点挪到昨天中午之类的位置，比的是"今天的上午 vs 昨天的下午"，
 * 星期几错位会让周末/工作日的波动被读成增长或下滑。前移整周期才是"较昨日同时段"。
 *
 * ## 本期为什么只写下界（`gte`），不写上界
 *
 * 本期右边界就是 `now`，库里不存在未来的 `createdAt`；而既有的 `newToday`
 * 用的就是 `{ gte: todayStart }`。若这里改成 `{ gte, lt: now }`，
 * 恰好落在 `now` 这一毫秒的新用户会进 `newToday` 却不进 `growth.day.current`，
 * 首页就会出现两个"今日新增"。少一个条件反而两个数天然一致。
 *
 * ## 上一周期为 0 时返回 `null`：不返回 Infinity，也不返回假的 100%
 *
 * 1. 环比的定义是 `(本期 - 上期) / 上期`，上期为 0 时**这个数没有值**，
 *    返回 Infinity 或"涨 100%"都是把未定义说成结论，属于红线 10（禁止假数据）那一路；
 * 2. 工程上也藏不住：响应是 JSON，`JSON.stringify(Infinity)` 与 `NaN` 都会变成 `null`。
 *    真把 Infinity 塞进字段，前端拿到的仍然是 `null`，只是**没人声明过** ——
 *    那比显式 `null` 更糟，因为它只在运行时才暴露；
 * 3. 因此这里显式返回 `null`，并把 `current` / `previous` 一起带上：
 *    前端渲染"上期基数为 0"时显示的是**原始计数**（如 `0 → 7`），不需要猜分母。
 *    特例：上期为 0 且本期为 0 → `rate = 0`，"没增长"是事实而不是未定义。
 */

/** 一天的毫秒数（与 `admin-dashboard.service.ts` 里 `weekAgo` 的算法同一套） */
const DAY_MS = 24 * 3600 * 1000;

/** 三个环比周期的天数：日 / 周 / 月（月按 30 天，与"近 30 天新增"口径一致） */
export const GROWTH_DAYS = { day: 1, week: 7, month: 30 } as const;

/** 环比窗口的四个边界（均为 Date，比较方式与 Prisma `createdAt` 过滤一致） */
export interface GrowthWindow {
  /** 周期天数：1 / 7 / 30 */
  days: number;
  /** 本期起点（本地日锚点） */
  from: Date;
  /** 本期右边界 = 计算时刻；本期计数只写下界，见文件头说明 */
  to: Date;
  /** 上期起点 = `from` 前移 `days` 天 */
  prevFrom: Date;
  /** 上期终点 = `to` 前移 `days` 天 */
  prevTo: Date;
}

/** 日 / 周 / 月三个环比窗口 */
export interface GrowthWindows {
  day: GrowthWindow;
  week: GrowthWindow;
  month: GrowthWindow;
}

/**
 * 单个环比数据点。
 *
 * `rate` 是**百分数**（20 表示 +20%，-8.345 → -8.3），保留 1 位小数，
 * 与微信统计页显示口径相同；上一周期为 0 时为 `null`（见文件头第 3 节）。
 */
export interface GrowthPoint {
  current: number;
  previous: number;
  rate: number | null;
}

/** 当天 00:00（服务端本地时区；看板是运营视图，按本地日切分更符合直觉） */
export function startOfToday(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 单个周期窗口：锚点含今天往前推 `days - 1` 天，上期整体前移 `days` 天 */
export function growthWindow(now: Date, todayStart: Date, days: number): GrowthWindow {
  const from = new Date(todayStart.getTime() - (days - 1) * DAY_MS);
  return {
    days,
    from,
    to: now,
    prevFrom: new Date(from.getTime() - days * DAY_MS),
    prevTo: new Date(now.getTime() - days * DAY_MS),
  };
}

/** 日 / 周 / 月三窗口（`new Date()` 只取一次，保证三个窗口的"现在"是同一时刻） */
export function growthWindows(now: Date, todayStart: Date): GrowthWindows {
  return {
    day: growthWindow(now, todayStart, GROWTH_DAYS.day),
    week: growthWindow(now, todayStart, GROWTH_DAYS.week),
    month: growthWindow(now, todayStart, GROWTH_DAYS.month),
  };
}

/** 保留 1 位小数（先乘后除，避免 `0.1 + 0.2` 那类浮点尾巴进到界面） */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 把两个计数算成一个环比数据点；`previous === 0` 的口径见文件头第 3 节 */
export function growthPoint(current: number, previous: number): GrowthPoint {
  if (previous === 0) {
    // 上期 0、本期 0 → 持平（0 是可信结论）；上期 0、本期有新增 → 比率未定义，返回 null。
    return { current, previous, rate: current === 0 ? 0 : null };
  }
  return { current, previous, rate: round1(((current - previous) / previous) * 100) };
}
