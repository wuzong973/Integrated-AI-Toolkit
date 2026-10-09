/**
 * AA 分账（纯函数，不依赖 wx API）
 *
 * ## 为什么放在小程序侧而不是 `packages/core`
 *
 * 与 `utils/gpa.ts` 同一条约束：**小程序不能 `import @qz/core`**
 * （开发者工具解析不到，`project.config.json` 的 `packNpmRelationList` 是空的）。
 * 放进 core 只会得到一份零调用方的悬空实现。
 *
 * ## 两条不能含糊的地方
 *
 * ### 1. 金额一律「分」整数（红线 4）
 *
 * 界面让用户填「元」（人只认元），算法内部一律**分**。
 * 若用元做浮点累加，`0.1 + 0.2 !== 0.3` 会直接变成"分完还差一分钱"，
 * 而且**每一笔都看起来正常**，只有最后对不上账才暴露 —— 这正是红线 4 要防的。
 * 元 ↔ 分的转换只允许走 `parseYuanToCents` / `formatCents` 两个口子。
 *
 * ### 2. 均摊必须精确到分，Σ 恰好等于总额
 *
 * 100 分 3 个人分，每人 33.333… 分 —— 现实里不存在"三分之一分"。
 * 做法：`base = floor(total / n)`，余数 `total - base*n` 逐个 +1 分给前几个人。
 * 这样 Σ 恒等于 `total`，**永远不会凭空多出或少掉一分钱**。
 * 测试里有一条专门断言"任意 n 与任意总额，Σ 份额 == 总额"。
 *
 * ## 算法：债务最小化
 *
 * 朴素做法是"谁欠谁就转给谁"，一笔账一笔转账，n 个人的聚会能列出十几笔。
 * 这里先把每个人的**净额**（垫付 − 应摊）算出来，再用贪心配对：
 * **最大债务人 ↔ 最大债权人**，逐笔冲抵到一方清零。
 *
 * ⚠️ 诚实说明：贪心给出的是 **≤ n−1 笔**，**不保证全局最少笔数**
 * （严格最少是 NP-hard，人少时贪心与最优一致或差一笔）。
 * 但它永远不会算错金额，只是可能多一笔转账 —— 这个取舍对 AA 场景是划算的。
 * **不要**在界面上写"最少笔数"，那是我们保证不了的。
 */

/** 一次分账里的成员 */
export interface SplitMember {
  id: string;
  name: string;
}

/** 一笔支出。`amountCents` 是**分**；`memberIds` 是这笔账由谁分摊 */
export interface SplitExpense {
  payerId: string;
  amountCents: number;
  memberIds: string[];
}

/** 某人的结算状态 */
export interface MemberBalance {
  id: string;
  name: string;
  /** 一共垫付了多少（分） */
  paidCents: number;
  /** 一共应该承担多少（分） */
  owedCents: number;
  /** 净额（分）：> 0 该收回，< 0 该补付，= 0 已结清 */
  netCents: number;
}

/** 一笔转账建议 */
export interface Settlement {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  amountCents: number;
}

export interface SplitResult {
  balances: MemberBalance[];
  settlements: Settlement[];
  /** 全部支出的合计（分） */
  totalCents: number;
  /** 空串表示一切正常；非空表示**输入有问题、结果不可用** */
  error: string;
}

/**
 * 把「元」字符串解析成「分」整数。
 *
 * 无效（空 / 非数字 / 超过两位小数 / 负数 / 超出安全整数）一律返回 `null`，
 * 由调用方决定是忽略还是提示 —— **不要返回 NaN 混进后面的加法**。
 *
 * ⚠️ 刻意不接受 `.5` 这种写法（必须以数字开头）：让"格式不对"尽早暴露，
 * 而不是被 `Number('.5')` 悄悄收下。
 */
export function parseYuanToCents(raw: string): number | null {
  const s = String(raw ?? '').trim();
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [yuan, frac = ''] = s.split('.');
  const cents = Number(yuan) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** 「分」→ 展示用字符串（不带货币符号，符号交给界面决定） */
export function formatCents(cents: number): string {
  const rounded = Math.round(cents);
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * 把 `totalCents` 均摊给 `n` 个人，返回每人的份额。
 *
 * 保证 `sum(result) === totalCents`（余数逐个 +1 分给前面的人）。
 */
function splitEvenly(totalCents: number, n: number): number[] {
  const base = Math.floor(totalCents / n);
  let rest = totalCents - base * n;
  return Array.from({ length: n }, () => {
    if (rest > 0) {
      rest -= 1;
      return base + 1;
    }
    return base;
  });
}

const fail = (error: string): SplitResult => ({
  balances: [],
  settlements: [],
  totalCents: 0,
  error,
});

/**
 * 计算分账方案。
 *
 * 返回 `error` 非空时，`balances` / `settlements` 一律为空 ——
 * **宁可什么都不给，也不给一份算错的结果**（红线 8）。
 */
export function computeSplit(
  members: readonly SplitMember[],
  expenses: readonly SplitExpense[],
): SplitResult {
  const known = new Set(members.map((m) => m.id));
  const paid = new Map(members.map((m) => [m.id, 0]));
  const owed = new Map(members.map((m) => [m.id, 0]));
  let totalCents = 0;

  for (const e of expenses) {
    // 金额为空 / 非正数：用户边填边算的中间态，跳过而不是报错
    if (!Number.isFinite(e.amountCents) || e.amountCents <= 0) continue;

    if (!known.has(e.payerId)) return fail('有一笔账的付款人不在成员名单里');
    if (!e.memberIds.length) return fail('有一笔账还没有勾选参与人');

    // 同一人被勾选两次会让这笔钱被重复摊到（金额看起来还"对得上"，更难发现）
    const ids = [...new Set(e.memberIds)];
    if (ids.some((id) => !known.has(id))) return fail('有一笔账勾选了已删除的成员');

    const shares = splitEvenly(e.amountCents, ids.length);
    paid.set(e.payerId, paid.get(e.payerId)! + e.amountCents);
    ids.forEach((id, i) => owed.set(id, owed.get(id)! + shares[i]));
    totalCents += e.amountCents;
  }

  const balances: MemberBalance[] = members.map((m) => {
    const p = paid.get(m.id)!;
    const o = owed.get(m.id)!;
    return { id: m.id, name: m.name, paidCents: p, owedCents: o, netCents: p - o };
  });

  return {
    balances,
    settlements: settle(balances),
    totalCents,
    error: '',
  };
}

/**
 * 贪心冲抵：最大债务人 ↔ 最大债权人。
 *
 * 排序时用 `id` 做二级键，保证**同样输入永远得到同样方案** ——
 * 否则界面上每次重算顺序都可能变，用户会以为数据在跳。
 */
function settle(balances: readonly MemberBalance[]): Settlement[] {
  const creditors = balances
    .filter((b) => b.netCents > 0)
    .map((b) => ({ id: b.id, name: b.name, left: b.netCents }))
    .sort((a, b) => b.left - a.left || a.id.localeCompare(b.id));
  const debtors = balances
    .filter((b) => b.netCents < 0)
    .map((b) => ({ id: b.id, name: b.name, left: -b.netCents }))
    .sort((a, b) => b.left - a.left || a.id.localeCompare(b.id));

  const out: Settlement[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amountCents = Math.min(debtors[i].left, creditors[j].left);
    if (amountCents > 0) {
      out.push({
        fromId: debtors[i].id,
        fromName: debtors[i].name,
        toId: creditors[j].id,
        toName: creditors[j].name,
        amountCents,
      });
    }
    debtors[i].left -= amountCents;
    creditors[j].left -= amountCents;
    if (debtors[i].left === 0) i += 1;
    if (creditors[j].left === 0) j += 1;
  }
  return out;
}
