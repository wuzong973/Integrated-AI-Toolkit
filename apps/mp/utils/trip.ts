/**
 * 旅行行程模型与纯函数（不依赖 wx API）
 *
 * ## 为什么放在小程序侧
 *
 * 与 `utils/gpa.ts` / `utils/split-bill.ts` / `utils/lottery.ts` 同一条约束：
 * **小程序不能 `import @qz/core`**（`packNpmRelationList` 是空的）。
 *
 * ## 为什么先做"排表"这一层，而不是先接 AI 或地图
 *
 * 截图里那个"行程详情"的价值分两半：**AI 帮你排** 与 **地图帮你算距离耗时**。
 * 但这两半都要求先有"一份行程长什么样"—— 没有它，AI 的输出没处落、地图的耗时没处挂。
 * 所以这一层是**不可跳过的地基**，而且它本身就能用：手动记行程、承接 AI 生成的草稿、
 * 导出给同行的人看。
 *
 * ⚠️ 刻意**不做**的两件事（等真有数据源再说，不占位、不显示"待接入"）：
 *   · **交通段**（"867 米 步行 11 分钟"）—— 那必须来自地图服务，凭空写就是编造；
 *   · **AI 生成** —— 要走 `EventPlanner` Agent（当前未实现）。
 *
 * ## 时间一律用 `HH:mm` 字符串，不用 `Date` 对象
 *
 * 行程时间是**当地墙上时间**（"14:44 到武侯祠"），没有时区含义，
 * 用 `Date` 只会引入时区与夏令时的干扰。存字符串、算的时候转成"从零点起的分钟数"，
 * 两端都简单且可测。
 *
 * ## 跨午夜是正常情况，不是异常
 *
 * 23:30 到店、停留 90 分钟 → 结束时间是**次日 01:00**。
 * 所以内部一律用"可以超过 1440 的分钟数"，只在格式化时对 1440 取模并标出"次日"。
 * 若在这里取模，冲突检测会把"次日 00:30"误判成"今天 00:30"，把两段不冲突的行程标成冲突。
 */

/** 一天的分钟数 */
const DAY_MINUTES = 24 * 60;

/**
 * 从**上一站到本站**的通行估算。
 *
 * ⚠️ 它是**外部事实**（地图服务算的），不是用户的编辑内容 ——
 * 所以带 `at` 时间戳：路况会变，界面必须说清"这是什么时候算的"，
 * 而不是把它当成永远正确的属性。
 *
 * ⚠️ 单位：**米 / 秒**（字段名写死单位，不给"猜"的机会）。
 */
export interface TripLeg {
  distanceMeters: number;
  durationSeconds: number;
  mode: 'walking' | 'driving';
  /** 算出来的时刻（ISO 字符串） */
  at: string;
}

/** 行程中的一站 */
export interface TripStop {
  id: string;
  /** 地点名（如「武侯祠」） */
  name: string;
  /** 地址 / 补充说明，可空 */
  address: string;
  /** 到达时间 `HH:mm`；**空串表示还没定时间** */
  arriveAt: string;
  /** 计划停留时长（分钟）；`0` 表示还没定 */
  stayMinutes: number;
  /** 从上一站到这里的通行估算；`undefined` = 还没算过（第一站永远没有） */
  leg?: TripLeg;
}

/** 一天 */
export interface TripDay {
  id: string;
  /** 日期 `YYYY-MM-DD`；空串表示还没定 */
  date: string;
  stops: TripStop[];
}

/** 一趟行程 */
export interface Trip {
  /** 目的地城市（如「成都」） */
  city: string;
  days: TripDay[];
}

/** `HH:mm` → 从零点起的分钟数；非法返回 `null`（不返回 0 那种会误导的值） */
export function parseTime(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 分钟数 → `HH:mm`（超过一天的会自动进位，由调用方决定要不要标"次日"） */
export function formatTime(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 是否跨到了次日（结束时间超过 24:00） */
export function isNextDay(minutes: number): boolean {
  return minutes >= DAY_MINUTES;
}

/**
 * 分钟数 → 人话时长。
 *
 * ⚠️ 0 与 1 单独说人话（同 `utils/countdown.ts` 的 `countdownText`）：
 * 「0 分钟」「1 分钟」读起来像机器，而"不用停留""就一会儿"才是人真正想表达的。
 */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m === 0) return '未定';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} 小时` : `${h} 小时 ${rest} 分`;
}

/**
 * 距离 → 人话。
 *
 * ⚠️ 1 公里以下说"米"、以上说"公里"：`5951 米` 要在脑子里换算，`6.0 公里` 不用。
 * 但**不四舍五入掉短距离** —— `1 米` 是真实结果（高德对同一个点就返回 1 米）。
 */
export function formatDistance(meters: number): string {
  const m = Math.max(0, Math.round(meters));
  return m < 1000 ? `${m} 米` : `${(m / 1000).toFixed(1)} 公里`;
}

/** 一站的结束时间（分钟数）；时间或时长未定时返回 `null` */
export function stopEndMinutes(stop: TripStop): number | null {
  const start = parseTime(stop.arriveAt);
  if (start === null || stop.stayMinutes <= 0) return null;
  return start + stop.stayMinutes;
}

/**
 * 按到达时间排序。
 *
 * 没有时间的站**排在最后**（而不是当成 00:00 排到最前）——
 * 把"还没定"当成"最早"会让用户以为它是一天的第一站。
 * 未定时间的站之间保持原有相对顺序（`Array.prototype.sort` 自 ES2019 起稳定）。
 */
export function sortStops(stops: readonly TripStop[]): TripStop[] {
  const key = (s: TripStop): number => parseTime(s.arriveAt) ?? Number.POSITIVE_INFINITY;
  return stops.slice().sort((a, b) => key(a) - key(b));
}

/**
 * 时间重叠的站点 id。
 *
 * 判据：按时间排好后扫一遍，维护"当前已被占用的最晚结束时间"；
 * 若某站的开始时间早于它，这一站就与前序行程撞了。
 *
 * ⚠️ 只标出**后一站**（冲突的责任通常在"排得太满"的那一站上），
 * 且**未定时间的站一律不参与判断** —— 拿空时间去比大小只会制造假冲突。
 */
export function conflictIds(day: TripDay): string[] {
  const out: string[] = [];
  let cursor = -1;
  for (const stop of sortStops(day.stops)) {
    const start = parseTime(stop.arriveAt);
    if (start === null) continue;
    if (start < cursor) out.push(stop.id);
    const end = stopEndMinutes(stop);
    cursor = Math.max(cursor, end ?? start);
  }
  return out;
}

/** 一天的统计（只算已定时间的站） */
export function dayStats(day: TripDay): { stops: number; totalMinutes: number } {
  const totalMinutes = day.stops.reduce((sum, s) => {
    const start = parseTime(s.arriveAt);
    if (start === null) return sum;
    return sum + Math.max(0, stopEndMinutes(s) ?? start) - start;
  }, 0);
  return { stops: day.stops.length, totalMinutes };
}

/** 日期范围文案：「7月23日 - 7月26日」；没有日期返回空串 */
export function dateRangeText(days: readonly TripDay[]): string {
  const dates = days.map((d) => d.date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (!dates.length) return '';
  const short = (iso: string): string => {
    const [, m, d] = iso.split('-');
    return `${Number(m)}月${Number(d)}日`;
  };
  const first = short(dates[0]);
  const last = short(dates[dates.length - 1]);
  return first === last ? first : `${first} - ${last}`;
}

/* ---------- 反序列化：存储里的东西一律当成不可信输入 ---------- */

const isText = (v: unknown): v is string => typeof v === 'string';

/** 时间归一化：非法或缺失时降级成"还没定"（空串），**而不是丢掉整站** */
function toTime(raw: unknown): string {
  return isText(raw) && parseTime(raw) !== null ? raw : '';
}

/** 时长归一化：非有限数当 0，负数夹到 0，四舍五入到整分钟 */
function toStay(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.round(raw));
}

/**
 * 通行估算校验。
 *
 * ⚠️ 形状不对就**返回 undefined**（这一站显示"还没算"），而不是编一个 0 ——
 * `0 米 / 0 分钟`在界面上看起来像"就在原地"，是比"没算过"更糟的谎。
 */
function toLeg(raw: unknown): TripLeg | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { distanceMeters, durationSeconds, mode, at } = raw as TripLeg;
  if (!Number.isFinite(distanceMeters) || !Number.isFinite(durationSeconds)) return undefined;
  if (distanceMeters < 0 || durationSeconds < 0) return undefined;
  return {
    distanceMeters: Math.round(distanceMeters),
    durationSeconds: Math.round(durationSeconds),
    mode: mode === 'driving' ? 'driving' : 'walking',
    at: isText(at) ? at : '',
  };
}

/** 单站校验：不合规返回 `null`（调用方直接丢） */
function toStop(raw: unknown): TripStop | null {
  if (!raw || typeof raw !== 'object') return null;
  const { id, name, address, arriveAt, stayMinutes, leg } = raw as TripStop;
  // ⚠️ `name` **允许是空串**（只要字段存在）：用户点"添加一站"时它就是空的，
  // 若在这里丢掉，用户下次打开会发现"我加的站没了" —— 编辑中的空站是正常状态。
  // 只有 `name` 字段**根本不是字符串**（数据损坏）才丢；界面负责显示"未命名地点"占位。
  if (!isText(id) || !id.trim() || !isText(name)) return null;
  return {
    id,
    name: name.trim(),
    address: isText(address) ? address.trim() : '',
    arriveAt: toTime(arriveAt),
    stayMinutes: toStay(stayMinutes),
    leg: toLeg(leg),
  };
}

/** 单日校验 */
function toDay(raw: unknown): TripDay | null {
  if (!raw || typeof raw !== 'object') return null;
  const { id, date, stops } = raw as TripDay;
  if (!isText(id) || !id.trim()) return null;
  const list = Array.isArray(stops) ? stops.map(toStop).filter((s): s is TripStop => s !== null) : [];
  return {
    id,
    date: isText(date) && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
    stops: list,
  };
}

/**
 * 反序列化整趟行程。
 *
 * **坏条目直接丢弃**，不抛错、不猜、不补默认值 —— 让页面永远能打开
 * （一次崩溃会让用户再也进不去，因为坏数据还在存储里）。
 * 重复 `id` 也只保留第一条：重复 key 会让列表渲染错乱，比丢一条更难查。
 */
export function parseTrip(raw: unknown): Trip {
  const empty: Trip = { city: '', days: [] };
  if (!raw || typeof raw !== 'object') return empty;
  const { city, days } = raw as Trip;

  const seen = new Set<string>();
  const out: TripDay[] = [];
  for (const item of Array.isArray(days) ? days : []) {
    const day = toDay(item);
    if (!day || seen.has(day.id)) continue;
    seen.add(day.id);
    out.push(day);
  }
  return { city: isText(city) ? city.trim() : '', days: out };
}
