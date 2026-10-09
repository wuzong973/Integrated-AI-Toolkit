/**
 * 考试倒计时（纯函数，不依赖 wx API）
 *
 * 日历日原语（`daysBetween` / `parseDate` / `mondayOf` …）在 `utils/date-parts.ts`，
 * 这里只放倒计时自己的逻辑。
 *
 * ## 一条刻意的取舍：**不预测考试日期**
 *
 * 第一版想内置"四六级 = 6 月第三个周六""考研 = 12 月最后一个周六"这类规则，
 * 看起来更省事，实际是**编造信息**：
 *   · 2023-06-17 是 6 月第三个周六，2024-06-15 也是，但 **2025-06-14 只是第二个**；
 *   · 考研日期近年也在变。
 * 一个"算出来但可能是错的"日期，比让用户自己选一次更糟 ——
 * 学生会照着它安排复习计划。**所以这里只给"常用名称"快捷填充，日期一律由用户选定，
 * 并在界面上写明"以官方通知为准"。**（红线 8：不假装知道）
 *
 * ## 存储反序列化必须当成不可信输入
 *
 * `wx.getStorageSync` 拿到的是历史版本写下的东西，结构可能已经变了。
 * `parseExams` 对每一条做形状校验，**坏的直接丢掉**而不是让页面崩掉 ——
 * 一次崩溃会让用户再也进不去这一页（因为坏数据还在存储里）。
 */
import { daysBetween, isValidDate, type DateParts } from './date-parts';

export interface Exam {
  id: string;
  name: string;
  date: DateParts;
}

/** 常用名称（**只是名字**，不含日期 —— 见文件头说明） */
export const EXAM_NAME_PRESETS: readonly string[] = [
  '四六级',
  '考研初试',
  '教资笔试',
  '计算机二级',
  '期末考试',
  '期中考试',
  '普通话测试',
  '驾照科目一',
];

/** 非空字符串（去空白后仍有内容） */
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * 倒计时文案。
 *
 * ⚠️ 0 与 1 单独说人话：`还有 0 天` / `还有 1 天` 读起来像机器，
 * 而"今天"和"明天"是学生真正关心的两种状态。
 */
export function countdownText(days: number): string {
  if (days > 1) return `还有 ${days} 天`;
  if (days === 1) return '就是明天';
  if (days === 0) return '就是今天';
  if (days === -1) return '昨天已考';
  return `已过去 ${-days} 天`;
}

/** 周数（向上取整，不足一周也算一周）—— 学生按周做复习计划 */
export function weeksText(days: number): string {
  if (days <= 0) return '';
  return `约 ${Math.ceil(days / 7)} 周`;
}

/**
 * 排序：**未过期的在前**（越近越前），已过期的在后（越近的越前）。
 *
 * 不把已过期的直接隐藏：学生常要回看"上一场是什么时候"，
 * 悄悄消失比留在那里更让人困惑。
 */
export function sortExams(exams: readonly Exam[], today: DateParts): Exam[] {
  const withDays = exams.map((e) => ({ e, days: daysBetween(today, e.date) }));
  withDays.sort((a, b) => {
    const aPast = a.days < 0;
    const bPast = b.days < 0;
    if (aPast !== bPast) return aPast ? 1 : -1;
    // 未过期：越近越前；已过期：越近（越大）越前
    if (aPast) return b.days - a.days;
    return a.days - b.days || a.e.name.localeCompare(b.e.name);
  });
  return withDays.map((x) => x.e);
}

/** 单条记录的形状校验：不合规返回 null（调用方直接丢） */
function toExam(item: unknown): Exam | null {
  if (!item || typeof item !== 'object') return null;
  const { id, name, date } = item as Exam;
  if (!isText(id) || !isText(name) || !isValidDate(date)) return null;
  return { id, name: name.trim(), date };
}

/**
 * 反序列化存储里的考试列表。
 *
 * **坏条目直接丢弃**，不抛错、不猜、不补默认值 —— 让页面永远能打开。
 * 重复 `id` 也只保留第一条：重复 key 会让列表渲染错乱，比丢一条更难查。
 */
export function parseExams(raw: unknown): Exam[] {
  if (!Array.isArray(raw)) return [];
  const out: Exam[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const exam = toExam(item);
    if (!exam || seen.has(exam.id)) continue;
    seen.add(exam.id);
    out.push(exam);
  }
  return out;
}
