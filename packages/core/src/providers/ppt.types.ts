/**
 * PPT 图表类型与选用规范（与 `types.ts` 拆开的理由：types.ts 已接近 300 行红线，
 * 且图表类型是"提示词 / 渲染器 / 守卫 / 文档"四方共用的独立知识，值得单独成文件）。
 */
/**
 * 原生图表类型（PptxGenJS 全量，保证产物可编辑、不是贴图）。
 *
 * 为什么从 3 种扩到 9 种：此前只有 bar/line/pie，导致"数据页长得都一样"，
 * 用户拿到的 deck 里每张图都是同一根柱子。这些类型 PptxGenJS 原生支持，
 * 扩充不引入任何新依赖（红线 9 与许可台账均不受影响）。
 *
 * 选用逻辑（"图表选用逻辑"的代码化版本，提示词与守卫共用）：
 * - bar       类目对比、排名（"谁多谁少"）
 * - bar3D     需要立体感的关键对比，正式答辩慎用
 * - line      时间趋势（"怎么变的"）
 * - area      趋势 + 累积量感（"总量怎么堆起来的"）
 * - pie       单一口径占比，且类目 ≤5
 * - doughnut  占比 + 中心放合计值
 * - radar     多维能力对比（"哪一项强哪一项弱"）
 * - scatter   两个变量的相关性
 * - bubble    三变量关系（x / y / 大小）
 */
export type PptChartType =
  | 'bar'
  | 'bar3D'
  | 'line'
  | 'area'
  | 'pie'
  | 'doughnut'
  | 'radar'
  | 'scatter'
  | 'bubble';

/**
 * 图表契约：类型 + 类目轴 + 系列。散点 / 气泡图同样用 categories 承载 x 轴标签。
 *
 * ## caption：诚实标注的唯一开关
 *
 * - **不传** → 渲染器一律标「示例数据（请替换为你的真实数据）」，
 *   因为模型生成的数字无从核实（红线 10）；
 * - **传了** → 说明数据有明确来源（如"上传表格真实统计"），渲染器原样显示该来源，
 *   不再叠"示例数据"字样。
 *
 * 这样"真实"与"示例"在产物上**一眼可辨**，而不是靠调用方记得标注。
 */
export interface PptChartSpec {
  type: PptChartType;
  categories: string[];
  series: { name: string; values: number[] }[];
  /** 数据来源说明。不传即视为示例数据 */
  caption?: string;
}

/** 图表类型选用依据（提示词、守卫与文档共用同一份，避免三处漂移） */
export const PPT_CHART_GUIDE: readonly {
  type: PptChartType;
  label: string;
  when: string;
}[] = [
  { type: 'bar', label: '柱状图', when: '类目数量对比或排名，如各院系人数、各渠道订单量' },
  { type: 'bar3D', label: '立体柱状图', when: '需要更强视觉冲击的少数关键对比，正式答辩慎用' },
  { type: 'line', label: '折线图', when: '随时间变化的趋势，如月度增长、周活变化' },
  { type: 'area', label: '面积图', when: '既看趋势又看累积量感，如累计注册用户' },
  { type: 'pie', label: '饼图', when: '单一整体下的占比，且类目不超过 5 个' },
  { type: 'doughnut', label: '环形图', when: '占比展示且中心需要放合计值或关键结论' },
  { type: 'radar', label: '雷达图', when: '多维能力或指标画像对比，如团队能力雷达' },
  { type: 'scatter', label: '散点图', when: '两个数值变量之间的相关性，如投入与产出' },
  { type: 'bubble', label: '气泡图', when: '三个变量的关系，第三个变量用点的大小表达' },
];
