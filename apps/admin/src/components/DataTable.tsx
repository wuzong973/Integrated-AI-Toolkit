import type { ReactNode } from 'react';

export interface Column<T> {
  /** 列标识（不要求唯一，但必须稳定，用作 key） */
  key: string;
  title: ReactNode;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right';
  width?: number | string;
  /** 附加到单元格的类名（如 `qz-cell--id` 做截断） */
  cellClass?: string;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** 整行可点进详情。**只做视觉提示**，真正的跳转由首列的链接承担 ——
   *  这样键盘用户与"中键新开标签页"都能正常工作。 */
  onRowClick?: (row: T) => void;
}

/**
 * 通用表格。
 *
 * ## 列宽为什么允许 `width`
 *
 * 后台表格最常见的可读性问题不是"少一列"，而是**某一列把其余列挤扁**
 * （典型是 UUID 与时间戳）。显式给宽度 + `qz-cell--id` 截断，
 * 比让浏览器按内容平分更稳定。
 */
export function DataTable<T>({ columns, rows, rowKey, onRowClick }: Props<T>) {
  return (
    <div className="qz-table-wrap">
      <table className="qz-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                style={
                  col.width || col.align === 'right'
                    ? { width: col.width, textAlign: col.align === 'right' ? 'right' : undefined }
                    : undefined
                }
              >
                {col.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={onRowClick ? 'is-clickable' : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={[col.align === 'right' && 'qz-cell--num', col.cellClass]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
