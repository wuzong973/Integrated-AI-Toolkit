/**
 * 作业产出指标（MQ-01 度量闭环的「形状定义」）
 *
 * ## 为什么需要这一层
 *
 * `tool_job` 此前只存 `output_files`（文件 id），于是**产物的质量在数据库里不可见**：
 * 压缩率、分辨率、时长、页数、字数都没有落点，结果页只能显示「共 N 个产物」。
 *
 * 后果不是「信息少」，而是**劣质产物无法被发现**：图片压完比原图还大、
 * 视频落到低质量编码器、文档只有 800 字 —— 这些与优质产物在数据上完全同形。
 *
 * 所以这里定义一套**跨工具统一**的指标形状，让「产出质量」第一次成为可查询的事实。
 *
 * ## 两条纪律
 *
 * 1. **只记录事实，不做判断**：这里只存「实际是多少」，达标与否由 `assertResultSane`
 *    单独决定。判断与记录分开，才能事后复盘。
 * 2. **宁缺勿造**：拿不到的指标就不填，不要用 0 或估算值凑一个形状完整的对象 ——
 *    那会让「没有数据」和「数据是 0」混在一起，比缺字段更危险（红线 10）。
 */

/** 体积类指标（图片 / 视频 / 音频 / PDF 通用） */
export interface SizeMetrics {
  /** 原始体积（字节） */
  inputBytes?: number;
  /** 产出体积（字节） */
  outputBytes?: number;
  /** 是否达成用户指定的目标体积 */
  targetMet?: boolean;
}

/** 图片类指标 */
export interface ImageMetrics extends SizeMetrics {
  kind: 'image';
  width?: number;
  height?: number;
  /** 真实输出格式 —— 与扩展名不一致是历史 bug，记下来才查得出 */
  format?: string;
}

/** 音视频类指标 */
export interface MediaMetrics extends SizeMetrics {
  kind: 'media';
  durationSec?: number;
  /** 实际使用的编码器：兜底到低质量编码器时必须可见 */
  encoder?: string;
  width?: number;
  height?: number;
}

/** 文档 / PPT / 文本类指标 */
export interface ContentMetrics {
  kind: 'content';
  /** 正文字符数（不含 Markdown 语法） */
  chars?: number;
  /** 文档页数 / 幻灯片页数 */
  pages?: number;
  /** PPT 版式种类数 */
  layoutKinds?: number;
  /** 图表种类数 */
  chartKinds?: number;
}

/** PDF 类指标 */
export interface PdfMetrics extends SizeMetrics {
  kind: 'pdf';
  pages?: number;
}

/** 任意工具的产出指标（判别联合） */
export type JobResultMetrics =
  | ImageMetrics
  | MediaMetrics
  | ContentMetrics
  | PdfMetrics
  | { kind: 'other' };

/** 空指标：JSON 列的默认值，避免 null 与 {} 两种空态并存 */
export const EMPTY_RESULT: JobResultMetrics = { kind: 'other' };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 人类可读的体积差，供结果页直接显示（如 `12.4MB → 3.1MB（省 75%）`）。
 *
 * 放在这里而不是各页面各写一份：结果页、日志、后续的指标看板都要用，
 * 三处各写一遍必然出现「同一份数据两个说法」。
 */
export function describeSize(m: SizeMetrics): string | undefined {
  const { inputBytes: a, outputBytes: b } = m;
  if (a === undefined || b === undefined || a <= 0) return undefined;
  const saved = ((a - b) / a) * 100;
  const sign = saved >= 0 ? '省' : '增';
  return `${formatBytes(a)} → ${formatBytes(b)}（${sign} ${Math.abs(saved).toFixed(0)}%）`;
}

/**
 * 后置校验：产出明显不合理时给出失败原因，而不是静默交付。
 *
 * ## 为什么「产出比原文件更大」只在这里判、且阈值宽松
 *
 * 格式转换本身可能合法地变大（jpeg → png 必然变大），所以这里**不**判增大，
 * 只判真正不可能的情况（空产物、时长为 0）。
 * 「压缩类工具是否压小了」由调用方用 `describeSize` + 目标体积自行表达，
 * 因为只有调用方知道这次是压缩还是转换 —— 校验层不该猜。
 */
export function assertResultSane(metrics: JobResultMetrics): string | undefined {
  if (metrics.kind === 'image' || metrics.kind === 'media' || metrics.kind === 'pdf') {
    if (metrics.outputBytes === 0) return '产出文件为空';
    if (metrics.kind === 'media' && metrics.durationSec !== undefined && metrics.durationSec <= 0) {
      return '产出视频/音频时长为 0';
    }
  }
  return undefined;
}
/**
 * 把库里的 JSON 安全转成产出指标（视图层用）。
 *
 * 不直接断言类型：JSON 列的内容来自历史数据与不同版本的代码，
 * 脏数据不该让一次查询 500（视图层只负责展示，判据在 `assertResultSane`）。
 * 认不出形状时返回 undefined，让前端退回「共 N 个产物」。
 */
export function asMetrics(v: unknown): JobResultMetrics | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const kind = (v as { kind?: unknown }).kind;
  if (kind !== 'image' && kind !== 'media' && kind !== 'content' && kind !== 'pdf') {
    return undefined;
  }
  return v as JobResultMetrics;
}

/**
 * 作业视图（对外 JSON）。与 `apps/mp/utils/api-types.ts` 的 JobItem 对齐。
 *
 * 放在这里而不是 job.service：它描述的是「作业产出长什么样」，
 * 与产出指标是同一件事的两个层次（形状定义 / 对外视图），放一起才不会各改一半。
 */
export interface JobItem {
  id: string;
  toolName: string;
  status: string;
  progress: number;
  stage?: string;
  cost: number;
  outputFiles: string[];
  error?: string;
  createdAt: string;
  /** 产出指标（压缩率/分辨率/时长/页数…） */
  result?: JobResultMetrics;
  /** AI 产出的质量分（0-100），非 AI 工具为空 */
  qualityScore?: number;
  /** 质量扣分项（人类可读） */
  qualityIssues?: string[];
}

/**
 * 数据库行 → 视图的中间形状（`toJobItem` 的入参）。
 *
 * 与 `JobItem` 的差别只在"可选性"：库里是 `string | null` / `unknown`（JSON 列），
 * 视图是 `string | undefined` / 结构化类型。放在这里，让"作业产出长什么样"
 * 的两个层次（库行 / 视图）相邻可见，改一处就能看到另一处。
 */
export interface JobRow {
  id: string;
  toolName: string;
  status: string;
  progress: number;
  stage: string | null;
  cost: number;
  outputFiles: unknown;
  error: string | null;
  createdAt: Date;
  result?: unknown;
  qualityScore?: number | null;
  qualityIssues?: unknown;
}
