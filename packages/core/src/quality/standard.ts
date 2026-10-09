/**
 * AI 产出质量标准（唯一权威版本）
 *
 * 对应文档：`docs/dev/AI-OUTPUT-QUALITY-STANDARD.md`
 *
 * ## 为什么标准要放 packages/core 而不是只写在文档里
 *
 * 只写在文档里的标准没有人执行：模型不知道字数下限、渲染器不知道留白上限、
 * 图表不知道何时该用雷达图，于是"标准"变成一份没人读的愿望清单。
 * 把阈值做成**常量 + 纯函数**之后，同一个数字同时服务三处：
 *   ① 生成提示词 —— 阈值原样写进 system prompt，模型当场就知道要写够多少字；
 *   ② 生成后质检 —— 产出立刻打分，不达标可见，而不是等用户发现太短；
 *   ③ 静态守卫与单测 —— 阈值漂移会被 CI 拦下。
 *
 * ## 三条纪律
 *
 * - **诚实优先**：任何"丰富度"的提升都不允许靠编造数字实现。数字要么有来源，
 *   要么显式标注「示例 / 估算 / 需核实」（红线 10）。
 * - **阈值可测**：每个阈值都必须能用字符数、条数、比例算出来，不接受"感觉更丰富"。
 * - **标准与实现同源**：本文件是常量的唯一来源，文档只解释"为什么是这个数"。
 */

/** 内容完整性：按文档类型的正文字数下限（中文按字符计，含标点，不含 Markdown 语法） */
export const CONTENT_MIN_CHARS: Record<string, number> = {
  business_plan: 3000,
  event_plan: 2200,
  resume: 900,
  report: 2000,
  summary: 1200,
  outline: 800,
  mindmap: 600,
  paper_summary: 800,
  // 文本摘要：产物是"若干条要点 + 一段结论"，天然比长文短，下限按此设定
  summarize: 200,
  // 解题讲解：需要"思路 + 分步 + 提醒"三段，太短说明步骤被省略了
  solve_question: 300,
  default: 800,
};

/** 内容完整性：每类文档的必备结构要素（命中标题即算覆盖） */
export const REQUIRED_SECTIONS: Record<string, string[]> = {
  business_plan: [
    '项目概述',
    '用户痛点',
    '产品',
    '市场规模',
    '竞品',
    '商业模式',
    '团队',
    '里程碑',
    '风险',
  ],
  event_plan: ['背景', '目标人群', '时间与地点', '流程', '宣传', '物料', '预算', '分工', '风险'],
  resume: ['个人信息', '求职意向', '教育背景', '专业技能', '经历', '奖项', '自我评价'],
  report: ['摘要', '背景', '现状', '问题', '结论', '建议', '后续'],
  summary: ['回顾', '成果', '不足', '反思', '下一步'],
  outline: ['背景', '目标', '方案', '落地', '风险'],
  mindmap: ['核心', '分支', '应用'],
  // 文本摘要：提示词明确要求"要点 + 整体结论"，缺任一项即结构不完整
  summarize: ['要点', '结论'],
  // 解题：提示词的三条硬要求 —— 思路、步骤、易错点提醒
  solve_question: ['思路', '步骤', '提醒'],
  default: ['背景', '主体', '结论'],
};

/** 细节层级：每个一级章节至少应有的实质信息条数（段落 / 列表项 / 表格行） */
export const MIN_ITEMS_PER_SECTION = 3;
/** 细节层级：全文至少覆盖的层级数（一级标题 + 列表/表格/二级标题） */
export const MIN_DEPTH_LEVELS = 2;
/** 表达丰富度：句长标准差的健康下限（低于此值说明全篇一个句式） */
export const MIN_SENTENCE_LENGTH_STDDEV = 6;
/**
 * 表达丰富度：全文**二元词组**去重率下限。
 *
 * 为什么不用单字去重率：中文单字重复本来就高，正常长文也会被压到 0.03 左右从而误判；
 * 二元词组去重率同时反映用词广度与句式变化，实测真实长文约 0.35-0.6，
 * 而复读注水文本只有 0.12 左右，区分度足够。
 */
export const MIN_PHRASE_DIVERSITY_RATIO = 0.25;

/** PPT 内容：每个内容页至少应有的要点数 */
export const MIN_POINTS_PER_CONTENT_PAGE = 3;
/** PPT 内容：单条要点建议的字数下限（低于此值通常是名词短语堆砌） */
export const MIN_POINT_LENGTH = 15;
/** PPT 内容：带讲稿备注的内容页占比下限 */
export const MIN_NOTES_COVERAGE = 0.6;
/** PPT 内容：空内容页（无要点也无数据）占比上限 */
export const MAX_EMPTY_PAGE_RATIO = 0.1;

/** PPT 视觉：页数达到该值时才要求版式多样性（短 deck 允许单一） */
export const DECK_DIVERSITY_MIN_PAGES = 8;
/** 一整套 PPT 至少覆盖的版式种类数 */
export const MIN_LAYOUT_KINDS = 4;
/** 相邻页面允许的最大同版式连排数（超过即"同构页"） */
export const MAX_ADJACENT_SAME_LAYOUT = 2;
/** 内容页正文区占画布面积上限（超过判"没有留白"） */
export const MAX_CONTENT_AREA_RATIO = 0.78;
/** 正文区推荐面积区间（版式规范引用） */
export const BODY_AREA_RATIO_RANGE = { min: 0.5, max: 0.78 } as const;

/** 图表：一套含图表的产物至少覆盖的图表种类数 */
export const MIN_CHART_KINDS = 2;
/** 图表：单张图允许的最大配色数（超过判"彩虹图"） */
export const MAX_CHART_COLORS = 5;
/** 图表：轴标签与图例字号下限（pt），低于判不可读 */
export const MIN_CHART_FONT_SIZE = 9;
/** 图表：系列数上限（超过应换成分面或表格） */
export const MAX_CHART_SERIES = 4;
/** 图表：类目数上限（超过应换成分组、Top-N 或表格） */
export const MAX_CHART_CATEGORIES = 12;

/** 分维度权重（合计 100），用于综合质量分 */
export const QUALITY_WEIGHTS = {
  completeness: 45,
  diversity: 30,
  consistency: 25,
} as const;

/** 验收阈值：达不到就是"未交付"，不是"差不多" */
export const ACCEPTANCE = {
  /** 综合质量分达标线（百分制） */
  minOverallScore: 85,
  /** 内容完整性评分达标线 */
  minCompleteness: 85,
  /** 多样性达标率（各维度得分归一化后取平均） */
  minDiversityRate: 0.8,
  /** 视觉一致性必须满分（硬指标，任何违例即不合格） */
  requireConsistency: 1,
  /** 版式多样性达标率 */
  minLayoutDiversityRate: 0.8,
  /** 图表类型多样性达标率 */
  minChartDiversityRate: 0.8,
} as const;

/** 评分等级：给用户看的档位，避免只丢一个裸数字 */
export type QualityGrade = 'excellent' | 'good' | 'pass' | 'fail';

export function gradeOf(score: number): QualityGrade {
  if (score >= 90) return 'excellent';
  if (score >= 85) return 'good';
  if (score >= 70) return 'pass';
  return 'fail';
}

/** 按文档类型取字数下限，未知类型回落 default */
export function minCharsFor(docType?: string): number {
  return CONTENT_MIN_CHARS[docType ?? ''] ?? CONTENT_MIN_CHARS.default;
}

/** 按文档类型取必备要素，未知类型回落 default */
export function requiredSectionsFor(docType?: string): string[] {
  return REQUIRED_SECTIONS[docType ?? ''] ?? REQUIRED_SECTIONS.default;
}

/** 把"达到下限"折算成 0-1 的达标率；下限为 0 时视为达标 */
export function ratioTo(actual: number, target: number): number {
  if (target <= 0) return 1;
  return Math.max(0, Math.min(1, actual / target));
}
