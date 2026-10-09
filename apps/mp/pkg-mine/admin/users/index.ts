/**
 * 管理后台 · 用户（任务清单 M3-20）
 *
 * 数据源：`adminApi.users()` → `GET /admin/users`，返回 `{ list, total }`。
 * **只读**：封号 / 改角色 / 改余额留在网页版后台，理由见 `index.wxml` 头部注释。
 *
 * 状态筛选的取值直接抄 `packages/core` 的 `ADMIN_USER_STATUSES`
 * （`active / banned / disabled`）—— 后端那个字段是 `z.enum`，
 * 传一个它不认的值不会报错，只会返回空列表，于是界面显示"没有这个状态的用户"，
 * 而真相是筛选条件写错了。`tests/mp/admin-list.spec.ts` 盯着这份取值。
 */
import { adminApi, type AdminUserItem } from '../../../utils/api';
import {
  fxDisableTilt,
  fxEnableTilt,
  fxEnd,
  fxMove,
  fxStart,
  staggerClass,
} from '../../../utils/fx';
import type { GateStage, Paging } from '../shared';
import {
  ADMIN_PAGE_SIZE,
  EMPTY_PAGING,
  bandOf,
  backOut,
  clockNow,
  dash,
  dateText,
  errorText,
  filterCells,
  gateAdmin,
  mergeRows,
  nextPaging,
  openTab,
  tabStrip,
  tailText,
} from '../shared';
// 状态与角色的取值/文案集中在 `./filters`，由 tests/mp/admin-list.spec.ts 与后端枚举对账
import { ROLE_LABELS, USER_STATUS_CLS, USER_STATUS_LABELS, USER_STATUS_VALUES } from '../filters';

const STATUS_ORDER = [...USER_STATUS_VALUES];
const STATUS_LABELS = USER_STATUS_LABELS;
const STATUS_CLS = USER_STATUS_CLS;

type View = 'loading' | 'list' | 'empty' | 'error';

/** 渲染好的一行（WXML 不能调函数，全部在这里算完） */
interface UserRow {
  id: string;
  name: string;
  phone: string;
  credit: number;
  created: string;
  roles: string[];
  statusText: string;
  statusCls: string;
  anim: string;
}

function toRow(item: AdminUserItem, index: number): UserRow {
  return {
    id: item.id,
    name: dash(item.nickname) === '—' ? '（无昵称）' : dash(item.nickname),
    // 手机号在后台列表里保持脱敏口径：后端给什么就显示什么，这里不还原
    phone: item.phone ? `手机 ${item.phone}` : '未填手机号',
    credit: item.creditScore,
    created: dateText(item.createdAt),
    roles: (item.roles ?? []).map((r) => ROLE_LABELS[r] ?? r),
    statusText: STATUS_LABELS[item.status] ?? item.status,
    statusCls: STATUS_CLS[item.status] ?? 'st-mute',
    anim: staggerClass(index % 8),
  };
}

Page({
  data: {
    gate: 'checking' as GateStage,
    gateError: '',
    adminName: '',
    roleChips: [] as string[],
    /** Tab 条在 data 初值里就铺好：等 onLoad 再 setData 会让顶栏先空一帧 */
    tabs: tabStrip('users'),
    updatedAt: '',
    view: 'loading' as View,
    error: '',
    busy: false,
    keyword: '',
    status: '',
    filters: filterCells(STATUS_ORDER, STATUS_LABELS, ''),
    rows: [] as UserRow[],
    paging: EMPTY_PAGING as Paging,
    tail: '',
    tailCls: '',
    fxStyle: '',
  },

  onLoad() {
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

  /** 闸门 → 数据。没过闸门就一个 admin 请求都不发（见 shared.gateAdmin） */
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

  /** @param page 1 = 重新查（筛选/搜索/刷新），>1 = 追加 */
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
    if (page === 1) this.setData({ view: 'loading', busy: true });
    else this.setData({ busy: true, paging: { ...this.data.paging, busy: true } });

    try {
      const res = await adminApi.users({
        page,
        size: ADMIN_PAGE_SIZE,
        keyword: this.data.keyword.trim() || undefined,
        status: this.data.status || undefined,
      });
      const list = res?.list ?? [];
      const total = Number(res?.total ?? 0);
      // 第 1 页是"重新查"（换筛选/搜索/刷新），必须整片替换；
      // 后续页是追加，序号接着上一页排，否则入场动效会从头闪一遍
      const rows = mergeRows(this.data.rows, list, page, toRow);
      const paging = nextPaging({ ...this.data.paging, page }, list.length, total);
      this.setData({
        view: rows.length ? 'list' : 'empty',
        rows,
        paging,
        tail: tailText(paging, '用户'),
        tailCls: paging.more ? '' : 'ad-end',
        error: '',
        busy: false,
        updatedAt: clockNow(),
      });
    } catch (e) {
      this.setData({
        view: this.data.rows.length ? 'list' : 'error',
        error: errorText(e, '用户名单没拉到，可以再试一次'),
        busy: false,
        paging: { ...this.data.paging, busy: false },
      });
    }
  },

  onRefresh() {
    if (!this.data.busy) void this.fetch(1);
  },
  onRetry() {
    void this.fetch(1);
  },
  onTabTap(e: WechatMiniprogram.TouchEvent) {
    const url = String(e.currentTarget.dataset.url ?? '');
    if (url) openTab(url);
  },
  onKeywordInput(e: WechatMiniprogram.Input) {
    this.setData({ keyword: e.detail.value ?? '' });
  },
  onSearch() {
    void this.fetch(1);
  },
  onFilterTap(e: WechatMiniprogram.TouchEvent) {
    const value = String(e.currentTarget.dataset.value ?? '');
    if (value === this.data.status) return;
    this.setData({
      status: value,
      filters: filterCells(STATUS_ORDER, STATUS_LABELS, value),
      rows: [],
    });
    void this.fetch(1);
  },
  onLoadMore() {
    const p = this.data.paging;
    if (!p.more || p.busy) return;
    void this.fetch(p.page + 1);
  },
});
