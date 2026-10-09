/**
 * 行程规划（旅行小工具）
 *
 * ## 为什么是本地页面而不是工具箱工具
 *
 * 与绩点 / AA 分账 / 抽签同因：工具箱的"同步"路径**仍会建作业记录并预扣积分**，
 * 而排行程是零副作用的编辑操作 —— 存本地、离线可用、不占额度才对。
 *
 * ## 这一版是"地基"，不是最终形态
 *
 * 截图里那种行程详情有两块增强，都**还没有**（刻意不做，不占位、不显示"待接入"）：
 *   · **地图算距离耗时**（"867 米 步行 11 分钟"）—— 必须来自地图服务，凭空写就是编造；
 *   · **AI 帮你排** —— 要走 `EventPlanner` Agent（当前未实现）。
 * 但这两块都要求先有"一份行程长什么样"，所以先把数据模型与编辑/展示做扎实。
 *
 * ## 唯一数据源是模块级的 `trip`，不是 `data`
 *
 * `trip` 不参与渲染（渲染靠 `refresh()` 算出的派生字段），把它放进 `data`
 * 只会让每次 `setData` 都白传一整棵树。所以：**改 `trip` → 调 `refresh()`**，
 * 只有 `refresh()` 会写 `data`。
 *
 * ## 输入框不会因为 `setData` 失焦
 *
 * 列表用 `wx:key="id"`（稳定键），`setData` 时节点被复用而不是重建。
 * ⚠️ 所以**站点 id 必须在编辑期间保持不变** —— 每次 `refresh` 重新生成 id
 * 会让输入框在每敲一个字后失焦（这是小程序里最典型的一类"输入框吃掉字符"）。
 *
 * ## 算法不在这里
 *
 * 全在 `utils/trip.ts`（纯函数、30 条单测）：时间解析与格式化、排序、冲突检测、
 * 反序列化校验。页面只负责收集输入与把结果摆到 data 上。
 */
import { mapApi } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import {
  conflictIds,
  dateRangeText,
  dayStats,
  formatDistance,
  formatDuration,
  isNextDay,
  parseTrip,
  sortStops,
  stopEndMinutes,
  type Trip,
  type TripDay,
  type TripLeg,
  type TripStop,
} from '../../utils/trip';

/** 本地存储键。带版本号：结构变了就换 key，旧数据自然作废，不做迁移。 */
const STORAGE_KEY = 'qz_trip_v1';

/** 上限：一天再多就不是"走得完"的行程，一次行程也不会超过一个月 */
const MAX_STOPS_PER_DAY = 20;
const MAX_DAYS = 30;

/**
 * 当前行程（**唯一数据源**）。
 *
 * 放在模块级而不是 `data`：它不参与渲染，每次 `setData` 都传一遍整棵树是纯浪费。
 * 页面重进时 `onLoad` 会用 `loadTrip()` 覆盖它，不会残留上一次的状态。
 */
let trip: Trip = { city: '', days: [] };

let seq = 0;
const nextId = (p: string): string => `${p}${Date.now().toString(36)}${(seq += 1).toString(36)}`;

/** 搜到坐标的站点（算路用） */
interface LocatedStop {
  id: string;
  location: { lng: number; lat: number };
}

/** 坐标 → 接口要求的 `lng,lat` */
const coord = (p: { lng: number; lat: number }): string => `${p.lng},${p.lat}`;

/** 展示行：WXML 不能调函数，所有文案与状态都在 `refresh()` 里先算好 */
interface StopRow {
  id: string;
  name: string;
  address: string;
  /** time picker 的当前值（`HH:mm` 或空串） */
  arriveAt: string;
  stayMinutes: number;
  /** "10:00" / "10:00 次日" / "未定时间" */
  timeText: string;
  /** "停留 1 小时" / "未定停留" */
  stayText: string;
  /** 与前一站时间重叠 */
  conflict: boolean;
  /** 最后一站不画下方连线 */
  last: boolean;
  /** 从上一站到这里的路程："约 3.6 公里 · 59 分钟"；空串 = 还没算过（第一站恒为空） */
  legText: string;
}

interface DayTab {
  id: string;
  label: string;
  sub: string;
}

const emptyDay = (): TripDay => ({ id: nextId('d'), date: '', stops: [] });

const emptyStop = (): TripStop => ({
  id: nextId('s'),
  name: '',
  address: '',
  arriveAt: '',
  stayMinutes: 0,
});

/** 读本地行程。存储可能被历史版本写坏，`parseTrip` 会逐条校验并丢掉坏数据。 */
function loadTrip(): Trip {
  try {
    return parseTrip(wx.getStorageSync(STORAGE_KEY));
  } catch {
    // 存储不可用（隐私模式 / 配额满）时当作空行程，而不是让页面打不开
    return { city: '', days: [] };
  }
}

function saveTrip(): void {
  try {
    wx.setStorageSync(STORAGE_KEY, trip);
  } catch {
    wx.showToast({ title: '本地保存失败，本次改动可能不保留', icon: 'none' });
  }
}

/** `YYYY-MM-DD` → `7月23日`（只用于展示，非法输入返回空串） */
function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[2])}月${Number(m[3])}日` : '';
}

/**
 * 路程文案。
 *
 * ⚠️ 单位换算只在这一处做：`leg.durationSeconds` 是**秒**，而 `formatDuration` 收**分钟** ——
 * 忘了除 60 会把"59 分钟"显示成"59 小时"，而那个数字看起来只是"有点久"，
 * 不会让人想到是换算错了。
 */
function formatLeg(leg: TripLeg | undefined): string {
  if (!leg) return '';
  const minutes = Math.round(leg.durationSeconds / 60);
  return `约 ${formatDistance(leg.distanceMeters)} · ${formatDuration(minutes)}`;
}

/** 一站的展示文案 */
function toStopRow(stop: TripStop, conflict: boolean, last: boolean): StopRow {
  const end = stopEndMinutes(stop);
  let timeText = '未定时间';
  if (stop.arriveAt) {
    timeText = end !== null && isNextDay(end) ? `${stop.arriveAt} 次日` : stop.arriveAt;
  }
  return {
    id: stop.id,
    name: stop.name,
    address: stop.address,
    arriveAt: stop.arriveAt,
    stayMinutes: stop.stayMinutes,
    timeText,
    stayText: stop.stayMinutes > 0 ? `停留 ${formatDuration(stop.stayMinutes)}` : '未定停留',
    conflict,
    last,
    legText: formatLeg(stop.leg),
  };
}

Page({
  data: {
    fxStyle: '',
    city: '',
    /** 日期范围文案："7月23日 - 7月26日" */
    rangeText: '',
    dayTabs: [] as DayTab[],
    activeIndex: 0,
    /** 当前这天的日期（date picker 的值） */
    activeDate: '',
    stops: [] as StopRow[],
    /** 当天统计："3 站 · 共 4 小时 30 分" */
    statsText: '',
    /** 只有一天时不给删除按钮（删完一天等于把页面清空） */
    canRemoveDay: false,
    /** 正在算路（按钮禁用 + 文案变化） */
    calculating: false,
    /** 算路用的出行方式 */
    mode: 'walking' as 'walking' | 'driving',
    /** 算路后的如实提示（如"2 个地点没找到坐标，已跳过"） */
    calcHint: '',
  },

  onLoad() {
    trip = loadTrip();
    // 首次进入给一天：否则页面无处下手，用户还得先找"怎么加一天"
    if (!trip.days.length) trip.days = [emptyDay()];
    this.refresh(0);
  },

  /* ---------- 装饰视差（倾斜只在 onShow 开，onHide 关；只动装饰层） ---------- */

  onShow() {
    fxEnableTilt(this);
  },

  onHide() {
    fxDisableTilt();
  },

  onFxStart(e: WechatMiniprogram.TouchEvent) {
    fxStart(this, e);
  },

  onFxMove(e: WechatMiniprogram.TouchEvent) {
    fxMove(this, e);
  },

  onFxEnd() {
    fxEnd(this);
  },

  /* ---------- 目的地 ---------- */

  onCityInput(e: WechatMiniprogram.Input) {
    trip.city = e.detail.value;
    this.setData({ city: trip.city }, () => saveTrip());
  },

  /* ---------- 天 ---------- */

  onDayTap(e: WechatMiniprogram.TouchEvent) {
    this.refresh(Number((e.currentTarget.dataset as { index: string }).index));
  },

  onAddDay() {
    if (trip.days.length >= MAX_DAYS) {
      wx.showToast({ title: `一次行程最多 ${MAX_DAYS} 天`, icon: 'none' });
      return;
    }
    trip.days.push(emptyDay());
    this.refresh(trip.days.length - 1);
  },

  onRemoveDay() {
    const index = this.data.activeIndex;
    if (trip.days.length <= 1) return;
    wx.showModal({
      title: `删除 Day ${index + 1}？`,
      content: `这一天排的 ${trip.days[index].stops.length} 站会一起删掉，不能撤销。`,
      confirmText: '删除',
      success: (res) => {
        if (!res.confirm) return;
        trip.days.splice(index, 1);
        this.refresh(Math.max(0, index - 1));
      },
    });
  },

  onDayDateChange(e: WechatMiniprogram.PickerChange) {
    trip.days[this.data.activeIndex].date = String(e.detail.value);
    this.refresh(this.data.activeIndex);
  },

  /* ---------- 站点 ---------- */

  onAddStop() {
    const day = trip.days[this.data.activeIndex];
    if (day.stops.length >= MAX_STOPS_PER_DAY) {
      wx.showToast({ title: `一天最多 ${MAX_STOPS_PER_DAY} 站`, icon: 'none' });
      return;
    }
    day.stops.push(emptyStop());
    this.refresh(this.data.activeIndex);
  },

  onRemoveStop(e: WechatMiniprogram.TouchEvent) {
    const id = (e.currentTarget.dataset as { id: string }).id;
    const day = trip.days[this.data.activeIndex];
    day.stops = day.stops.filter((s) => s.id !== id);
    this.refresh(this.data.activeIndex);
  },

  onStopNameInput(e: WechatMiniprogram.Input) {
    this.patchStop((e.currentTarget.dataset as { id: string }).id, { name: e.detail.value });
  },

  onStopAddressInput(e: WechatMiniprogram.Input) {
    this.patchStop((e.currentTarget.dataset as { id: string }).id, { address: e.detail.value });
  },

  onStopTimeChange(e: WechatMiniprogram.PickerChange) {
    this.patchStop((e.currentTarget.dataset as { id: string }).id, {
      arriveAt: String(e.detail.value),
    });
  },

  /**
   * 停留时长。
   *
   * 非数字 / 负数 / 超过 24 小时一律夹到合法区间 ——
   * 让 `NaN` 混进后面的时间计算，会让"结束时间"变成 `NaN`，
   * 而 `formatTime(NaN)` 会显示成 `NaN:NaN`，看起来像页面坏了。
   */
  onStopStayInput(e: WechatMiniprogram.Input) {
    const raw = Number(e.detail.value);
    const minutes = Number.isFinite(raw) && raw > 0 ? Math.min(Math.round(raw), 24 * 60) : 0;
    this.patchStop((e.currentTarget.dataset as { id: string }).id, { stayMinutes: minutes });
  },

  /* ---------- 内部 ---------- */

  /* ---------- 算每段路（联网，用户主动触发） ---------- */

  /**
   * 切换出行方式。
   *
   * ⚠️ 换方式后**旧结果一律清空** —— "步行 3.6 公里"在切换成驾车后就不成立了
   * （同一条路驾车是 5.9 公里）。留着它会显示一段不存在的路程，
   * 而界面上完全看不出来。**不自动重算**：那会在用户没要求时静默消耗地图配额。
   */
  onToggleMode() {
    const mode = this.data.mode === 'walking' ? 'driving' : 'walking';
    for (const day of trip.days) for (const stop of day.stops) delete stop.leg;
    this.setData({ mode, calcHint: '' }, () => this.refresh(this.data.activeIndex));
  },

  /**
   * 算每段路。
   *
   * 流程：**先搜坐标**（`/map/places`）→ 再逐段算（`/map/route`）。
   *
   * ⚠️ 三条刻意的取舍：
   *   1. **用户主动点**才联网 —— 行程页的定位是"纯本地小工具"，
   *      不该进页面就自动发请求（那会让它变成必须联网才能用）；
   *   2. **搜不到坐标的站点直接跳过**，并如实告诉用户跳过了几处 ——
   *      编一个坐标出来，会让"3.6 公里"变成彻头彻尾的假数据；
   *   3. **相邻段调 N−1 次**：后端的 `/map/route` 是"一个起点 → 多个终点"，
   *      而这里要的是"链上相邻两段"，用不上批量
   *      （批量留给"AI 生成行程时比较多个候选"那种场景）。
   */
  async onCalcLegs() {
    // 防重复点击：算路要串行发好几次请求，期间再点会并发出去（白耗配额）
    if (this.data.calculating) return;

    const day = trip.days[this.data.activeIndex];
    const named = day.stops.filter((s) => s.name.trim());
    if (named.length < 2) {
      wx.showToast({ title: '至少要有两个写了名字的地点', icon: 'none' });
      return;
    }

    this.setData({ calculating: true, calcHint: '' });
    try {
      const located = await this.locateAll(named);
      const { done, skipped } = await this.fillLegs(day, located);
      this.setData({ calcHint: this.hintText(done, skipped) });
    } catch (err) {
      const msg = (err as { message?: string })?.message ?? '算路失败，请稍后重试';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ calculating: false }, () => this.refresh(this.data.activeIndex));
    }
  },

  /**
   * 逐个搜坐标。
   *
   * **串行**而不是 `Promise.all`：并发会撞后端限流（`ThrottlerGuard`），
   * 而一次算路通常只有几站，串行的额外耗时（每站约几百毫秒）远小于
   * "并发被限流后整批失败"的代价。
   */
  async locateAll(stops: TripStop[]): Promise<LocatedStop[]> {
    const out: LocatedStop[] = [];
    for (const stop of stops) {
      const hits = await mapApi.places(stop.name, { limit: 1 });
      const location = hits[0]?.location;
      if (location) out.push({ id: stop.id, location });
    }
    return out;
  },

  /** 逐段算并写回 `leg`；返回算成几段、因缺坐标跳过几处 */
  async fillLegs(day: TripDay, located: LocatedStop[]): Promise<{ done: number; skipped: number }> {
    let done = 0;
    for (let i = 1; i < located.length; i += 1) {
      const res = await mapApi.route(coord(located[i - 1].location), [coord(located[i].location)], this.data.mode);
      const est = res.estimates[0];
      const stop = day.stops.find((s) => s.id === located[i].id);
      if (!stop) continue;
      // 算不出就**清掉旧的** —— 留着会显示一段已经不成立的路程
      stop.leg = est
        ? {
            distanceMeters: est.distanceMeters,
            durationSeconds: est.durationSeconds,
            mode: this.data.mode,
            at: new Date().toISOString(),
          }
        : undefined;
      if (est) done += 1;
    }
    return { done, skipped: day.stops.length - located.length };
  },

  /** 算完后的如实提示（**不把"跳过"藏起来**） */
  hintText(done: number, skipped: number): string {
    const bits = [`算了 ${done} 段`];
    if (skipped > 0) bits.push(`${skipped} 个地点没找到坐标，已跳过`);
    return bits.join(' · ');
  },

  /** 改一站并重算（按 id 定位，所以展示层排序过也没关系） */
  patchStop(id: string, patch: Partial<TripStop>) {
    const day = trip.days[this.data.activeIndex];
    day.stops = day.stops.map((s) => (s.id === id ? { ...s, ...patch } : s));
    this.refresh(this.data.activeIndex);
  },

  /**
   * 重算全部展示字段并落盘。
   *
   * 站点按**到达时间排序**后展示（时间轴的本义）；未定时间的站排在最后。
   * 排序只影响展示，`trip.days[i].stops` 保持用户的添加顺序 ——
   * 否则"没定时间的站"会在每次编辑后跳来跳去。
   */
  refresh(index: number) {
    const i = Math.min(Math.max(0, index), trip.days.length - 1);
    const day = trip.days[i];
    const sorted = sortStops(day.stops);
    const conflicts = new Set(conflictIds(day));
    const stats = dayStats(day);

    saveTrip();

    this.setData({
      city: trip.city,
      dayTabs: trip.days.map((d, idx) => ({
        id: d.id,
        label: `Day ${idx + 1}`,
        sub: shortDate(d.date),
      })),
      activeIndex: i,
      activeDate: day.date,
      stops: sorted.map((s, idx) => toStopRow(s, conflicts.has(s.id), idx === sorted.length - 1)),
      statsText: stats.stops ? `${stats.stops} 站 · 共 ${formatDuration(stats.totalMinutes)}` : '',
      rangeText: dateRangeText(trip.days),
      canRemoveDay: trip.days.length > 1,
    });
  },
});
