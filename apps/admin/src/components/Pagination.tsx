/** 页码窗口：首页 / 末页 / 当前±1 常显，其余折叠成省略号 */
export function pageWindow(page: number, pageCount: number): (number | '…')[] {
  if (pageCount <= 7) return range(1, pageCount);
  const items: (number | '…')[] = [1];
  const from = Math.max(2, page - 1);
  const to = Math.min(pageCount - 1, page + 1);
  if (from > 2) items.push('…');
  items.push(...range(from, to));
  if (to < pageCount - 1) items.push('…');
  items.push(pageCount);
  return items;
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i += 1) out.push(i);
  return out;
}

interface Props {
  page: number;
  size: number;
  total: number;
  onChange: (page: number) => void;
}

/**
 * 分页条。
 *
 * 页数信息与"共 N 条"放在一起：只显示页码时，运营无法判断
 * "只筛出 3 条"和"数据库里就 3 条"是不是同一件事。
 */
export function Pagination({ page, size, total, onChange }: Props) {
  const pageCount = Math.max(1, Math.ceil(total / size));
  if (total === 0) return null;

  return (
    <nav className="qz-pagination" aria-label="分页">
      <span>
        共 {total} 条 · 第 {page} / {pageCount} 页
      </span>
      <div className="qz-pagination__pages">
        <button
          className="qz-page-btn"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
          aria-label="上一页"
        >
          上一页
        </button>
        {pageWindow(page, pageCount).map((item, idx) =>
          item === '…' ? (
            <span className="qz-page-ellipsis" key={`gap-${idx}`}>
              …
            </span>
          ) : (
            <button
              key={item}
              className={`qz-page-btn${item === page ? ' is-active' : ''}`}
              onClick={() => onChange(item)}
              aria-current={item === page ? 'page' : undefined}
            >
              {item}
            </button>
          ),
        )}
        <button
          className="qz-page-btn"
          disabled={page >= pageCount}
          onClick={() => onChange(page + 1)}
          aria-label="下一页"
        >
          下一页
        </button>
      </div>
    </nav>
  );
}
