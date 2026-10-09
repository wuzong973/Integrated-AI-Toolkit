/**
 * 管理后台四页的共用件（概览 / 用户 / 认证审核 / 订单）
 *
 * ## 为什么单独成文件
 * 这四页是**同一个后台的四个 Tab**：Tab 条、权限闸门、「更新于」时钟、环比与金额的
 * 展示口径必须逐字一致，抄四份就一定漂四份（本项目在分类 id、工具状态上吃过同类亏）。
 * 本文件只做**展示与闸门**，不含任何业务判断 —— 状态能不能迁移、金额该怎么算，
 * 权威都在后端与 `@qz/core`，小程序 import 不到 core，所以这里只做"怎么如实显示"。
 *
 * ## 权限：fail closed
 * `gateAdmin()` 是四个页面的第一个动作。`isAdmin` 必须**严格等于 `true`** 才放行 ——
 * `undefined`（字段没给）、`'true'`（字符串）都不算。未通过时页面只渲染「没有权限」，
 * **一个 admin 请求都不发**。隐藏入口不是权限控制，这一层管的是"手打 URL 进来的人"。
 */
import type { AdminGrowthPoint, MeInfo } from '../../utils/api';
import { authApi } from '../../utils/api';
import { staggerClass } from '../../utils/fx';

/**
 * 金额格式化直接复用 `utils/split-bill` 里那份 `formatCents`（整数分 → 「12.34」）。
 * 小程序 import 不到 `@qz/core` 的 `money.ts`（要"构建 npm"才行），全仓因此只留了
 * 这一份 mp 侧实现 —— 后台再抄一份就是第三处漂移点，所以宁可跨目录引用它。
 * ⚠️ 页面里不得出现 `amount / 100` 这类浮点写法（红线：金额一律「分」整数）。
 */
export { formatCents as moneyText } from '../../utils/split-bill';

/** 一个 Tab：`key` 标记当前页，`url` 是 `wx.redirectTo` 的目标 */
export interface AdminTab {
  key: string;
  label: string;
  url: string;
}

/**
 * 四个 Tab 就是这四份页面。
 *
 * ⚠️ 来回切只能用 `redirectTo`（见 `openTab`）：`navigateTo` 会把四页叠成一叠，
 * 返回键要按四次才出得去后台，而这几页之间本来就没有"上一层"的语义。
 */
export const ADMIN_TABS: AdminTab[] = [
  { key: 'index', label: '概览', url: '/pkg-mine/admin/index' },
  { key: 'users', label: '用户', url: '/pkg-mine/admin/users/index' },
  { key: 'verifications', label: '认证审核', url: '/pkg-mine/admin/verifications/index' },
  { key: 'orders', label: '订单', url: '/pkg-mine/admin/orders/index' },
];

/** 内容区的四种阶段（首屏骨架 / 有数据 / 真的为空 / 加载失败可重试） */
export type Stage = 'loading' | 'list' | 'empty' | 'error';

/** 闸门阶段。`checking` 期间页面只有骨架，**一个 admin 请求都不发** */
export type GateStage = 'checking' | 'ok' | 'denied' | 'error';

/**
 * 指标卡（图三口径）：标签在上、大数字居中、口径说明在下，可选环比行。
 * `value` 一律是**已经格式化好的字符串**，WXML 里不做任何算术。
 */
export interface Metric {
  label: string;
  value: string;
  /** 这个数字的口径（后台数字最怕被读成别的含义） */
  hint: string;
  rates?: RateRow[];
  anim: string;
}

/** 一个分区：小节标题 + 若干指标卡 */
export interface Section {
  key: string;
  title: string;
  sub: string;
  /** 糖果图标类名（本页 SCSS 不定义它，尺寸由外层 .qz-ico 给） */
  icon: string;
  metrics: Metric[];
}

/** 待办条：`url` 为空表示这一格在小程序里没有可跳的页面（于是也不挂 .qz-lift） */
export interface TodoCell {
  label: string;
  value: string;
  hint: string;
  icon: string;
  url: string;
  anim: string;
}

/**
 * 取某个 Tab 的页面地址，可带查询串（待办条要"跳过去就把筛选带好"）。
 *
 * 地址只有 `ADMIN_TABS` 一处来源：概览里的跳转和 Tab 条各写一份的话，
 * 改路径时必然只改到一边（本项目在分类 id、工具状态上正是这样漂的）。
 */
export function tabUrl(key: string, query?: Record<string, string>): string {
  const tab = ADMIN_TABS.find((t) => t.key === key);
  if (!tab) return '';
  const pairs = Object.entries(query ?? {}).map(
    ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
  );
  return pairs.length ? `${tab.url}?${pairs.join('&')}` : tab.url;
}

/**
 * URL 上的筛选参数要**收敛到接口认得的值**。
 * 手打 `?status=anything` 不该被原样转发给后端（后端 zod 会整条判 400，
 * 用户看到的是"加载失败"），这里直接当没给。
 */
export function pickAllowed(raw: string | undefined, allowed: readonly string[]): string {
  return raw && allowed.includes(raw) ? raw : '';
}

/** Tab 条的一行：当前页高亮 + 逐条入场类名（WXML 不能调函数，类名在这里算好） */
export interface TabCell extends AdminTab {
  on: boolean;
  anim: string;
}

export function tabStrip(activeKey: string): TabCell[] {
  return ADMIN_TABS.map((tab, i) => ({ ...tab, on: tab.key === activeKey, anim: staggerClass(i) }));
}

/** 闸门结果。`denied` 与 `error` 是两件事：前者是"确实没权限"，后者是"没能问出来" */
export type Gate =
  | { stage: 'ok'; me: MeInfo }
  | { stage: 'denied' }
  | { stage: 'error'; error: string };

/**
 * 先问 `/auth/me` 再决定要不要拉后台数据。
 *
 * 这里**不**把"请求失败"当成"没权限" —— 网络抖一下就说人没权限是错的结论；
 * 失败分支回 `error`，由页面如实给错误条 + 重试。
 */
export async function gateAdmin(): Promise<Gate> {
  try {
    const me = await authApi.me();
    return me.isAdmin === true ? { stage: 'ok', me } : { stage: 'denied' };
  } catch (e) {
    return { stage: 'error', error: errorText(e, '身份验证失败，后台数据未加载') };
  }
}

/** 身份带上的两个展示字段：昵称与角色胶囊 */
export interface Band {
  adminName: string;
  roleChips: string[];
}

/**
 * `roles` 的取值来自 `@qz/core` 的 `Role` 枚举。
 * 认不出的角色**原样显示**，不折叠成"学生/服务者"里的某一个 ——
 * 后台界面里一个被吞掉的角色，等于运营看不到这个账号的真实身份。
 */
const ROLE_LABELS: Record<string, string> = {
  guest: '游客',
  student: '学生',
  provider: '服务者',
  organization: '组织方',
  merchant: '商户',
  admin: '管理员',
};

export function bandOf(me: MeInfo): Band {
  const name = me.nickname && me.nickname.trim() ? me.nickname : '（未设置昵称）';
  const chips = (me.roles ?? []).map((r) => ROLE_LABELS[r] ?? r);
  // roles 空列表时兜一枚「管理员」不算编造：闸门已经确认 isAdmin === true，
  // 而后端的 isAdmin 就是"存在状态为 active 的 admin 角色"推出来的（见 api-types 的注释）。
  return { adminName: name, roleChips: chips.length ? chips : ['管理员'] };
}

/** 环比一行。`cls` 只决定颜色，`text` 才是结论 —— 结论拿不到时写「不适用」而不是 0% */
export interface RateRow {
  label: string;
  text: string;
  cls: 'up' | 'down' | 'flat' | 'na';
  /** 上期 → 本期：比率不成立时，这两个实数就是仅存的信息 */
  window: string;
}

/**
 * `growth.rate` 的三种情况必须分开画（红线：不许把"算不出来"说成"没变化"）：
 *   · 整个 `growth` 字段没给 → 「—」（数据缺失，页面不做推测）
 *   · `rate === null`（上期基数为 0，比率无定义）→ 「不适用」，并把 `0 → 7` 原样列出
 *   · `rate` 是实数 → 带符号的百分数，涨绿跌红，`0` 写「持平」
 */
export function rateRow(label: string, point?: AdminGrowthPoint): RateRow {
  if (!point) return { label, text: '—', cls: 'na', window: '' };
  const win = `${point.previous} → ${point.current}`;
  const rate = point.rate;
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    return { label, text: '不适用', cls: 'na', window: win };
  }
  const sign = rate > 0 ? '+' : rate < 0 ? '-' : '';
  return {
    label,
    text: `${sign}${Math.abs(rate).toFixed(1)}%`,
    cls: rate > 0 ? 'up' : rate < 0 ? 'down' : 'flat',
    window: win,
  };
}

/** null / 空串 → 「—」。后台里"空"和"0"是两回事，不许把空当 0 显示 */
export function dash(value: string | null | undefined): string {
  const s = value === null || value === undefined ? '' : String(value).trim();
  return s || '—';
}

/** `2026-10-08T13:24:05.000Z` → `2026-10-08 21:24`；解析失败退回 ISO 的日期前缀 */
export function dateText(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 「更新于 HH:MM:SS」——只反映**这一次真发出去的请求**，不是定时器 */
export function clockNow(): string {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 接口错误 → 一句话。服务端回了可读 message 就用它，否则用页面给的兜底 */
export function errorText(e: unknown, fallback: string): string {
  const m = (e as { message?: string } | undefined)?.message;
  return m && m.trim() ? m : fallback;
}

/**
 * Tab 切换：`redirectTo` 换掉当前页，四页之间不留栈。
 * 失败（路径打错、分包没下下来）要给下一步，不能只弹一句"失败"。
 */
export function openTab(url: string): void {
  wx.redirectTo({
    url,
    fail: () => tip('后台页面切换失败，请退回「我的」重新进入'),
  });
}

/**
 * 「返回」：有上一页就退；直接以 URL 打开后台（栈里没有上一页）时
 * 退回「我的」Tab —— tabBar 页只能 `switchTab`，`navigateBack` 会失败。
 */
export function backOut(): void {
  wx.navigateBack({
    delta: 1,
    fail: () => {
      wx.switchTab({
        url: '/pages/mine/index',
        // 两条路都走不通时至少让用户知道自己还在哪
        fail: () => tip('返回失败，请点右下角「我的」退出后台'),
      });
    },
  });
}

/**
 * 轻提示：文案要给出得出下一步（规范 §3.4：回调式 API 不能只 reject），
 * 且 `wx.showToast` 自己也要带 `fail` —— 弹不出来时不该在控制台留一条未捕获异常。
 */
export function tip(title: string): void {
  wx.showToast({ title, icon: 'none', duration: 2500, fail: () => undefined });
}

/** 提交成功的一句确认 */
export function done(title: string): void {
  wx.showToast({ title, icon: 'success', fail: () => undefined });
}

/* ==================== 列表页共用件（用户 / 认证审核 / 订单） ==================== */

/**
 * 每页 20 条。
 *
 * 与后端 `AdminPageSchema` 的上限（`size` ≤ 100）留了很大余量：
 * 后台列表一行有标题 + 三行说明 + 标签，手机上一次拉太多会让首屏白一下，
 * 而"下拉加载更多"在小程序里是用户熟悉的手势，不需要靠大页换。
 */
export const ADMIN_PAGE_SIZE = 20;

/** 筛选条的一格（`anim` 预先算好：WXML 里不能调函数） */
export interface FilterCell {
  value: string;
  label: string;
  on: boolean;
  anim: string;
}

/**
 * 产出筛选条。
 *
 * ⚠️ 传进来的 `values` **必须是后端枚举里真实存在的值**。
 * 一个后端不认识的 status 不会报错，只会返回空列表 —— 于是界面显示
 * "没有待处理的订单"，而真相是"筛选条件写错了"。那种假结论比红屏更糟，
 * 所以取值一律从 `packages/core` 的枚举抄，并配 `tests/mp/admin-list.spec.ts` 对账。
 */
export function filterCells(
  values: readonly string[],
  labels: Record<string, string>,
  active: string,
): FilterCell[] {
  return values.map((value, i) => ({
    value,
    label: labels[value] ?? value,
    on: active === value,
    anim: staggerClass(i),
  }));
}

/** 分页状态：`more` 由"已加载条数 < total"算出来，不靠返回条数是否等于页长猜 */
export interface Paging {
  page: number;
  total: number;
  loaded: number;
  more: boolean;
  busy: boolean;
}

export const EMPTY_PAGING: Paging = { page: 1, total: 0, loaded: 0, more: false, busy: false };

/** 一次列表返回后更新分页状态 */
export function nextPaging(prev: Paging, returned: number, total: number): Paging {
  const loaded = prev.page === 1 ? returned : prev.loaded + returned;
  return {
    page: prev.page,
    total,
    loaded,
    more: loaded < total,
    busy: false,
  };
}

/** 列表尾部的实话：到底了就说明白了，不要留一个点不动的"加载更多" */
export function tailText(p: Paging, noun: string): string {
  if (p.busy) return '加载中…';
  if (p.more) return `加载更多（已显示 ${p.loaded} / ${p.total}）`;
  return `已显示全部 ${p.total} 条${noun}`;
}

/**
 * 分页合并：第 1 页整片替换（换条件 / 刷新），后续页追加。
 *
 * 追加时序号接着上一页排 —— 否则加载第二页会把整列卡片重新闪一遍入场动效，
 * 看起来像列表被清空重建过。
 * 三个列表页共用一份，是为了让 `fetch` 的分支数留在 lint 的复杂度上限内：
 * 各自内联一份三元的话，`fetch` 会同时背着"阶段判断 + 空态文案 + 错误兜底"，
 * 复杂度超标之后人们习惯改成 `// eslint-disable`，那条规则就再也护不住任何人。
 */
export function mergeRows<Raw, Row>(
  prev: Row[],
  list: Raw[],
  page: number,
  map: (raw: Raw, index: number) => Row,
): Row[] {
  if (page === 1) return list.map((r, i) => map(r, i));
  return [...prev, ...list.map((r, i) => map(r, prev.length + i))];
}
