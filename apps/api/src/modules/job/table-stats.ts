/**
 * 表格解析与统计 —— `analyze_data` 的**确定性内核**
 *
 * ## 为什么这些数字必须由代码算，而不是交给模型
 *
 * 这是本工具唯一重要的设计决定。让 LLM "看一眼表格给个结论"极其容易，
 * 但它会顺口说出"平均分 82.5、满意度 76%"这类**看起来专业、实际算错**的数字，
 * 而用户会直接把报告交上去。
 *
 * 所以分工是死的：
 *   · **代码**负责一切数字（行列数、均值、中位数、极值、缺失率、高频值）；
 *   · **模型**只负责解读（数据说明了什么、异常在哪、关注点的结论）。
 * 报告里也据此分成「程序统计」与「AI 分析」两节，谁说的话一目了然。
 *
 * ## 为什么自己写 CSV 解析而不是引依赖
 *
 * 需要的只是一个子集（引号转义 + 字段内分隔符/换行），几十行就能写对；
 * 而多一个依赖就要走许可登记（`docs/compliance/OPEN_SOURCE_LICENSES.md`）。
 * 这些函数是纯函数，`table-stats.spec.ts` 直接覆盖边界情况。
 */

/** 解析出的表格 */
export interface ParsedTable {
  header: string[];
  rows: string[][];
  delimiter: string;
}

/** 数值列摘要 */
export interface NumericStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  sum: number;
}

/** 单列画像 */
export interface ColumnProfile {
  name: string;
  type: 'number' | 'text' | 'empty';
  /** 非空单元格数 */
  nonEmpty: number;
  /** 空单元格数 */
  missing: number;
  /** 去重后的取值个数 */
  unique: number;
  /** 数值列才有 */
  stats?: NumericStats;
  /** 文本列的高频取值（最多 5 个） */
  top?: { value: string; count: number }[];
  /**
   * 疑似标识列（学号 / 订单号这类）。
   *
   * 判据是"几乎每个值都不同" —— 这类列的均值、最大值**在数学上成立但在业务上无意义**，
   * 直接展示会诱导用户得出错误结论。标出来比不标诚实。
   */
  likelyId?: boolean;
}

/** 整表画像 */
export interface TableProfile {
  rowCount: number;
  columnCount: number;
  columns: ColumnProfile[];
}

/** 候选分隔符：逗号 / 制表符 / 分号 / 竖线（覆盖 Excel 复制、CSV、TSV） */
const DELIMITERS = [',', '\t', ';', '|'];

/** 数值列里"看似不同值"的占比超过它，就按标识列提醒 */
const ID_UNIQUE_RATIO = 0.9;

/**
 * 解码表格文本。
 *
 * 中文 CSV 有个必踩的坑：Excel「另存为 CSV」默认输出 **GBK**，
 * 而 `Buffer.toString('utf8')` 遇到 GBK 字节**不会抛错**，只会把中文变成一串 `�` ——
 * 用户看到"分析结果全是乱码"，却没有任何异常可查。
 * 所以先按 UTF-8 解，发现替换字符再回退 GBK。
 */
export function decodeTabular(buffer: Buffer): string {
  const utf8 = stripBom(buffer.toString('utf8'));
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return stripBom(new TextDecoder('gbk').decode(buffer));
  } catch {
    // 运行环境不带 gbk 解码器时，退回"能读多少读多少"，而不是让整个工具失败
    return utf8;
  }
}

/** 去掉 UTF-8 BOM —— 它会让第一列列名变成 `\uFEFF姓名`，按列名匹配时永远找不到 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 猜分隔符。
 *
 * 判据不是"哪个出现得多"，而是"哪个切出来的**列数最一致**" ——
 * 用逗号切 TSV 会得到 1 列（每行都一致但没意义），
 * 而用制表符切 TSV 会得到稳定的 N 列。所以先要求至少 2 列，再比一致性。
 */
export function detectDelimiter(text: string): string {
  const sample = text
    .split(/\r?\n/)
    .slice(0, 20)
    .filter((line) => line.trim() !== '');
  if (sample.length === 0) return ',';

  let best = ',';
  let bestScore = 0;
  for (const d of DELIMITERS) {
    const counts = sample.map((line) => splitFields(line, d).length);
    const columns = counts[0];
    if (columns < 2) continue;
    const consistent = counts.filter((c) => c === columns).length / counts.length;
    // 一致性优先，其次才是列数（列数多但忽多忽少说明切错了）
    const score = consistent * 1000 + columns;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/**
 * 按分隔符切字段。
 *
 * 引号规则按 RFC 4180：字段可被 `"` 包裹，其中的 `""` 表示一个字面量引号，
 * 且引号内的分隔符**不算分隔符**（`"张三, 李四"` 是一列而不是两列）。
 */
export function splitFields(record: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < record.length; i += 1) {
    const ch = record[i];
    if (ch === '"') {
      if (quoted && record[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && ch === delimiter) {
      out.push(field);
      field = '';
      continue;
    }
    field += ch;
  }
  out.push(field);
  return out;
}

/** 按"未被引号包裹的换行"切记录（引号内的换行属于同一个字段） */
function splitRecords(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      quoted = !quoted;
      buf += ch;
      continue;
    }
    if (!quoted && (ch === '\n' || ch === '\r')) {
      // \r\n 只算一次换行
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

/** 文本 → 表格。首行作表头，全空行丢弃 */
export function parseTable(text: string, delimiter?: string): ParsedTable {
  const d = delimiter ?? detectDelimiter(text);
  const records = splitRecords(text)
    .map((r) => splitFields(r, d))
    .filter((r) => r.some((c) => c.trim() !== ''));

  const [header = [], ...rows] = records;
  return { header: normalizeHeader(header), rows, delimiter: d };
}

/** 表头规整：去空白、空名补 `列N`、重名加序号（重名会让"按列名取值"取到错误的列） */
function normalizeHeader(header: string[]): string[] {
  const seen = new Map<string, number>();
  return header.map((raw, i) => {
    const base = raw.trim() || `列${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}(${n})`;
  });
}

/** 取数值；`null` 表示"不是数字"（空串、文本都算） */
function toNumber(value: string): number | null {
  const s = value.trim().replace(/[,，\s]/g, '').replace(/[%％]$/, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 统计一列 */
export function profileColumn(name: string, values: string[]): ColumnProfile {
  const cells = values.map((v) => v.trim());
  const filled = cells.filter((c) => c !== '');
  const missing = cells.length - filled.length;
  const unique = new Set(filled).size;

  if (filled.length === 0) {
    return { name, type: 'empty', nonEmpty: 0, missing, unique: 0 };
  }

  const numbers = filled.map(toNumber);
  if (numbers.every((n) => n !== null)) {
    const nums = (numbers as number[]).slice().sort((a, b) => a - b);
    return {
      name,
      type: 'number',
      nonEmpty: filled.length,
      missing,
      unique,
      stats: {
        min: nums[0],
        max: nums[nums.length - 1],
        mean: nums.reduce((a, b) => a + b, 0) / nums.length,
        median: median(nums),
        sum: nums.reduce((a, b) => a + b, 0),
      },
      likelyId: isLikelyId(filled.length, unique),
    };
  }

  return {
    name,
    type: 'text',
    nonEmpty: filled.length,
    missing,
    unique,
    top: topValues(filled),
    likelyId: isLikelyId(filled.length, unique),
  };
}

/** 中位数（入参已排序） */
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 样本够多、且几乎每个值都不同 → 按标识列提醒 */
function isLikelyId(count: number, unique: number): boolean {
  return count >= 10 && unique / count >= ID_UNIQUE_RATIO;
}

/** 高频取值（最多 5 个，按出现次数降序） */
function topValues(values: string[]): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

/** 整表画像 */
export function profileTable(table: ParsedTable): TableProfile {
  const columns = table.header.map((name, i) =>
    profileColumn(
      name,
      table.rows.map((row) => row[i] ?? ''),
    ),
  );
  return { rowCount: table.rows.length, columnCount: table.header.length, columns };
}
