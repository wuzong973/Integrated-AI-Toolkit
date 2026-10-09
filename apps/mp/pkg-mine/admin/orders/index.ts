/**
 * 管理后台 · 订单（任务清单 M3-20）
 *
 * 数据源：`adminApi.orders()` → `GET /admin/orders`，返回 `{ list, total }`。
 * **只读**：放款 / 退款 / 介入裁决留在网页版后台 —— 那三个动作直接动托管资金。
 *
 * ## 状态取值一律抄后端枚举
 *
 * 取值集中在 `./filters`（与 `packages/core` 的 `OrderStatus` 对账，
 * 守卫在 `tests/mp/admin-list.spec.ts`）。这不是洁癖：
 * `AdminOrderListQuerySchema.status` 是 `z.string()`，传一个枚举里不存在的值
 * **不会报错**，只会返回空列表 —— 于是界面显示「没有服务中的订单」，
 * 而真相是筛选条件打错了一个字。空列表和"确实没有"在界面上长得一模一样。
 *
 * ## 空态为什么要复述当前条件
 *
 * 同理，筛出 0 条不等于全站没有订单。所以空态把两个条件原样报回去
 * （见 wxml 的 `{{statusLabel}}` + 只看纠纷），让人看得出是"筛选生效了"而不是"没生意"。
 *
 * ## 金额
 *
 * 接口回的一律是**整数分**，展示走 `moneyText`；WXML 里不做任何算术，
 * 也不许出现 `amount / 100` 这类浮点写法（红线：金额一律「分」整数）。
 */
import { adminApi, type AdminOrderItem } from '../../../utils/api';
import {
  fxDisableTilt,
  fxEnableTilt,
  fxEnd,
  fxMove,
  fxStart,
  staggerClass,
} from '../../../utils/fx';
import { ORDER_STATUS_CLS, ORDER_STATUS_LABELS, ORDER_STATUS_VALUES } from '../filters';
import type { GateStage } from '../shared';
import {
  ADMIN_PAGE_SIZE,
  bandOf,
  backOut,
  clockNow,
  dash,
  dateText,
  errorText,
  gateAdmin,
  mergeRows,
  moneyText,
  openTab,
  pickAllowed,
  tabStrip,
  tip,
} from '../shared';

const STATUS_VALUES = [...ORDER_STATUS_VALUES];
const LABELS = ORDER_STATUS_LABELS;

/** 内容阶段。`empty` 与 `error` 分开：一个是"问到了，答案是零"，一个是"没问到" */
type Stage = 'loading' | 'list' | 'empty' | 'error';

interface OrderRow {
  id: string;
  orderNoText: string;
  partyText: string;
  createdText: string;
  paidText: string;
  amountText: string;
  statusText: string;
  statusCls: string;
  refundReason: string;
  anim: string;
}

function toRow(item: AdminOrderItem, index: number): OrderRow {
  const buyer = dash(item.buyerName);
  const provider = dash(item.providerName);
  return {
    id: item.id,
    orderNoText: `单号 ${item.orderNo}`,
    // 两边的昵称都可能是 null（`user.nickname` 可空，账号没填而已）。这里一律走 dash() → 「—」：
    // ⚠️ 不能写成「待接单」—— `order.provider_id` 在 schema 里是**必填**（schema.prisma:542），
    // 订单建出来就带着服务者，"名字为空"说的是这个人没填昵称，不是没人接单。
    partyText: `${buyer} → ${provider}`,
    createdText: `下单 ${dateText(item.createdAt)}`,
    // 没付款就没有付款时间：如实写"未付款"，不留空、也不写 1970
    paidText: item.paidAt ? `付款 ${dateText(item.paidAt)}` : '未付款',
    amountText: `¥${moneyText(item.amount)}`,
    statusText: LABELS[item.status] ?? item.status,
    statusCls: ORDER_STATUS_CLS[item.status] ?? 'st-mute',
    refundReason: item.refundReason ?? '',
    anim: staggerClass(index % 8),
  };
}

function chips(active: string) {
  return STATUS_VALUES.map((value) => ({ value, label: LABELS[value] ?? value, on: active === value }));
}

Page({
  data: {
    gate: 'checking' as GateStage,
    gateError: '',
    adminName: '',
    roleChips: [] as string[],
    tabs: tabStrip('orders'),
    updatedAt: '',
    total: 0,
    stage: 'loading' as Stage,
    error: '',
    status: '',
    statusLabel: '全部',
    statusChips: chips(''),
    disputed: false,
    rows: [] as OrderRow[],
    page: 1,
    hasMore: false,
    loadingMore: false,
    fxStyle: '',
  },

  onLoad(query: Record<string, string>) {
    // 概览的「纠纷订单」待办会带 ?disputed=true（或 ?status=xxx）跳进来，这里必须接住：
    // 接不住的话那个待办点进来看到的仍是"全部订单"，等于一条看着能用其实是死的入口。
    // 认不出的 status 当没给 —— 后端那个字段是 z.string()，脏值不报错，只筛出 0 条，
    // 于是界面会说"这个条件下没有订单"，而真相是筛选条件写错了。
    const status = pickAllowed(query.status, STATUS_VALUES);
    const disputed = query.disputed === 'true';
    if (status || disputed) {
      this.setData({
        status,
        statusLabel: LABELS[status] ?? '全部',
        statusChips: chips(status),
        disputed,
      });
    }
    void this.boot();
  },
  onShow() {
    fxEnableTilt(this);
  },
  onHide() {
    fxDisableTilt();
  },
  onUnload() {
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

  async onPullDownRefresh() {
    try {
      if (this.data.gate === 'ok') await this.fetch(1);
    } finally {
      wx.stopPullDownRefresh({ fail: () => undefined });
    }
  },

  /** 闸门 → 数据。没过闸门就一个后台请求都不发（见 shared.gateAdmin） */
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
    await this.fetch(1);
  },

  async onRetryGate() {
    await this.boot();
  },
  onBack() {
    backOut();
  },
  onTabTap(e: WechatMiniprogram.TouchEvent) {
    const url = String(e.currentTarget.dataset.url ?? '');
    if (url) openTab(url);
  },

  /** @param page 1 = 重新查（换条件/刷新），>1 = 追加 */
  /**
   * 唯一入口，权限闸门就在这两层里的第一层：下拉刷新与触底都是系统手势，
   * 只靠"按钮没渲染"挡不住 —— 请求发不出去才算真的"没权限就看不到数据"。
   * （拆成两层还有个硬理由：`complexity` 上限 10，守卫和分页分支堆进一个函数会超）
   */
  async fetch(page: number) {
    if (this.data.gate !== 'ok') return;
    await this.query(page);
  },

  /** 真正发请求的那层：`page === 1` 整片重查（换条件/刷新），> 1 往后接一批 */
  async query(page: number) {
    if (page === 1) this.setData({ stage: 'loading' });
    else this.setData({ loadingMore: true });

    try {
      const res = await adminApi.orders({
        page,
        size: ADMIN_PAGE_SIZE,
        status: this.data.status || undefined,
        // 只在打开时带上：后端把缺省与 false 同视，但少一个参数少一种组合
        disputed: this.data.disputed ? true : undefined,
      });
      const list = res?.list ?? [];
      const total = Number(res?.total ?? 0);
      const rows = mergeRows(this.data.rows, list, page, toRow);
      this.setData({
        stage: rows.length ? 'list' : 'empty',
        rows,
        total,
        page,
        hasMore: rows.length < total,
        error: '',
        updatedAt: clockNow(),
        loadingMore: false,
      });
    } catch (e) {
      const msg = errorText(e, '订单列表没拉到，可以再试一次');
      // 已经有数据时不清空屏幕：让运营继续看上一批，只在错误字段里说明这次失败了
      this.setData({
        stage: this.data.rows.length ? 'list' : 'error',
        error: msg,
        loadingMore: false,
      });
      // 屏上还留着上一批时走的是 list 分支，`error` 根本不会渲染 ——
      // 不再补一次 tip 的话，这次失败看起来就"和成功一模一样"（加载更多点了没反应）
      if (this.data.rows.length) tip(msg);
    }
  },

  onRefresh() {
    void this.fetch(1);
  },
  onRetry() {
    void this.fetch(1);
  },
  onStatusTap(e: WechatMiniprogram.TouchEvent) {
    const value = String(e.currentTarget.dataset.value ?? '');
    if (value === this.data.status) return;
    this.setData({
      status: value,
      statusLabel: LABELS[value] ?? value,
      statusChips: chips(value),
      rows: [],
    });
    void this.fetch(1);
  },
  onDisputedTap() {
    this.setData({ disputed: !this.data.disputed, rows: [] });
    void this.fetch(1);
  },
  /** 空态上的"清掉筛选重拉"：两个条件一起回默认，别让人一个个点回去 */
  onResetFilters() {
    this.setData({ status: '', statusLabel: '全部', statusChips: chips(''), disputed: false, rows: [] });
    void this.fetch(1);
  },
  onLoadMore() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    void this.fetch(this.data.page + 1);
  },
});
