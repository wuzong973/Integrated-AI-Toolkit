/**
 * 驿站智能匹配（任务清单 M3-09，设计文档 6.6.2）
 *
 * ## 为什么必须有它
 *
 * 在此之前，"匹配度"是小程序工作台里**算出来的一个假数字**
 * （`Math.max(60, 95 - i * 7)`）—— 它按列表序号递减，与技能、信用、距离毫无关系，
 * 却以百分比的形式展示给服务者（"匹配度 95%"）。这是红线 10 明令禁止的形态：
 * 用户无法分辨它是算出来的还是编的，而它**看起来完全可信**。
 *
 * 静态守卫也拦不住它：守卫只检查"声明了 `DEMO_*` 常量却没挂演示标记"，
 * 而这种内联的 `Math.max(...)` 既没声明常量、也没用演示数据，
 * 从代码上看就是一次普通的计算。**只有把它换成真算法才能根治。**
 *
 * ## 评分口径：完全照抄设计文档，但把满分归一化到 100
 *
 * 文档给的权重合计是 **105**（40+20+15+15+10+5），不是 100。
 * 直接展示会出现「匹配度 105%」这种明显说不通的数字，
 * 所以这里按满分 105 归一化到 0~100 —— **排序结果不变**，但数值有意义。
 *
 * ## 冷启动：新服务者给"中性分"，不给 0 也不给满分
 *
 * 没有历史订单时，完成率与价格两项无数据可算。
 * 给 0 会把新服务者**系统性地压在底部**（而校园场景下服务者本来就少，
 * 文档 6.6.2 的冷启动策略明确要求降低入驻门槛）；
 * 给满分则让"零经验"排在有实绩的人前面。所以取中性值（权重的 60%），
 * 并在 `reasons` 里如实说明"暂无历史数据"。
 */

/** 各维度满分（设计文档 6.6.2）。合计 105 —— 见文件头说明 */
export const MATCH_WEIGHTS = {
  skill: 40,
  credit: 20,
  completion: 15,
  distance: 15,
  price: 10,
  activity: 5,
} as const;

/** 归一化分母：权重合计。写死为常量而不是运行时求和，避免有人改了权重却忘了改它 */
export const MATCH_MAX_RAW = 105;

/** 无历史数据时的中性比例（完成率 / 价格两项用） */
const NEUTRAL_RATIO = 0.6;

/** 价格匹配的容差：服务者历史均价落在预算 ±30% 内得满分 */
const PRICE_TOLERANCE = 0.3;

/** 活跃度分档：距今天数上限 → 得分比例 */
const ACTIVITY_TIERS: readonly [number, number][] = [
  [3, 1],
  [7, 0.6],
  [30, 0.2],
];

/** 服务者候选（由调用方从库里查出来，本模块不碰数据库） */
export interface MatchCandidate {
  userId: string;
  /** 技能标签（user_profile.skills） */
  skills: readonly string[];
  creditScore: number;
  completedOrders: number;
  /** 该服务者被取消 / 退款的订单数 */
  canceledOrders: number;
  /** 历史成交均价（分）；0 表示没有历史 */
  avgPriceCents: number;
  /** 与任务发布者同校 */
  sameSchool: boolean;
  /** 与任务发布者同城（不同校） */
  sameCity: boolean;
  lastActiveAt: Date | null;
}

/** 被匹配的任务 */
export interface MatchTask {
  /** 任务要求的技能标签 */
  skillTags: readonly string[];
  /** 预算（分） */
  budget: number;
}

/** 各维度得分（便于前端展示"为什么是这个分"，也便于排障） */
export interface MatchBreakdown {
  skill: number;
  credit: number;
  completion: number;
  distance: number;
  price: number;
  activity: number;
}

export interface MatchResult {
  /** 归一化后的匹配度，0~100 整数 */
  score: number;
  breakdown: MatchBreakdown;
  /** 给用户看的一句话理由（不含编造信息） */
  reasons: string[];
}

/** 技能匹配度：交集 / 任务标签数 × 40。任务没填标签时给中性分 */
function scoreSkill(task: MatchTask, c: MatchCandidate): number {
  if (task.skillTags.length === 0) return MATCH_WEIGHTS.skill * NEUTRAL_RATIO;
  const have = new Set(c.skills);
  const hit = task.skillTags.filter((t) => have.has(t)).length;
  return (hit / task.skillTags.length) * MATCH_WEIGHTS.skill;
}

/** 信用分：(credit - 60) / 40 × 20，60 以下得 0 */
function scoreCredit(c: MatchCandidate): number {
  const ratio = Math.min(1, Math.max(0, (c.creditScore - 60) / 40));
  return ratio * MATCH_WEIGHTS.credit;
}

/** 历史完成率：completed / (completed + canceled) × 15；无历史给中性分 */
function scoreCompletion(c: MatchCandidate): number {
  const total = c.completedOrders + c.canceledOrders;
  if (total === 0) return MATCH_WEIGHTS.completion * NEUTRAL_RATIO;
  return (c.completedOrders / total) * MATCH_WEIGHTS.completion;
}

/** 距离：同校满分，同城次之，其余 0 */
function scoreDistance(c: MatchCandidate): number {
  if (c.sameSchool) return MATCH_WEIGHTS.distance;
  if (c.sameCity) return MATCH_WEIGHTS.distance * 0.53; // ≈ 8/15，与文档的 8 分对齐
  return 0;
}

/**
 * 价格：历史均价落在预算 ±30% 内满分，超出后线性递减到 0。
 *
 * ## 容差判定必须用整数比较
 *
 * 直觉写法是 `Math.abs(avg / budget - 1) <= 0.3`，但它在**边界上会判错**：
 * 预算 300 元、均价 210 元时 `210/300 = 0.7`，而 `|0.7 - 1|` 得到的是
 * `0.30000000000000004` —— 比 0.3 大，于是"刚好在容差内"被判成超差。
 * 金额本来就是整数分，直接用 `10 * |差| <= 3 * 预算` 等价且精确。
 *
 * 递减的终点定在"偏差 100%"（均价是预算的 2 倍或 0）：再离谱也不会是负分。
 */
function scorePrice(task: MatchTask, c: MatchCandidate): number {
  if (c.avgPriceCents <= 0 || task.budget <= 0) return MATCH_WEIGHTS.price * NEUTRAL_RATIO;

  const diff = Math.abs(c.avgPriceCents - task.budget);
  if (10 * diff <= 3 * task.budget) return MATCH_WEIGHTS.price;

  const over = diff / task.budget - PRICE_TOLERANCE;
  return Math.max(0, MATCH_WEIGHTS.price * (1 - over / (1 - PRICE_TOLERANCE)));
}

/** 活跃度：越近越活跃。`now` 可注入，便于用假时钟测 */
function scoreActivity(c: MatchCandidate, now: Date): number {
  if (!c.lastActiveAt) return 0;
  const days = (now.getTime() - c.lastActiveAt.getTime()) / 86_400_000;
  for (const [limit, ratio] of ACTIVITY_TIERS) {
    if (days <= limit) return MATCH_WEIGHTS.activity * ratio;
  }
  return 0;
}

/**
 * 计算单个服务者对某任务的匹配度。
 *
 * `now` 显式传入而不是内部取 `new Date()` —— 活跃度依赖它，
 * 而"测起来会随真实时间漂移"的函数没法写稳定的单测。
 */
export function calcMatchScore(
  task: MatchTask,
  candidate: MatchCandidate,
  now: Date = new Date(),
): MatchResult {
  const breakdown: MatchBreakdown = {
    skill: scoreSkill(task, candidate),
    credit: scoreCredit(candidate),
    completion: scoreCompletion(candidate),
    distance: scoreDistance(candidate),
    price: scorePrice(task, candidate),
    activity: scoreActivity(candidate, now),
  };

  const raw = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return {
    // 归一化到 0~100：权重合计是 105，不归一化会出现"匹配度 105%"
    score: Math.round((raw / MATCH_MAX_RAW) * 100),
    breakdown,
    reasons: buildReasons(task, candidate, breakdown),
  };
}

/** 拼出"为什么是这个分"。只陈述事实，不做推测 */
function buildReasons(
  task: MatchTask,
  c: MatchCandidate,
  b: MatchBreakdown,
): string[] {
  const reasons: string[] = [];
  const have = new Set(c.skills);

  if (task.skillTags.length) {
    const hit = task.skillTags.filter((t) => have.has(t));
    reasons.push(
      hit.length ? `技能命中 ${hit.length}/${task.skillTags.length}：${hit.join('、')}` : '技能标签未命中',
    );
  } else if (b.skill > 0) {
    reasons.push('任务未指定技能标签');
  }

  reasons.push(`信用分 ${c.creditScore}`);
  if (c.completedOrders + c.canceledOrders > 0) {
    reasons.push(`完成 ${c.completedOrders} 单 / 取消 ${c.canceledOrders} 单`);
  } else {
    reasons.push('暂无历史订单');
  }

  if (c.sameSchool) reasons.push('同校');
  else if (c.sameCity) reasons.push('同城');

  if (b.price === MATCH_WEIGHTS.price) reasons.push('历史报价贴合预算');
  else if (c.avgPriceCents <= 0) reasons.push('暂无历史报价');
  else reasons.push('历史报价与预算偏差较大');

  return reasons;
}
