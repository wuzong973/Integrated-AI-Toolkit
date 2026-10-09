/**
 * 按行文本 diff（纯函数，不依赖 wx API）
 *
 * ## 算法
 *
 * 经典 LCS（最长公共子序列）动态规划：公共行 = 两边都有（`same`），
 * 只在旧文本 = 删除（`del`），只在新文本 = 新增（`add`）。
 * 行级 LCS 对"改了一个词的段落"会标成"删一行 + 加一行"——
 * 这是行 diff 的本职口径，界面文案直接说"按行对比"，不假装做了词级。
 *
 * ## 规模上限
 *
 * DP 表是 O(n×m)：两端各 1500 行是 225 万格（Uint32 约 9 MB），还能秒出；
 * 再长就会卡住输入法。超限部分**截断**并在结果里明说（`truncated`），
 * 不悄悄丢行让用户以为"没差异"。
 */

export type DiffKind = 'same' | 'add' | 'del';

export interface DiffRow {
  cls: DiffKind;
  text: string;
}

export interface DiffResult {
  rows: DiffRow[];
  adds: number;
  dels: number;
  truncated: boolean;
}

/** 单侧最大参与对比的行数 */
const MAX_LINES = 1500;

/** 按行 diff；空文本按"一行空行"参与，行为与编辑器一致 */
export function diffLines(aText: string, bText: string): DiffResult {
  const aLines = aText.split('\n');
  const bLines = bText.split('\n');
  const truncated = aLines.length > MAX_LINES || bLines.length > MAX_LINES;
  const a = aLines.slice(0, MAX_LINES);
  const b = bLines.slice(0, MAX_LINES);
  const rows = backtrack(lcsTable(a, b), a, b);
  return {
    rows,
    adds: rows.filter((r) => r.cls === 'add').length,
    dels: rows.filter((r) => r.cls === 'del').length,
    truncated,
  };
}

/**
 * LCS 计分表（扁平一维数组，下标 `i * (m + 1) + j`）。
 * `table[i][j]` = a 前 i 行与 b 前 j 行的公共子序列长度。
 */
function lcsTable(a: string[], b: string[]): Uint32Array {
  const n = a.length;
  const m = b.length;
  const table = new Uint32Array((n + 1) * (m + 1));
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const cell = i * (m + 1) + j;
      if (a[i - 1] === b[j - 1]) {
        table[cell] = table[cell - (m + 1) - 1] + 1;
      } else {
        table[cell] = Math.max(table[cell - 1], table[cell - (m + 1)]);
      }
    }
  }
  return table;
}

/** 从计分表右下角回溯出整条行序列（逆序回溯、倒着收集，最后反转） */
function backtrack(table: Uint32Array, a: string[], b: string[]): DiffRow[] {
  const m = b.length;
  const rows: DiffRow[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      rows.push({ cls: 'same', text: a[i - 1] });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || table[i * (m + 1) + j] === table[i * (m + 1) + j - 1])) {
      rows.push({ cls: 'add', text: b[j - 1] });
      j -= 1;
    } else {
      rows.push({ cls: 'del', text: a[i - 1] });
      i -= 1;
    }
  }
  return rows.reverse();
}
