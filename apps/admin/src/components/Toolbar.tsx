import { useEffect, useRef, useState, type ReactNode } from 'react';

/** 工具栏外壳：左侧筛选区 + 右侧动作区 */
export function Toolbar({ filters, actions }: { filters?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="qz-toolbar">
      <div className="qz-toolbar__filters">{filters}</div>
      {actions ? <div className="qz-row">{actions}</div> : null}
    </div>
  );
}

/**
 * 搜索框（自带防抖）。
 *
 * ## 为什么必须防抖
 *
 * 按每个字符发一次请求，在中文输入法下会产生一串**拼音中间态**查询
 * （输入"张三"会先查 `z`、`zh`、`zha`）—— 既浪费后端，也会让列表
 * 在打字过程中反复闪空。300ms 是"手感与请求量"的常见平衡点。
 *
 * 防抖只作用于**向外通知**；输入框自身受控于本地 state，
 * 因此打字不会被防抖拖慢（受控值直接跟随用户输入）。
 */
export function SearchInput({
  value,
  onChange,
  placeholder = '搜索…',
  delay = 300,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  delay?: number;
}) {
  const [local, setLocal] = useState(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 外部条件被重置（如"清空筛选"）时同步回输入框
  useEffect(() => setLocal(value), [value]);

  useEffect(() => {
    if (local === value) return;
    const timer = setTimeout(() => onChangeRef.current(local), delay);
    return () => clearTimeout(timer);
    // value 变化代表"外部已接受"，无需再通知
  }, [local, value, delay]);

  return (
    <div className="qz-search">
      <span className="qz-search__icon">🔍</span>
      <input
        className="qz-input"
        value={local}
        placeholder={placeholder}
        onChange={(e) => setLocal(e.target.value)}
      />
    </div>
  );
}

/** 下拉筛选（值为空表示"全部"） */
export function SelectFilter({
  value,
  onChange,
  options,
  allLabel = '全部',
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
  allLabel?: string;
  ariaLabel?: string;
}) {
  return (
    <select
      className="qz-select"
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{allLabel}</option>
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

/** 页签（带可选计数，用于"待审 / 已审"这类视图切换） */
export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (next: T) => void;
  items: { value: T; label: string; count?: number }[];
}) {
  return (
    <div className="qz-tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.value}
          role="tab"
          aria-selected={item.value === value}
          className={`qz-tab${item.value === value ? ' is-active' : ''}`}
          onClick={() => onChange(item.value)}
        >
          {item.label}
          {item.count === undefined ? null : <span className="qz-tab__count">{item.count}</span>}
        </button>
      ))}
    </div>
  );
}
