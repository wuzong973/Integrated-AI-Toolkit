/**
 * 结果页的纯展示映射：状态图标、产物图标、"下一步"出口。
 *
 * 单独成文件有两个原因：
 *   ① 页面文件（`index.ts`）现在还要装"实时进度跟踪"，映射表留在里面会顶破 300 行；
 *   ② 这些映射**无状态、不改数据语义**，挪出来后页面只剩真正的业务分支。
 *
 * ⚠️ 状态键与后端 `JobListQuerySchema` 的取值一致（queued / running / succeeded /
 * failed / canceled / rejected）。以前只写了 `pending`（后端并不产出这个值），
 * 靠"未知状态回落到排队中"侥幸显示正确 —— 界面上不能留这种侥幸。
 */
import type { JobItem, JobResultMetrics } from '../../utils/api';
import { fileApi } from '../../utils/api';

/** "下一步"建议（按工具类型给出不同出口，避免千篇一律） */
export interface NextStep {
  label: string;
  /** os = 继续用 AI；station = 转真人；tool = 换工具 */
  kind: 'os' | 'station' | 'tool';
  target?: string;
  query?: string;
}

/** 产物条目（纯展示：把 outputFiles 的 id 映射成"文件名 + 糖果图标"） */
export interface OutFile {
  key: string;
  name: string;
  iconClass: string;
}

/** 状态 → 糖果图标 + 文案（纯展示映射） */
export const STATUS_MAP: Record<string, { icon: string; title: string; sub: string }> = {
  succeeded: { icon: 'qz-i-check', title: '生成成功', sub: '可以下载、保存，或继续加工' },
  // ⚠️ failed 的 sub 渲染时由 failureHint() 覆盖（免费期不能说"积分已退回"）。
  //    这里留一句中性兜底：万一哪条路径漏了覆盖，也不会对用户说错话。
  failed: { icon: 'qz-i-close', title: '生成失败', sub: '可以重新生成' },
  canceled: { icon: 'qz-i-close', title: '已取消', sub: '任务未继续执行，没有产物' },
  rejected: { icon: 'qz-i-bell', title: '未通过校验', sub: '任务被拒绝，未开始执行' },
  running: { icon: 'qz-i-sparkle', title: '处理中', sub: '稍等一下，马上就好' },
  queued: { icon: 'qz-i-clock', title: '排队中', sub: '前面还有任务在跑' },
};
export const STATUS_FALLBACK = STATUS_MAP.queued;

/** 下一步出口 → 图标（os 用 AI、station 用驿站、tool 用工具箱） */
const KIND_ICONS: Record<NextStep['kind'], string> = {
  os: 'qz-i-ai',
  station: 'qz-i-station',
  tool: 'qz-i-toolbox',
};

/** 扩展名 → 糖果图标（挑最接近的，见 styles/icons.scss） */
const EXT_ICONS: [string, string][] = [
  ['.pdf', 'qz-i-pdf'],
  ['.ppt', 'qz-i-office'],
  ['.doc', 'qz-i-doc'],
  ['.md', 'qz-i-copy'],
  ['.png', 'qz-i-image'],
  ['.jpg', 'qz-i-image'],
  ['.jpeg', 'qz-i-image'],
  ['.webp', 'qz-i-image'],
  ['.mp4', 'qz-i-video'],
  ['.mov', 'qz-i-video'],
  ['.mp3', 'qz-i-audio'],
  ['.wav', 'qz-i-audio'],
  ['.zip', 'qz-i-file'],
];

/** 工具 → 下一步建议映射 */
const NEXT_STEPS: Record<string, NextStep[]> = {
  generate_ppt: [
    { label: '生成配套路演稿', kind: 'os', query: '帮我把这份 PPT 生成配套路演演讲稿' },
    { label: '生成答辩 Q&A', kind: 'os', query: '帮我生成这份 PPT 的答辩问答' },
    { label: '找人帮做路演视频', kind: 'station' },
    { label: '找人润色排版', kind: 'station' },
  ],
  generate_document: [
    { label: '转成 PPT', kind: 'tool', target: 'generate_ppt' },
    { label: '找人帮我审核', kind: 'station' },
  ],
  compress_image: [
    { label: '继续抠图', kind: 'tool', target: 'remove_background' },
    { label: '提取图片文字', kind: 'tool', target: 'ocr_image' },
  ],
  ocr_image: [
    { label: '把文字生成文档', kind: 'os', query: '把这段文字整理成一份文档' },
    { label: '翻译这段文字', kind: 'os', query: '把这段文字翻译成英文' },
  ],
  remove_background: [
    { label: '再做图片压缩', kind: 'tool', target: 'compress_image' },
    { label: '转换图片格式', kind: 'tool', target: 'convert_image' },
  ],
  compress_video: [
    { label: '提取视频字幕', kind: 'tool', target: 'speech_to_text' },
    { label: '找人帮剪视频', kind: 'station' },
  ],
  separate_vocals: [
    { label: '转录音频文字', kind: 'tool', target: 'speech_to_text' },
    { label: '音频格式转换', kind: 'tool', target: 'convert_audio' },
  ],
  analyze_data: [
    { label: '做成汇报 PPT', kind: 'tool', target: 'generate_ppt' },
    { label: '找人帮做数据可视化', kind: 'station' },
  ],
  speech_to_text: [
    { label: '生成会议纪要', kind: 'os', query: '把这段转写整理成会议纪要' },
    { label: '生成字幕文件', kind: 'tool', target: 'add_subtitle' },
  ],
};

/**
 * 产物文件名 → 糖果图标类名
 *
 * ⚠️ 收的必须是**真实文件名**而不是 id：后端 `job.outputFiles` 存的是文件 id，
 * 直接按扩展名匹配会永远落空、产物名显示成一串 uuid（见 `resolveOutFiles`）。
 */
export function iconOf(name: string): string {
  const lower = name.toLowerCase();
  const hit = EXT_ICONS.find(([ext]) => lower.includes(ext));
  return hit ? hit[1] : 'qz-i-file';
}

/**
 * 产物 id → 展示条目。
 *
 * 必须查一次文件详情才能拿到真实文件名与扩展名；
 * 查不到时（如文件已被删除）退回 id，至少还能看出是哪个产物。
 */
export async function resolveOutFiles(ids: string[]): Promise<OutFile[]> {
  return Promise.all(
    ids.map(async (id) => {
      try {
        const f = await fileApi.detail(id);
        return { key: id, name: f.name, iconClass: iconOf(f.name) };
      } catch {
        return { key: id, name: id, iconClass: 'qz-i-file' };
      }
    }),
  );
}

/** 按工具取"下一步"出口（没配到的工具给两条通用出口） */
export function nextStepsFor(job: JobItem): (NextStep & { iconClass: string })[] {
  return (
    NEXT_STEPS[job.toolName] ?? [
      { label: '再用一次', kind: 'tool', target: job.toolName },
      { label: '找人帮我做', kind: 'station' },
    ]
  ).map((s) => ({ ...s, iconClass: KIND_ICONS[s.kind] }));
}

/** 多产物时让用户挑一个（小程序没法批量落盘） */
export function pickOne(names: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    wx.showActionSheet({
      itemList: names.slice(0, 6),
      success: (res) => resolve(res.tapIndex),
      fail: () => resolve(null),
    });
  });
}

/* ---------- 产出指标（MQ-01：让用户直接看到"这次产出好不好"） ---------- */

/** 一条指标（label + 值），仅用于展示 */
export interface MetricRow {
  label: string;
  value: string;
  /** 异常项（如未达目标体积）需要视觉上区分，不与正常项同色 */
  warn?: boolean;
}

/** 体积可读化：与后端 job-result.ts 同口径，避免两处算出不同数字 */
function bytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function sizeRow(m: { inputBytes?: number; outputBytes?: number }): MetricRow | null {
  const { inputBytes: a, outputBytes: b } = m;
  if (a === undefined || b === undefined || a <= 0) return null;
  const saved = Math.round(((a - b) / a) * 100);
  const delta = saved >= 0 ? `省 ${saved}%` : `增 ${Math.abs(saved)}%`;
  return { label: '体积', value: `${bytes(a)} → ${bytes(b)}（${delta}）` };
}

/**
 * 产出指标 → 展示行。
 *
 * ## 为什么"未达标"要单独标 warn
 *
 * 压缩类工具没压到目标体积时，产物**仍然可用**，所以不该判失败；
 * 但把它和"已达标"显示成同一副样子，用户就会以为目标已经达成。
 * 结论：照常交付，但用 warn 样式把"没做到"说出来。
 */
export function metricRows(job: JobItem): MetricRow[] {
  const m = job.result;
  if (!m) return [];
  const rows = [
    ...sizeMetrics(m),
    ...imageMetrics(m),
    ...contentMetrics(m),
  ];
  // 未达成目标体积：照常交付，但明确标出（放最后一行，最显眼）
  if (m.targetMet === false) {
    rows.push({ label: '目标体积', value: '未达成（已尽量压缩）', warn: true });
  }
  return rows;
}

/** 体积与时长（图片/视频/音频/PDF 共用） */
function sizeMetrics(m: JobResultMetrics): MetricRow[] {
  const rows: MetricRow[] = [];
  const size = sizeRow(m);
  if (size) rows.push(size);
  if (m.durationSec !== undefined) rows.push({ label: '时长', value: `${m.durationSec.toFixed(1)} 秒` });
  if (m.encoder) rows.push({ label: '编码器', value: m.encoder });
  return rows;
}

/** 图片专有：尺寸与格式 */
function imageMetrics(m: JobResultMetrics): MetricRow[] {
  const rows: MetricRow[] = [];
  if (m.width && m.height) rows.push({ label: '尺寸', value: `${m.width} × ${m.height}` });
  if (m.format) rows.push({ label: '格式', value: m.format.toUpperCase() });
  return rows;
}

/** 内容专有：字数 / 页数 / 版式 / 图表 */
function contentMetrics(m: JobResultMetrics): MetricRow[] {
  const rows: MetricRow[] = [];
  if (m.chars !== undefined) rows.push({ label: '字数', value: `${m.chars} 字` });
  if (m.pages !== undefined) rows.push({ label: '页数', value: `${m.pages} 页` });
  if (m.layoutKinds !== undefined) rows.push({ label: '版式', value: `${m.layoutKinds} 种` });
  if (m.chartKinds) rows.push({ label: '图表', value: `${m.chartKinds} 种` });
  return rows;
}

/**
 * 质量档位（AI 产出的可读结论）。
 *
 * 阈值与 `packages/core/src/quality/standard.ts` 的 `gradeOf` 同源：
 * ≥90 优秀 / ≥85 良好 / ≥70 及格 / <70 待改进。
 * 前端只做展示，不重新定义判据 —— 两处各写一套必然有一处先过期。
 */
export function qualityLabel(score?: number): { text: string; warn: boolean } | null {
  if (score === undefined || score === null) return null;
  if (score >= 90) return { text: `优秀 ${score} 分`, warn: false };
  if (score >= 85) return { text: `良好 ${score} 分`, warn: false };
  if (score >= 70) return { text: `及格 ${score} 分`, warn: true };
  return { text: `待改进 ${score} 分`, warn: true };
}
