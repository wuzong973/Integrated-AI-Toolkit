import type { ReactNode } from 'react';

/** 键值对描述列表（详情页统一用它，避免每页各写一遍栅格） */
export interface DescItem {
  label: string;
  value: ReactNode;
  /** 独占整行（长文本、JSON 用） */
  span?: boolean;
}

export function DescList({ items, single = false }: { items: DescItem[]; single?: boolean }) {
  return (
    <div className={single ? 'qz-desc qz-desc--single' : 'qz-desc'}>
      {items.map((item) => (
        <div key={item.label} style={item.span ? { gridColumn: '1 / -1' } : undefined}>
          <div className="qz-desc__label">{item.label}</div>
          <div className="qz-desc__value">{item.value}</div>
        </div>
      ))}
    </div>
  );
}
