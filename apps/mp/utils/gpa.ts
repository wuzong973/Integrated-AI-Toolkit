/**
 * GPA / 绩点计算（纯函数，不依赖 wx API）
 *
 * ## 为什么放在小程序侧，而不是 `packages/core`
 *
 * ⚠️ **小程序不能 `import @qz/core`** —— 微信开发者工具解析不到，
 * 需要"构建 npm"配合，而本项目 `project.config.json` 的 `packNpmRelationList` 是空的。
 * 这与 `utils/os.ts` 里记的是同一条约束。
 *
 * 所以放进 core 只会得到一个**零调用方的悬空实现**（后端也不用它）——
 * 而红线明确反对制造悬空能力。**一份实现、一份测试，好过两份会漂移的副本。**
 *
 * ## 为什么算法必须可单测
 *
 * 绩点算错是学生最敏感的事。测试放在 `tests/gpa.spec.ts`
 *（小程序发布包内不能放 spec 文件，会被开发者工具"过滤无依赖文件"点名）。
 *
 * ## 为什么只实现两种口径
 *
 * 各校算法差异很大（区间表 / 公式 / 只算加权平均分）。这里只实现**被最广泛引用**的两种；
 * 要加本校口径就在 `toPoint` 里补一个分支，而不是在页面里另写一套。
 */

/** 支持的绩点口径 */
export const GPA_SCALES = ['standard4', 'formula5'] as const;
export type GpaScale = (typeof GPA_SCALES)[number];

/** 口径的中文名（界面直接用，避免各页面各写一份文案） */
export const GPA_SCALE_LABELS: Record<GpaScale, string> = {
  standard4: '标准 4.0 制（区间表）',
  formula5: '5.0 公式制（60 分 = 1.0）',
};

export interface CourseScore {
  name: string;
  /** 百分制成绩（会被夹到 0~100） */
  score: number;
  /** 学分，必须 > 0；非正数的条目会被忽略 */
  credit: number;
}

export interface GpaItem {
  name: string;
  score: number;
  credit: number;
  /** 该门课的绩点 */
  point: number;
}

export interface GpaResult {
  /** 学分加权平均绩点 */
  gpa: number;
  /** 学分加权平均分（百分制）—— 有的学校 / 留学申请看这个而不是绩点 */
  average: number;
  totalCredits: number;
  items: GpaItem[];
}

/**
 * 4.0 制区间表（降序，`find` 取第一个 `score >= min` 的档）。
 *
 * ⚠️ 表必须**降序**。升序会让 95 分匹配到 60 分那一档 —— 而且不会报错，
 * 只会安静地算出一个偏低的绩点（最坏的那种错法）。
 */
const TABLE_4: readonly (readonly [number, number])[] = [
  [90, 4.0],
  [85, 3.7],
  [82, 3.3],
  [78, 3.0],
  [75, 2.7],
  [72, 2.3],
  [68, 2.0],
  [64, 1.5],
  [60, 1.0],
];

const round2 = (n: number): number => Math.round(n * 100) / 100;

const clampScore = (n: number): number => Math.min(100, Math.max(0, n));

/** 百分制成绩 → 绩点 */
export function toPoint(score: number, scale: GpaScale = 'standard4'): number {
  const s = clampScore(score);
  if (scale === 'formula5') {
    // 60 分 = 1.0，每多 10 分 +1，上限 5.0；不及格记 0
    return s < 60 ? 0 : round2(Math.min(5, (s - 50) / 10));
  }
  return TABLE_4.find(([min]) => s >= min)?.[1] ?? 0;
}

/**
 * 计算加权绩点。
 *
 * 学分 <= 0 或成绩非有限数的条目会被**静默忽略**而不是报错：
 * 用户边填边算时中间态（还没填学分）是常态，报错会让人没法用。
 * 但如果**一条有效条目都没有**，返回零值结果（而不是 NaN）——
 * 界面可以据此显示"还没有可计算的数据"。
 */
export function computeGpa(
  courses: readonly CourseScore[],
  scale: GpaScale = 'standard4',
): GpaResult {
  const items: GpaItem[] = [];
  for (const c of courses) {
    if (!Number.isFinite(c.score) || !Number.isFinite(c.credit) || c.credit <= 0) continue;
    const score = clampScore(c.score);
    items.push({ name: c.name, score, credit: c.credit, point: toPoint(score, scale) });
  }

  const totalCredits = items.reduce((a, i) => a + i.credit, 0);
  if (totalCredits <= 0) {
    return { gpa: 0, average: 0, totalCredits: 0, items };
  }

  const sum = (pick: (i: GpaItem) => number) => items.reduce((a, i) => a + pick(i) * i.credit, 0);

  return {
    gpa: round2(sum((i) => i.point) / totalCredits),
    average: round2(sum((i) => i.score) / totalCredits),
    totalCredits: round2(totalCredits),
    items,
  };
}
