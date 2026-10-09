/**
 * 管理后台 · 概览（任务清单 M3-20）
 *
 * 数据源：`adminApi.stats()` → `GET /admin/dashboard/stats`
 * （契约见 `utils/api.ts` 末尾的 `adminApi`，类型在 `utils/api-types-admin.ts`）。
 * 本页**只渲染接口真给出的字段**，一个数字都不编。
 *
 * ## ⚠️ 这里刻意没有「每 15 秒自动刷新」，别把它"恢复"回来
 * 原型图二写了轮询，本实现**不去实现**，理由三条：
 *   ① 手机上是后台看板，没人盯着：轮询只在烧移动流量与电量；而四个 Tab 之间用
 *      `redirectTo` 来回切，一次会话里每个被替换掉的页面都可能留着一份定时器；
 *   ② `setInterval` 一旦漏 clear 就**活过页面卸载**，届时它还在替一个已经不存在的
 *      页面发请求、还在 setData（开发者工具里表现为"切了几次 Tab 后数字自己乱跳"）；
 *   ③ 这条链路上没有推送通道，15 秒一次的"新"其实是同一份数字反复覆盖。
 * 替代方案（都是真能用的）：`.json` 里 `enablePullDownRefresh: true` + 头部「手动刷新」，
 * 并把**这一次请求真正完成的时刻**显示成 `更新于 HH:MM:SS`。
 *
 * ## 两处口径（红线，别改回"更好看"的写法）
 *   · `users.active` 是**账号状态为 active 的账号数** → 界面写作「状态正常」。
 *     后端刻意不提供"登录用户数 / 活跃用户数"：`user.lastLogin` 在注册时也会写入，
 *     真按它数出来的"活跃"会与注册用户数完全相等，那是编出来的结论 ——
 *     所以这里也不许出现那种说法。
 *   · `growth.rate` 为 `null`（上期基数 0，比率无定义）→ 「不适用」并附 `上期 → 本期`；
 *     整个 `growth` 字段没给 → 「—」。两者都不许写成 0% 或 +100%。
 *
 * 视觉：`th-mine` · 装饰签名「topline + dot-c」（§十一 已登记；后台四页共用同一枚 dot-c
 * 做识别锚，靠第二个装饰元素区分页）· 主卡型 `.qz-card-bar`。
 * 反馈：`lift` 只给真的会跳页的待办卡；指标卡是纯信息卡，挂 lift 等于骗用户以为可点。
 */
import type { AdminStats } from '../../utils/api';
import { adminApi } from '../../utils/api';
import {
  fxDisableTilt,
  fxEnableTilt,
  fxEnd,
  fxMove,
  fxStart,
  staggerClass,
} from '../../utils/fx';

import type { GateStage, Metric, RateRow, Section, TodoCell } from './shared';
import {
  bandOf,
  backOut,
  clockNow,
  dash,
  errorText,
  gateAdmin,
  moneyText,
  openTab,
  rateRow,
  tabStrip,
  tabUrl,
  tip,
} from './shared';

/** 概览没有"列表为空"这种状态：接口回来就一定有数字，所以只有三态 */
type View = 'loading' | 'list' | 'error';

/** 热门工具榜的一行（名次是本页按接口顺序编的，`jobs` 是后端算好的近 7 日作业数） */
interface ToolRow {
  rank: number;
  name: string;
  jobs: string;
  anim: string;
}

Page({
  data: {
    /** 'checking'：闸门还没回来。此期间一个 admin 请求都不发 */
    gate: 'checking' as GateStage,
    gateError: '',
    adminName: '',
    roleChips: [] as string[],
    /** Tab 条在 data 初值里就铺好：等 onLoad 再 setData 会让顶栏先空一帧 */
    tabs: tabStrip('index'),
    /** 这一次 stats 请求完成的时刻；没有定时器，所以它只在真拉过之后才变 */
    updatedAt: '',
    view: 'loading' as View,
    error: '',
    busy: false,
    todos: [] as TodoCell[],
    sections: [] as Section[],
    topTools: [] as ToolRow[],
    /** 装饰层视差位移（由 utils/fx.ts 写入） */
    fxStyle: '',
  },

  onLoad() {
    void this.boot();
  },

  onShow() {
    // 倾斜只在 onShow 开（放 onLoad 会在页面尚不可见时就开始吃传感器数据）
    fxEnableTilt(this);
  },

  onHide() {
    fxDisableTilt();
  },

  onUnload() {
    fxDisableTilt();
  },

  /** 下拉刷新是"再看一眼新数"的唯一入口之一；拉完必须 stop，否则顶部转圈不停 */
  async onPullDownRefresh() {
    try {
      await this.load();
    } finally {
      wx.stopPullDownRefresh({ fail: () => undefined });
    }
  },

  /**
   * 闸门 → 数据。顺序不能颠倒：非管理员手打 URL 进来时也必须什么都看不到，
   * 而"看不到"要靠**根本不发这个请求**做到，不是靠把返回的数据藏起来。
   */
  async boot() {
    const gate = await gateAdmin();
    if (gate.stage === 'denied') {
      this.setData({ gate: 'denied' });
      return;
    }
    if (gate.stage === 'error') {
      this.setData({ gate: 'error', gateError: gate.error });
      return;
    }
    const band = bandOf(gate.me);
    this.setData({ gate: 'ok', adminName: band.adminName, roleChips: band.roleChips });
    await this.load();
  },

  /**
   * 拉概览。两道闸：
   *   · `gate !== 'ok'` —— 下拉刷新是**系统手势**，在「没有权限」那一屏上也做得出来，
   *     只靠"刷新按钮不渲染"挡不住；权限这一关必须查在发请求的那一行前面。
   *     （`setData` 会同步更新 `this.data`，所以 `boot()` 里刚置的 'ok' 这里立刻读得到。）
   *   · `busy` —— 挡住「手动刷新」连点与下拉刷新重入。
   */
  async load() {
    if (this.data.busy || this.data.gate !== 'ok') return;
    this.setData({ busy: true, view: this.data.sections.length ? 'list' : 'loading', error: '' });
    try {
      const stats = await adminApi.stats();
      this.setData({
        todos: buildTodos(stats),
        sections: buildSections(stats),
        topTools: buildTopTools(stats),
        view: 'list',
        error: '',
        updatedAt: clockNow(),
      });
    } catch (e) {
      // 失败就停在错误态：不兜缓存、不摆示例数字，更不把"没拉出来"演成"全是 0"
      this.setData({ view: 'error', error: errorText(e, '概览数据加载失败，可重试') });
    } finally {
      this.setData({ busy: false });
    }
  },

  onRetry() {
    void this.load();
  },

  /** 「手动刷新」与下拉刷新走同一条路（这就是"不轮询"的另一半） */
  onRefresh() {
    void this.load();
  },

  /** Tab 切换只能 redirectTo：navigateTo 会把四页叠成一叠，返回键按四次才出得去 */
  onTabTap(e: WechatMiniprogram.TouchEvent) {
    const url = String(e.currentTarget.dataset.url ?? '');
    if (url) openTab(url);
    else tip('这个后台页的地址没配好，请从「我的」重新进入');
  },

  onBack() {
    backOut();
  },

  onRetryGate() {
    this.setData({ gate: 'checking', gateError: '' });
    void this.boot();
  },

  /** 待办条：能跳的真跳（并把筛选带好过去）；跳不了的如实说，不做死按钮 */
  onTodoTap(e: WechatMiniprogram.TouchEvent) {
    const cell = this.data.todos[Number(e.currentTarget.dataset.i)];
    if (!cell) return;
    if (cell.url) {
      openTab(cell.url);
      return;
    }
    tip(`「${cell.label}」对应的作业队列页暂未在小程序开放，可在网页后台查看`);
  },

  /* ---------- 指针视差（装饰层跟手，内容区不动） ---------- */
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

/**
 * 待办三条取自 `stats.todos`（不从下面的指标卡现算 —— 两处算必然两处不一致）。
 * 前两格是本页唯一挂 `.qz-lift` 的地方：它们真的会跳页。
 * 第三格（今日失败作业）在小程序里没有对应页面，`url` 留空 → 不挂 lift、点了给如实提示。
 */
function buildTodos(s: AdminStats): TodoCell[] {
  const t = s.todos;
  return [
    {
      label: '待审认证',
      value: num(t.pendingVerifications),
      hint: '进审核队列',
      icon: 'qz-i-verify',
      url: tabUrl('verifications', { status: 'pending' }),
      anim: staggerClass(0),
    },
    {
      label: '纠纷订单',
      value: num(t.disputedOrders),
      hint: '只看纠纷单',
      icon: 'qz-i-fire',
      url: tabUrl('orders', { disputed: 'true' }),
      anim: staggerClass(1),
    },
    {
      label: '今日失败作业',
      value: num(t.failedJobsToday),
      hint: '暂无对应页',
      icon: 'qz-i-close',
      url: '',
      anim: staggerClass(2),
    },
  ];
}

/**
 * 指标分区。顺序按"运营进来看什么"排：用户 → 交易 → 生产 → 工具。
 * 每张卡的 `hint` 写明口径，`value` 全部直接来自接口字段。
 */
function buildSections(s: AdminStats): Section[] {
  return [userSection(s), orderSection(s), jobSection(s), toolSection(s)];
}

function userSection(s: AdminStats): Section {
  const u = s.users;
  // `growth` 是接口里的**可选**字段：没给时 rateRow 回「—」，本页不拿 0 顶替
  const g = u.growth;
  return {
    key: 'users',
    title: '用户',
    sub: '注册与账号状态',
    icon: 'qz-i-mine',
    metrics: [
      metric('注册用户总数', num(u.total), '全部账号，含未填资料的', 0),
      metric('状态正常', num(u.active), '账号状态 active，不等于登录活跃', 1),
      metric('已封禁', num(u.banned), '账号状态 banned', 2),
      metric('今日新增', num(u.newToday), '与自然日窗口一致', 3, [rateRow('日环比', g?.day)]),
      metric('近 7 日新增', num(u.newWeek), '滚动 7 天', 4, [rateRow('周环比', g?.week)]),
      metric('近 30 日新增', num(u.newMonth), '滚动 30 天', 5, [rateRow('月环比', g?.month)]),
    ],
  };
}

/** 订单块：`gmv` 只统计已完成订单（后端就是这么算的），单位是**分** → 交 moneyText */
function orderSection(s: AdminStats): Section {
  const o = s.orders;
  return {
    key: 'orders',
    title: '交易',
    sub: '订单与成交额',
    icon: 'qz-i-orders',
    metrics: [
      metric('订单总数', num(o.total), '全部状态', 0),
      metric('进行中', num(o.inProgress), '未到终态的订单', 1),
      metric('纠纷订单', num(o.disputed), '退款中 / 已退款', 2),
      metric('已完成', num(o.completed), '已交付并结算', 3),
      metric('成交额', `¥${moneyText(o.gmv)}`, '只统计已完成订单', 4),
      metric('退款单', num(o.refundedCount), '已发生退款的订单数', 5),
    ],
  };
}

function jobSection(s: AdminStats): Section {
  const j = s.jobs;
  return {
    key: 'jobs',
    title: '生产',
    sub: '工具作业',
    icon: 'qz-i-rocket',
    metrics: [
      metric('作业总数', num(j.total), '历史累计', 0),
      metric('今日作业', num(j.today), '提交时间落在今天', 1),
      metric('今日失败', num(j.failedToday), '失败不是排队，需要有人看', 2),
      metric('排队中', num(j.queued), '还没开始跑', 3),
      metric('运行中', num(j.running), '此刻正在跑', 4),
    ],
  };
}

function toolSection(s: AdminStats): Section {
  const t = s.tools;
  return {
    key: 'tools',
    title: '工具',
    sub: '上架与规划',
    icon: 'qz-i-toolbox',
    metrics: [
      metric('工具总数', num(t.total), '接口全量，不受可见性过滤', 0),
      metric('已上架', num(t.active), 'status 为 active', 1),
      metric('未上架', num(t.planned), '总数扣已上架，含规划中与已下线', 2),
    ],
  };
}

/** 近 7 日热门工具榜：`topTools` 由后端排序算好，本页只照抄顺序编号，不自己数 */
function buildTopTools(s: AdminStats): ToolRow[] {
  return s.topTools.map((t, i) => ({
    rank: i + 1,
    name: dash(t.displayName || t.toolName),
    jobs: num(t.jobs7d),
    anim: staggerClass(i),
  }));
}

function metric(label: string, value: string, hint: string, i: number, rates?: RateRow[]): Metric {
  return { label, value, hint, rates, anim: staggerClass(i) };
}

/**
 * 数字 → 字符串。
 * `0` 要如实显示成「0」（它是"这条记录确实为空"的真实结论），不能因为假值而整卡消失；
 * 拿不到实数才写「—」，不许把 undefined 当 0。
 */
function num(n: number): string {
  return Number.isFinite(n) ? String(n) : '—';
}
