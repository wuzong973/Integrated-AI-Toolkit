/**
 * 管理后台 · 认证审核（任务清单 M3-20）
 *
 * 数据源：`adminApi.verifications()` / `adminApi.reviewVerification()`。
 *
 * ## 为什么驳回要在**提交前**卡住字数
 *
 * 后端 `ReviewVerificationSchema` 有一条 `.refine`：驳回必须给 ≥4 个字的原因，
 * 否则打回「驳回必须填写具体原因（否则用户不知道该改什么）」。
 * 不在前端先拦，用户点下去吃到的就是一句像系统报错的红字 ——
 * 而那件事其实他改一个字就能满足。所以这里边写边算 `canReject`，
 * 不满足时按钮是灰的，并把规则原文显示在输入框下面。
 *
 * ## 状态取值
 *
 * `pending / approved / rejected` 抄自 `packages/core` 的 `VerificationStatus`
 * 与后端 `AdminVerificationListQuerySchema` 的 `z.enum`。
 * 传一个它不认的值不会报错，只会返回空列表 —— 于是界面显示"没有待审的申请"，
 * 而真相是筛选条件写错了。`tests/mp/admin-list.spec.ts` 盯着这份取值。
 */
import { adminApi, type AdminVerificationItem } from '../../../utils/api';
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
  backOut,
  bandOf,
  clockNow,
  dash,
  dateText,
  done,
  errorText,
  filterCells,
  gateAdmin,
  mergeRows,
  nextPaging,
  openTab,
  pickAllowed,
  tabStrip,
  tailText,
  tip,
} from '../shared';
// 状态取值集中在 `./filters`，由 tests/mp/admin-list.spec.ts 与后端枚举对账
import {
  VERIFICATION_STATUS_CLS,
  VERIFICATION_STATUS_LABELS,
  VERIFICATION_STATUS_VALUES,
} from '../filters';

const STATUS_ORDER = [...VERIFICATION_STATUS_VALUES];
const STATUS_LABELS = VERIFICATION_STATUS_LABELS;
const STATUS_CLS = VERIFICATION_STATUS_CLS;

/** 驳回原因的最短长度，与后端 `.refine` 的阈值一致 */
const MIN_REJECT_REASON = 4;

type View = 'loading' | 'list' | 'empty' | 'error';

interface ReviewRow {
  id: string;
  title: string;
  realName: string;
  studentNo: string;
  school: string;
  created: string;
  materials: string;
  tags: string[];
  statusText: string;
  statusCls: string;
  rejectReason: string;
  /** 只有"待审 + 服务端定义了审核流程"的类型才给按钮 */
  reviewable: boolean;
  /** 不给按钮时，界面上如实写的那句话 */
  offNote: string;
  anim: string;
}

/**
 * 只有服务者认证在服务端定义了审核流程：`AdminContentService.loadReviewable()`
 * 对其它类型直接抛「尚未定义审核流程」（通过是有副作用的 —— 服务者通过要授角色、
 * 写回真实姓名与技能画像；对没定义流程的类型只改 status，会造出一个"状态是通过、
 * 但什么都没发生"的申请人，比拒绝更糟）。
 * 所以这里不画按钮 —— 画一个点了必然报错的按钮，比不画更糟。
 */
const REVIEWABLE_TYPE = 'provider';

/** 申请人称呼：昵称没填就退回真实姓名，两个都没有才说"未填昵称" */
function whoText(item: AdminVerificationItem): string {
  const nick = dash(item.nickname);
  if (nick !== '—') return nick;
  const real = dash(item.realName);
  return real === '—' ? '（未填昵称）' : real;
}

/** 学校与学院：缺哪个少一段，两个都缺才给一句说明 */
function schoolText(item: AdminVerificationItem): string {
  const parts = [dash(item.schoolName), dash(item.college)].filter((s) => s !== '—');
  return parts.length ? parts.join(' · ') : '学校与学院都没填';
}

/** 这一行现在能不能操作，以及不能操作时为什么 —— 拆出来是为了让 toRow 只负责拼装 */
function reviewState(item: AdminVerificationItem, typeLabel: string | null) {
  if (item.status !== 'pending') {
    return { reviewable: false, offNote: '这条已处理，只读。' };
  }
  if (item.type === REVIEWABLE_TYPE) {
    return { reviewable: true, offNote: '' };
  }
  return {
    reviewable: false,
    offNote: `「${typeLabel || item.type}」的审核流程暂未在服务端定义，暂不可用（可在网页版后台跟进）。`,
  };
}

function toRow(item: AdminVerificationItem, index: number): ReviewRow {
  const typeLabel = dash(item.typeLabel) === '—' ? item.type : item.typeLabel;
  const state = reviewState(item, typeLabel);
  return {
    id: item.id,
    title: `${typeLabel} · ${whoText(item)}`,
    // 接口给 null 的字段一律走 dash() → 「—」：不拿空串冒充"没填"，也不拿"未提供"猜
    realName: dash(item.realName),
    studentNo: dash(item.studentNo),
    school: schoolText(item),
    created: dateText(item.createdAt),
    // 只显示份数：verification 场景没有公开读通道，画裂图不如说清楚去哪看
    materials: `材料 ${item.materials?.length ?? 0} 份（明细请在网页版后台查看）`,
    tags: (item.skillTags ?? []).slice(0, 4),
    statusText: STATUS_LABELS[item.status] ?? item.status,
    statusCls: STATUS_CLS[item.status] ?? 'st-mute',
    rejectReason: item.rejectReason ?? '',
    reviewable: state.reviewable,
    offNote: state.offNote,
    anim: staggerClass(index % 8),
  };
}

Page({
  data: {
    gate: 'checking' as GateStage,
    gateError: '',
    adminName: '',
    roleChips: [] as string[],
    tabs: tabStrip('verifications'),
    updatedAt: '',
    view: 'loading' as View,
    error: '',
    busy: false,
    status: 'pending',
    filters: filterCells(STATUS_ORDER, STATUS_LABELS, 'pending'),
    rows: [] as ReviewRow[],
    paging: EMPTY_PAGING as Paging,
    tail: '',
    tailCls: '',
    emptyTitle: '没有待审的认证申请',
    /** 正在提交的那一条：非空时两张按钮都禁用，防连点发两次 */
    busyId: '',
    rejectingId: '',
    rejectDraft: '',
    canReject: false,
    fxStyle: '',
  },

  onLoad(query: Record<string, string>) {
    // 概览的「待审认证」待办会带 ?status=pending 跳进来。
    // 认不出的值当没给（后端那个字段是 z.enum，脏值不会报错只会筛出空列表 ——
    // 于是界面显示"没有待审的申请"，而真相是筛选条件写错了）。
    const status = pickAllowed(query.status, STATUS_ORDER) || 'pending';
    this.setData({ status, filters: filterCells(STATUS_ORDER, STATUS_LABELS, status) });
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
      const res = await adminApi.verifications({
        page,
        size: ADMIN_PAGE_SIZE,
        status: this.data.status,
      });
      const list = res?.list ?? [];
      const rows = mergeRows(this.data.rows, list, page, toRow);
      const paging = nextPaging({ ...this.data.paging, page }, list.length, Number(res?.total ?? 0));
      this.setData({
        view: rows.length ? 'list' : 'empty',
        rows,
        paging,
        tail: tailText(paging, '条申请'),
        tailCls: paging.more ? '' : 'ad-end',
        emptyTitle:
          this.data.status === 'pending'
            ? '没有待审的认证申请'
            : `没有「${STATUS_LABELS[this.data.status] ?? this.data.status}」的记录`,
        error: '',
        busy: false,
        updatedAt: clockNow(),
      });
    } catch (e) {
      this.setData({
        view: this.data.rows.length ? 'list' : 'error',
        error: errorText(e, '审核队列没拉到，可以再试一次'),
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
  onFilterTap(e: WechatMiniprogram.TouchEvent) {
    const value = String(e.currentTarget.dataset.value ?? 'pending');
    if (value === this.data.status) return;
    this.setData({
      status: value,
      filters: filterCells(STATUS_ORDER, STATUS_LABELS, value),
      rows: [],
      rejectingId: '',
      rejectDraft: '',
    });
    void this.fetch(1);
  },
  onLoadMore() {
    const p = this.data.paging;
    if (!p.more || p.busy) return;
    void this.fetch(p.page + 1);
  },

  /* ---------- 审核动作 ---------- */
  onApprove(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id ?? '');
    if (!id || this.data.busyId) return;
    wx.showModal({
      title: '通过这条认证？',
      content: '通过后对方立即获得对应身份与权限，此结论会写进审核记录。',
      confirmText: '确认通过',
      success: (res) => {
        if (res.confirm) void this.submit(id, { approved: true });
      },
      // 用户取消也走 fail：这里必须接住且不能报错
      fail: () => undefined,
    });
  },

  onRejectStart(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id ?? '');
    if (!id || this.data.busyId) return;
    this.setData({ rejectingId: id, rejectDraft: '', canReject: false });
  },
  onRejectCancel() {
    this.setData({ rejectingId: '', rejectDraft: '', canReject: false });
  },
  onRejectInput(e: WechatMiniprogram.Input) {
    const v = e.detail.value ?? '';
    this.setData({ rejectDraft: v, canReject: v.trim().length >= MIN_REJECT_REASON });
  },
  onRejectConfirm(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id ?? this.data.rejectingId ?? '');
    const reason = this.data.rejectDraft.trim();
    if (reason.length < MIN_REJECT_REASON) {
      tip(`驳回原因至少 ${MIN_REJECT_REASON} 个字，否则对方不知道该改什么`);
      return;
    }
    void this.submit(id, { approved: false, reason });
  },

  async submit(id: string, body: { approved: boolean; reason?: string }) {
    if (!id || this.data.busyId) return;
    this.setData({ busyId: id });
    try {
      await adminApi.reviewVerification(id, body);
      done(body.approved ? '已通过' : '已驳回');
      this.setData({ busyId: '', rejectingId: '', rejectDraft: '', canReject: false });
      // 重新拉当前页：这条会从"待审"里消失，靠本地剔除会让 total 对不上
      await this.fetch(1);
    } catch (e) {
      this.setData({ busyId: '' });
      tip(errorText(e, '提交失败，可以再试一次'));
    }
  },
});
