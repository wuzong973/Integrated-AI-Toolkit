/**
 * AA 分账（校园小工具）
 *
 * ## 为什么是本地页面而不是工具箱工具
 *
 * 与绩点计算同因：工具箱的"同步"路径**仍会建作业记录并预扣积分**
 * （`ToolInvokeService.invoke`），算一次 AA 就留一条作业是明显的错配。
 * 纯计算没有副作用，就该待在本地 —— 秒出结果、离线可用、不占额度。
 *
 * ## 算法不在这里
 *
 * 全在 `utils/split-bill.ts`（纯函数、16 条单测）。页面只做三件事：
 *   ① 收集输入（成员 / 账单）；
 *   ② 把「元」交给 `parseYuanToCents` 转成分（红线 4：金额一律「分」整数）；
 *   ③ 把 `error` 原样显示出来 —— **算不出方案时不给半份结果**。
 */
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import {
  computeSplit,
  formatCents,
  parseYuanToCents,
  type SplitExpense,
  type SplitMember,
  type SplitResult,
} from '../../utils/split-bill';

interface MemberRow {
  id: string;
  name: string;
}

interface ParticipantRow {
  id: string;
  label: string;
  picked: boolean;
}

interface ExpenseRow {
  id: string;
  /** 付款人在成员列表中的下标（picker 只认下标） */
  payerIndex: number;
  /** 用户填的是「元」字符串，允许边填边算 */
  amount: string;
  participants: ParticipantRow[];
}

/** 展示行：WXML 里不能调函数，所有金额与文案必须在这里先算好 */
interface BalanceRow {
  id: string;
  name: string;
  state: 'in' | 'out' | 'even';
  stateText: string;
  amountText: string;
}

interface SettleRow {
  key: string;
  fromName: string;
  toName: string;
  amountText: string;
}

let seq = 0;
const nextId = (p: string): string => `${p}${(seq += 1)}`;

const INITIAL_MEMBERS = 3;

const newMembers = (): MemberRow[] =>
  Array.from({ length: INITIAL_MEMBERS }, () => ({ id: nextId('m'), name: '' }));

const label = (m: MemberRow, i: number): string => m.name.trim() || `成员 ${i + 1}`;

const newExpense = (members: MemberRow[]): ExpenseRow => ({
  id: nextId('e'),
  payerIndex: 0,
  amount: '',
  participants: members.map((m, i) => ({ id: m.id, label: label(m, i), picked: true })),
});

/**
 * 净额 → 展示行。
 *
 * ⚠️ 「该补付」显示的是**绝对值** —— 金额前面已经写了"该补付"，
 * 再显示 `-25.00` 会让人以为是"倒欠 25"，反而看不懂。
 */
function toBalanceRow(b: { id: string; name: string; netCents: number }): BalanceRow {
  if (b.netCents > 0) {
    return { id: b.id, name: b.name, state: 'in', stateText: '该收回', amountText: formatCents(b.netCents) };
  }
  if (b.netCents < 0) {
    return { id: b.id, name: b.name, state: 'out', stateText: '该补付', amountText: formatCents(-b.netCents) };
  }
  return { id: b.id, name: b.name, state: 'even', stateText: '已结清', amountText: '0.00' };
}

Page({
  data: {
    fxStyle: '',
    members: [] as MemberRow[],
    /** picker 用的成员名（与 members 同序） */
    memberLabels: [] as string[],
    expenses: [] as ExpenseRow[],
    result: null as SplitResult | null,
    /** 是否已算过（区分"还没算"与"算了但没有有效数据"） */
    computed: false,
    /** 以下三项是给 WXML 用的展示层数据（WXML 不能调函数） */
    totalText: '',
    balanceRows: [] as BalanceRow[],
    settleRows: [] as SettleRow[],
  },

  onLoad() {
    const members = newMembers();
    this.setData({ members, expenses: [newExpense(members)] }, () => this.recompute());
  },

  /** 倾斜视差只能在这里开（**不能放 onLoad**，见 docs/dev/MP-VISUAL-SYSTEM.md §六） */
  onShow() {
    fxEnableTilt(this);
  },

  onHide() {
    fxDisableTilt();
  },

  /* ---------- 装饰视差（只动装饰层，内容区不跟随） ---------- */

  onFxStart(e: WechatMiniprogram.TouchEvent) {
    fxStart(this, e);
  },

  onFxMove(e: WechatMiniprogram.TouchEvent) {
    fxMove(this, e);
  },

  onFxEnd() {
    fxEnd(this);
  },

  /* ---------- 成员 ---------- */

  onMemberInput(e: WechatMiniprogram.Input) {
    const i = Number((e.currentTarget.dataset as { index: string }).index);
    const members = this.data.members.slice();
    members[i] = { ...members[i], name: e.detail.value };
    this.setData({ members }, () => this.syncMembers());
  },

  onAddMember() {
    this.setData({ members: [...this.data.members, { id: nextId('m'), name: '' }] }, () =>
      this.syncMembers(),
    );
  },

  onRemoveMember(e: WechatMiniprogram.TouchEvent) {
    const i = Number((e.currentTarget.dataset as { index: string }).index);
    const removed = this.data.members[i];
    const members = this.data.members.filter((_, idx) => idx !== i);
    // 至少留两人：只剩一个人时"分账"这件事没有意义
    if (members.length < 2) {
      wx.showToast({ title: '至少保留两位成员', icon: 'none' });
      return;
    }
    // 被删掉的成员要从所有账单里剔除，否则会变成"付款人不存在"的死账
    const expenses = this.data.expenses.map((x) => ({
      ...x,
      payerIndex: x.payerIndex > i ? x.payerIndex - 1 : Math.min(x.payerIndex, members.length - 1),
      participants: x.participants.filter((p) => p.id !== removed.id),
    }));
    this.setData({ members, expenses }, () => this.recompute());
  },

  /** 成员增删改名后重建每个账单的参与人勾选（保留已勾选状态） */
  syncMembers() {
    const { members, expenses } = this.data;
    const labels = members.map(label);
    this.setData(
      {
        memberLabels: labels,
        expenses: expenses.map((x) => {
          const picked = new Map(x.participants.map((p) => [p.id, p.picked]));
          return {
            ...x,
            payerIndex: Math.min(x.payerIndex, members.length - 1),
            participants: members.map((m, i) => ({
              id: m.id,
              label: labels[i],
              picked: picked.get(m.id) ?? true,
            })),
          };
        }),
      },
      () => this.recompute(),
    );
  },

  /* ---------- 账单 ---------- */

  onPayerChange(e: WechatMiniprogram.PickerChange) {
    const id = (e.currentTarget.dataset as { id: string }).id;
    const idx = Number(e.detail.value);
    this.patchExpense(id, (x) => ({ ...x, payerIndex: idx }));
  },

  onAmountInput(e: WechatMiniprogram.Input) {
    const id = (e.currentTarget.dataset as { id: string }).id;
    const value = e.detail.value;
    this.patchExpense(id, (x) => ({ ...x, amount: value }));
  },

  onToggleParticipant(e: WechatMiniprogram.TouchEvent) {
    const { id, mid } = e.currentTarget.dataset as { id: string; mid: string };
    this.patchExpense(id, (x) => ({
      ...x,
      participants: x.participants.map((p) => (p.id === mid ? { ...p, picked: !p.picked } : p)),
    }));
  },

  /** 一键全选 / 全不选（人一多，逐个点很烦） */
  onToggleAllParticipants(e: WechatMiniprogram.TouchEvent) {
    const id = (e.currentTarget.dataset as { id: string }).id;
    this.patchExpense(id, (x) => {
      const all = x.participants.every((p) => p.picked);
      return { ...x, participants: x.participants.map((p) => ({ ...p, picked: !all })) };
    });
  },

  onAddExpense() {
    this.setData({ expenses: [...this.data.expenses, newExpense(this.data.members)] }, () =>
      this.recompute(),
    );
  },

  onRemoveExpense(e: WechatMiniprogram.TouchEvent) {
    const id = (e.currentTarget.dataset as { id: string }).id;
    const expenses = this.data.expenses.filter((x) => x.id !== id);
    // 至少留一行，否则界面空白，用户不知道该怎么继续
    this.setData({ expenses: expenses.length ? expenses : [newExpense(this.data.members)] }, () =>
      this.recompute(),
    );
  },

  onReset() {
    const members = newMembers();
    this.setData({ members, expenses: [newExpense(members)] }, () => this.recompute());
  },

  /** 改一行账单并重算 */
  patchExpense(id: string, fn: (x: ExpenseRow) => ExpenseRow) {
    this.setData({ expenses: this.data.expenses.map((x) => (x.id === id ? fn(x) : x)) }, () =>
      this.recompute(),
    );
  },

  /* ---------- 计算 ---------- */

  /**
   * 重算。
   *
   * ⚠️ 空金额**不报错**：用户边填边算是常态。空值由 `parseYuanToCents` 返回 null，
   * 这里转成 0 交给 `computeSplit` 跳过；只有"一笔有效账单都没有"时显示空态。
   */
  recompute() {
    const { members, expenses } = this.data;
    if (members.length < 2) {
      this.setData({
        result: null,
        computed: true,
        totalText: '',
        balanceRows: [],
        settleRows: [],
      });
      return;
    }

    const payload: SplitMember[] = members.map((m, i) => ({ id: m.id, name: label(m, i) }));
    const bills: SplitExpense[] = expenses.map((x) => ({
      payerId: members[x.payerIndex]?.id ?? '',
      amountCents: parseYuanToCents(x.amount) ?? 0,
      memberIds: x.participants.filter((p) => p.picked).map((p) => p.id),
    }));

    const result = computeSplit(payload, bills);
    this.setData({
      result,
      computed: true,
      totalText: formatCents(result.totalCents),
      balanceRows: result.balances.map(toBalanceRow),
      settleRows: result.settlements.map((s, i) => ({
        key: `${i}-${s.fromId}-${s.toId}`,
        fromName: s.fromName,
        toName: s.toName,
        amountText: formatCents(s.amountCents),
      })),
    });
  },

  /* ---------- 展示辅助（WXML 里不能调函数） ---------- */

  onCopyPlan() {
    const r = this.data.result;
    if (!r || r.error || !r.settlements.length) return;
    const lines = r.settlements.map(
      (s) => `${s.fromName} → ${s.toName}  ¥${formatCents(s.amountCents)}`,
    );
    wx.setClipboardData({ data: lines.join('\n') });
  },
});
