/**
 * 钱包与结算（文档 6.6.3 / 6.11）：余额 / 资金流水 / 提现申请 / 提现记录
 * 视觉：翡翠主题 · 余额卡渐变 + 光斑，流水与提现记录按类型配糖果图标（纯展示）
 *
 * ⚠️ 页内的"积分"卡（余额 + 入口）**仅计费模式展示**；免费开放期整块隐藏。
 *    注意余额（wallet.balance，单位分）是另一套资金体系，与积分无关，始终展示。
 *
 * ⚠️ 提现这件事说到哪一步才算诚实（2026-09-19 复核后端，改文案前先看）：
 *    ① `POST /wallet/withdrawals`（M3-13）是真的：同一事务里扣余额 + 记流水 + 建提现单，
 *       余额不足 / 低于起提额都会 40001 报错，页面如实 toast 后端给的原文案；
 *    ② 但**钱目前没有出账通道** —— 平台尚未接入微信商户号，审核后台（M3-20）也未开工，
 *       后端没有 review 接口，所以单子会一直停在 `pending`。界面只能说"已提交 / 审核中"，
 *       **不得出现「T+1」「预计到账」这类承诺**（原先 `withdraw-tip` 写的就是这种话）；
 *    ③ 平台服务费在**订单放款时**已经扣掉（`calcPlatformFee`），提现手续费恒为 0，
 *       所以旧文案"平台服务费 5%（封顶 20 元）"是重复收费的误导，已删。
 *    起提额在页面里只用于**前置提示**（少一次无谓往返），真正的闸在服务端。
 */
import { userApi, walletApi } from '../../utils/api';
import type { WithdrawalItem } from '../../utils/api';
import { POINTS_WALLET_LABEL, loadBillingMode, showPoints } from '../../utils/billing';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { toastError } from '../../utils/request';

interface LedgerRow {
  type: string;
  amountText: string;
  balanceText: string;
  remark: string;
  timeText: string;
  isIncome: boolean;
  /** 纯展示：该笔流水的糖果图标类名 */
  icon: string;
}

/** 提现记录行 = 接口字段 + 展示用派生字段（金额已格式化成元） */
interface WithdrawRow {
  id: string;
  amountText: string;
  feeText: string;
  statusText: string;
  /** 状态配色修饰类，叠在 `.qz-chip` 上（底色交给主题，只改文字色） */
  statusClass: string;
  timeText: string;
  /** 纯展示：该状态的糖果图标类名 */
  icon: string;
}

/**
 * 起提额（分）。
 *
 * ⚠️ 这是后端 `apps/api/src/modules/billing/dto/withdrawal.dto.ts` 的
 * `MIN_WITHDRAW_CENTS` 在小程序侧的**镜像常量** —— 小程序 import 不到后端与
 * `@qz/core`（要"构建 npm"才行），所以只能留一份。两处会漂移，因此：
 *   · 这里的值只用来做前置提示，服务端才是唯一权威（不达标照样 40001 报错）；
 *   · 后端改起提额时必须同步改这里，否则用户会看到"10 元起提"却被服务端拒。
 */
const MIN_WITHDRAW_CENTS = 1000;

/** 列表展示上限（与后端 `WITHDRAWAL_LIST_LIMIT` 一致）：超了要提示"仅展示最近 N 条" */
const WITHDRAWAL_LIST_LIMIT = 50;

/**
 * 提现单状态 → 中文 / 图标 / 配色（纯展示，不参与任何判断）。
 * 本期后端只会给 `pending`（没有 review 接口）；其余分支是为 M3-20 上线后不必改页面。
 * 未知状态一律落到 `OTHER`，**不猜**成"审核中"以外的结论。
 */
const WITHDRAW_STATUS: Record<string, { text: string; icon: string; cls: string }> = {
  pending: { text: '审核中', icon: 'qz-i-clock', cls: '' },
  approved: { text: '审核通过 · 待处理', icon: 'qz-i-check', cls: 'st-ok' },
  paid: { text: '平台已处理', icon: 'qz-i-check', cls: 'st-ok' },
  rejected: { text: '已驳回', icon: 'qz-i-close', cls: 'st-bad' },
};
const WITHDRAW_STATUS_OTHER = { text: '处理中', icon: 'qz-i-clock', cls: '' };

/** 流水类型 → 糖果图标（只影响展示，不参与任何业务判断） */
const TYPE_ICONS: Record<string, string> = {
  income: 'qz-i-orders',
  settle: 'qz-i-chart',
  refund: 'qz-i-gift',
  withdraw: 'qz-i-rocket',
  freeze: 'qz-i-lock',
  expense: 'qz-i-other',
};

Page({
  data: {
    balanceText: '0.00',
    frozenText: '0.00',
    totalIncomeText: '0.00',
    points: 0,
    /** 是否展示积分卡：免费开放期隐藏（界面里不出现"积分"二字） */
    showPoints: false,
    /** 积分卡说明文案（含"积分"二字，统一出自 utils/billing） */
    pointsWalletLabel: POINTS_WALLET_LABEL,
    ledger: [] as LedgerRow[],
    loading: true,
    error: '',
    /** 提现记录：与余额/流水各自独立，任一失败只在自己的区块报错 + 重试 */
    withdrawals: [] as WithdrawRow[],
    withdrawalsLoading: true,
    withdrawalsError: '',
    /** 后端只回最近 50 条，total 是真实总数 —— 超出时如实提示，不让人误以为"只有这些" */
    withdrawalLimited: false,
    withdrawalLimit: WITHDRAWAL_LIST_LIMIT,
    /** 提现申请提交中：按钮文案变"提交中…"+ 防连点（连点会建出两张真实 pending 单） */
    submitting: false,
    /** 余额卡下方说明：单一来源，别在 WXML 里再写一份起提额数字 */
    withdrawTip: `单笔 ${MIN_WITHDRAW_CENTS / 100} 元起提 · 提交后余额即时扣减，进入人工审核`,
    fxStyle: '',
  },

  onShow() {
    fxEnableTilt(this);
    void this.loadAll();
  },

  onHide() {
    fxDisableTilt();
  },

  onUnload() {
    fxDisableTilt();
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

  /** 下拉刷新：余额/流水与提现记录一起重拉，最后必须 stop，否则顶部转圈不停 */
  async onPullDownRefresh() {
    try {
      await this.loadAll();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  /** 两个数据源并行：各自 catch，谁失败谁显示错误条（不让提现记录拖垮余额卡） */
  async loadAll() {
    await Promise.all([this.load(), this.loadWithdrawals()]);
  },

  async load() {
    await loadBillingMode();
    this.setData({ showPoints: showPoints() });
    try {
      const w = await userApi.wallet();
      this.setData({
        balanceText: (w.balance / 100).toFixed(2),
        frozenText: (w.frozen / 100).toFixed(2),
        totalIncomeText: (w.totalIncome / 100).toFixed(2),
        points: w.points,
        ledger: (w.ledger as Record<string, unknown>[]).map((l) => ({
          type: String(l.type),
          amountText: (Number(l.amount) / 100).toFixed(2),
          balanceText: (Number(l.balanceAfter) / 100).toFixed(2),
          remark: String(l.remark ?? typeLabel(String(l.type))),
          timeText: formatTime(String(l.createdAt ?? '')),
          isIncome: ['income', 'refund', 'settle'].includes(String(l.type)),
          icon: typeIcon(String(l.type)),
        })),
        loading: false,
        error: '',
      });
    } catch (e) {
      this.setData({ loading: false, error: (e as Error).message || '钱包加载失败' });
    }
  },

  /** `GET /wallet/withdrawals`：按申请时间倒序，最多 50 条（M3-13） */
  async loadWithdrawals() {
    this.setData({ withdrawalsLoading: true, withdrawalsError: '' });
    try {
      const res = await walletApi.withdrawals();
      const list = res.list.map(toWithdrawRow);
      this.setData({
        withdrawals: list,
        // total 是真实总数：大于本次条数说明还有更早的申请没显示，如实说明
        withdrawalLimited: res.total > list.length,
        withdrawalsLoading: false,
      });
    } catch (e) {
      this.setData({
        withdrawalsLoading: false,
        withdrawalsError: (e as Error).message || '提现记录加载失败',
      });
    }
  },

  onRetry() {
    void this.load();
  },

  onRetryWithdrawals() {
    void this.loadWithdrawals();
  },

  /**
   * 申请提现：金额输入（元）→ 本地前置校验 → `POST /wallet/withdrawals`（分）。
   *
   * ⚠️ 历史：这里以前校验完金额就弹一句「提现申请已提交 / 预计 T+1 到账」，
   * 却**一个接口都没调**（红线：不许假成功）。现在真的建单，
   * 服务端报错（余额不足 / 低于起提额 / 金额非整数）原样 toast ——
   * 后端文案已带"当前可提现多少、本次申请多少、下一步做什么"，不要再套一层。
   *
   * ⚠️ 成功只等于"申请已提交、进入审核"，**不等于钱到账**：见文件头的三点说明。
   */
  onWithdraw() {
    // 余额卡与空态各有一个入口：连点会开出第二个弹窗，确认后就是一笔重复申请
    if (this.data.submitting) {
      wx.showToast({ title: '上一笔提现正在提交，请稍候', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '申请提现',
      editable: true,
      placeholderText: `请输入提现金额（元，${MIN_WITHDRAW_CENTS / 100} 元起提）`,
      success: (res) => {
        if (res.confirm) void this.submitWithdraw(res.content ?? '');
      },
    });
  },

  async submitWithdraw(input: string) {
    if (this.data.submitting) return; // 兜底：正常路径已由 onWithdraw 挡住
    const cents = parseYuanToCents(input);
    if (cents === null) {
      wx.showToast({ title: '请输入正确金额（最多两位小数）', icon: 'none' });
      return;
    }
    if (cents < MIN_WITHDRAW_CENTS) {
      wx.showToast({ title: `单笔提现不能低于 ${MIN_WITHDRAW_CENTS / 100} 元`, icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    try {
      await walletApi.withdraw(cents);
      // 只说"已提交 / 审核中"：不提"到账"，因为本期没有出账通道（见文件头）
      wx.showToast({ title: '提现申请已提交，审核中', icon: 'none', duration: 2500 });
      await this.loadAll();
    } catch (e) {
      toastError(e);
    } finally {
      this.setData({ submitting: false });
    }
  },

  onPointsTap() {
    wx.navigateTo({ url: '/pkg-mine/credit/index?tab=points' });
  },
});

function typeLabel(t: string): string {
  const m: Record<string, string> = {
    income: '订单收入',
    expense: '支出',
    refund: '退款',
    withdraw: '提现',
    settle: '结算入账',
    freeze: '担保冻结',
  };
  return m[t] ?? t;
}

function typeIcon(t: string): string {
  return TYPE_ICONS[t] ?? 'qz-i-wallet';
}

/** ISO8601 → `2026-09-19 20:04`（流水与提现记录共用同一时间口径） */
function formatTime(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

/** 提现记录条目 → 列表行 */
function toWithdrawRow(w: WithdrawalItem): WithdrawRow {
  const st = WITHDRAW_STATUS[w.status] ?? WITHDRAW_STATUS_OTHER;
  return {
    id: w.id,
    amountText: (w.amount / 100).toFixed(2),
    // 手续费本期恒为 0（平台费在订单放款时已扣）：明写出来，抵掉旧的"5% 服务费"误导
    feeText: `手续费 ¥${(w.fee / 100).toFixed(2)}`,
    statusText: st.text,
    statusClass: st.cls,
    timeText: formatTime(w.createdAt),
    icon: st.icon,
  };
}

/**
 * 「元」输入 → 「分」整数（红线 4：金额禁止浮点）。
 *
 * 刻意按字符串逐位取，不用 `Math.round(Number(v) * 100)`：
 * 浮点会让 `1.15 * 100 = 114.99999999999999`、`0.07 * 100 = 7.000000000000001`，
 * 大多数情况被 round 救回来，但"钱差一分"落到账务上就是极难复现的对账不平。
 * 顺带挡住 `¥` / 千分位空格，以及三位以上小数（后端只收整数分，超精度的意图不该猜）。
 */
function parseYuanToCents(raw: string): number | null {
  const text = raw.trim().replace(/[¥￥,\s]/g, '');
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}
