/**
 * 消息通知（站内消息中心，任务清单 M3-19）
 *
 * ## 后端契约（以代码为准：`apps/api/src/modules/notification/notification.controller.ts`）
 *   `GET  /notifications`          → `{ list, total, page, pageSize, unreadCount }`，按 `createdAt` **倒序**
 *   `POST /notifications/:id/read` → `{ id, read: true }`（重复调用仍成功；不是自己的一条 404）
 *   `POST /notifications/read-all` → `{ updated }`（真正变化的条数）
 * 三条都已在 `utils/notification-api.ts` 封成 `messageApi`，本页**只调不改**。
 *
 * ## 分页是"接了的"
 * 后端 `page` / `pageSize`（上限 50）都真的生效并回 `total`，所以本页做
 * 「首屏 20 条 + 触底接下一页」。这里不像 `pkg-toolbox/files` 那样一次拉全量 ——
 * 那个接口返回裸数组，压根没有分页参数，想接也没得接。
 *
 * ## 未读数只有一份真相
 * `unreadCount` 由后端按"我全部未读"算出（**不受** `type` / `unread` 筛选影响），
 * 每次拉列表都刷新它并写进 `globalData`。本页不自己数列表里的红点：
 * 数了就会和分页/筛选后的可见条数对不上，而角标要的恰恰是全局值。
 *
 * ## 已读状态不在本地另存一份
 * `NotificationItem.read` 由后端 `readAt` 派生。点开后本地只做"这一行立刻变灰"的
 * 乐观更新（见 `markRead` 注释），下一次拉列表仍以服务端为准。
 *
 * 视觉：樱花粉主题（`th-mine`，圆角 30）· 装饰签名「信使动线」（`.qz-deco` 里一条
 * `qz-flow-soft` + 一枚 `qz-dot-b`）· 描边列表卡（未读行叠左侧彩色指示条）· 整行 `.qz-lift`，
 * 与上一页「我的」（柔影大卡）在卡型与装饰类型上都换了一处，避免千篇一律。
 */
import type { NotificationItem } from '../../utils/api';
import { messageApi } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { toastError } from '../../utils/request';

/** 页面阶段：首屏骨架 / 有列表 / 空态 / 错误重试 */
type Stage = 'loading' | 'list' | 'empty' | 'error';

/** 一次拉 20 条（后端 `pageSize` 上限 50，见 `NotificationListQuerySchema`） */
const PAGE_SIZE = 20;

/** 列表行 = 接口字段 + 三个纯展示派生字段 */
type Row = NotificationItem & { icon: string; typeLabel: string; timeText: string };

/**
 * `type` → 糖果图标 + 分组名。
 * 后端枚举只有 `order` / `task` / `system` 三个值（`NOTIFICATION_TYPES`）；
 * 真收到别的值时落到 `TYPE_OTHER`，**不猜**成三者中的某一个。
 */
const TYPE_META: Record<string, { icon: string; label: string }> = {
  order: { icon: 'qz-i-orders', label: '交易动态' },
  task: { icon: 'qz-i-station', label: '任务动态' },
  system: { icon: 'qz-i-bell', label: '系统通知' },
};
const TYPE_OTHER = { icon: 'qz-i-bell', label: '通知' };

Page({
  data: {
    stage: 'loading' as Stage,
    error: '',
    rows: [] as Row[],
    /** 后端给的全局未读数（角标与"全部已读"按钮都看它） */
    unreadCount: 0,
    page: 1,
    total: 0,
    hasMore: false,
    loadingMore: false,
    /** 一键已读提交中：防连点（连点会打第二次写接口） */
    busyAll: false,
    /** 装饰层视差位移（由 utils/fx.ts 写入） */
    fxStyle: '',
  },

  onLoad() {
    void this.fetch(1);
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

  /** 下拉刷新：重拉第一页后必须 stop，否则顶部转圈不停 */
  async onPullDownRefresh() {
    try {
      await this.fetch(1);
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  /** 触底接下一页（`hasMore` 由 total 与已拿到条数比较得出，不靠"这次返回是不是空"） */
  onReachBottom() {
    this.onLoadMore();
  },

  /**
   * 「加载更多」：小屏上触底不明显，给一个真能点的入口。
   * 两个入口共用这一道闸 —— 触底 + 连点会打出两次同一页，列表里就出现重复 id。
   */
  onLoadMore() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    void this.fetch(this.data.page + 1);
  },

  /**
   * 拉取通知。`target === 1` 是整屏重拉，大于 1 是往后接一批。
   *
   * 只有一处 `try`：两条路径的**失败语义不同**，所以分开处理而不是揉成一个 error 分支 ——
   * 首屏失败进错误态（屏幕上没有内容可留），加载更多失败只 toast（已有列表不该被抹掉）。
   */
  async fetch(target: number) {
    const append = target > 1;
    if (append) this.setData({ loadingMore: true });
    else this.setData({ stage: 'loading', error: '' });

    try {
      const res = await messageApi.list({ page: target, pageSize: PAGE_SIZE });
      publishUnread(res.unreadCount);
      const fresh = res.list.map(toRow);
      const rows = append ? this.data.rows.concat(fresh) : fresh;
      this.setData({
        rows,
        page: target,
        total: res.total,
        hasMore: rows.length < res.total,
        stage: rows.length ? 'list' : 'empty',
        error: '',
      });
    } catch (e) {
      if (append) toastError(e);
      else this.setData({ stage: 'error', error: (e as Error).message || '消息加载失败' });
    } finally {
      this.setData({ loadingMore: false });
    }
  },

  onRetry() {
    void this.fetch(1);
  },

  /** 点开一条：先标已读（不等它，跳转不该被一次写请求拖住），再按锚点跳过去 */
  onItemTap(e: WechatMiniprogram.TouchEvent) {
    const i = Number(e.currentTarget.dataset.i);
    const row = this.data.rows[i];
    if (!row) return;
    if (!row.read) void this.markRead(i);
    const url = urlOf(row);
    if (url) wx.navigateTo({ url });
    else wx.showToast({ title: '这条消息没有可跳转的详情', icon: 'none' });
  },

  /**
   * 标一条已读：本地行与未读数立刻变，服务端随后写。
   *
   * 失败**不回滚**：已读是幂等的展示型状态（后端 `markRead` 用 `updateMany` 且
   * 重复调用仍成功），把红点弹回来只会让用户以为"点了没用"再点一次；
   * 下一次拉列表时 `read` 由服务端 `readAt` 重新给出，会自动对上。
   */
  async markRead(i: number) {
    const rows = this.data.rows.slice();
    const row = rows[i];
    if (!row) return;
    rows[i] = { ...row, read: true };
    const unread = Math.max(0, this.data.unreadCount - 1);
    this.setData({ rows, unreadCount: unread });
    publishUnread(unread);
    try {
      await messageApi.read(row.id);
    } catch {
      // 见文件头说明：不打断跳转，也不在此处弹错误条
    }
  },

  /** 一键已读：真有未读时才发写接口 */
  async onReadAll() {
    if (this.data.busyAll) return;
    if (!this.data.unreadCount) {
      wx.showToast({ title: '当前没有未读消息', icon: 'none' });
      return;
    }
    this.setData({ busyAll: true });
    try {
      const { updated } = await messageApi.readAll();
      this.setData({
        rows: this.data.rows.map((r) => (r.read ? r : { ...r, read: true })),
        unreadCount: 0,
      });
      publishUnread(0);
      wx.showToast({ title: `已标记 ${updated} 条为已读`, icon: 'none' });
      // updated 可能大于本页条数（还有没翻到的未读）：重拉第一页让列表与服务端一致
      if (updated > this.data.rows.length) await this.fetch(1);
    } catch (e) {
      toastError(e);
    } finally {
      this.setData({ busyAll: false });
    }
  },

  /** 空态主操作：订单动态是消息的主要来源，去订单列表是个真能到的去处 */
  onGoOrders() {
    wx.navigateTo({ url: '/pkg-station/order-list/index' });
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

// ---------- 纯函数（页面文件不参与 vitest 收集：`vitest.config.ts` 只收 tests/** 与
// *.spec.ts，而本任务不允许新增 utils 文件，所以时间口径就留在这里，未做单测覆盖） ----------

/** 通知条目 → 列表行（图标、分组名、可读时间都是纯展示派生） */
function toRow(n: NotificationItem): Row {
  const meta = TYPE_META[n.type] ?? TYPE_OTHER;
  return { ...n, icon: meta.icon, typeLabel: meta.label, timeText: timeTextOf(n.createdAt) };
}

/**
 * 跳转目的地。`refType` 的取值来自服务端写死的三种（全项目 grep `notify(` 得）：
 *  · `order`        → `refId` 是**订单 id**（交付 / 验收 / 退款 / 被选定）
 *  · `task`         → `refId` 是**任务 id**（有人报名 / 需求已关闭）
 *  · `conversation` → `refId` 是**会话 id**（`conversation.service.ts` 的 `send()`），
 *                     ⚠️ 不是订单 id，所以只能带 `conversationId` 进会话页；
 *                     带成 orderId 会去"按订单建/取"另一条会话，谈的不是同一件事。
 * 收到未知 `refType`（后端以后加值）返回空串 → 只标已读、不猜去处，由调用方如实提示。
 */
function urlOf(row: NotificationItem): string {
  if (!row.refId) return '';
  if (row.refType === 'order') return `/pkg-station/order-detail/index?id=${row.refId}`;
  if (row.refType === 'task') return `/pkg-station/task/index?id=${row.refId}`;
  if (row.refType === 'conversation') return `/pkg-station/chat/index?conversationId=${row.refId}`;
  return '';
}

/**
 * 把后端给的未读数交给 `globalData.unreadCount`。
 *
 * 首页铃铛红点的**渲染**由消息中心的另一条任务负责，本页只写不读，
 * 这样两端读的是同一个数。用 `Object.assign` 而不是直接 `globalData.unreadCount = n`：
 * `IAppOption['globalData']` 的声明里没有这个键（`typings/index.d.ts` 不在本次可改范围），
 * 直接赋值会撞"对象字面量只能指定已知属性"，而绕成 `as any` 又违反禁 any 红线。
 */
function publishUnread(count: number): void {
  const app = getApp<IAppOption>();
  if (app?.globalData) Object.assign(app.globalData, { unreadCount: count });
}

/** 一个自然日的毫秒数 */
const DAY_MS = 86400000;

/** 补零（`pad(5) → '05'`） */
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 两个日期之间的"自然日"差（按本地零点算，`b - a`，同一天为 0） */
function dayGap(a: Date, b: Date): number {
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOf(b) - startOf(a)) / DAY_MS);
}

/**
 * ISO → 本地可读时间：`今天 20:04` / `昨天 18:30` / `9月18日 09:05` / `2025年12月2日`。
 *
 * 解析失败退回 ISO 的日期前缀（`2026-09-19`）—— 宁可生硬，也不要在消息中心里
 * 出现 `Invalid Date`；跨年才带年份，是因为一年内的日期在通知里靠"月日"就已无歧义。
 */
function timeTextOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  const gap = dayGap(d, now);
  if (gap === 0) return `今天 ${clock}`;
  if (gap === 1) return `昨天 ${clock}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
