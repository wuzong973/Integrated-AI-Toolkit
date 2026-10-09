import type { ReactNode } from 'react';

/** 页头：标题 + 说明 + 右侧动作区 */
export function PageHeader({
  title,
  desc,
  actions,
}: {
  title: string;
  desc?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="qz-page-header">
      <div>
        <h1 className="qz-page-header__title">{title}</h1>
        {desc ? <div className="qz-page-header__desc">{desc}</div> : null}
      </div>
      {actions ? <div className="qz-page-header__actions">{actions}</div> : null}
    </div>
  );
}

/** 卡片容器（表格、表单、详情都装在里面） */
export function Card({
  title,
  subtitle,
  extra,
  flush = false,
  children,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  extra?: ReactNode;
  /** 表格类内容不需要内边距 */
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="qz-card">
      {title ? (
        <header className="qz-card__header">
          <div>
            <div className="qz-card__title">{title}</div>
            {subtitle ? <div className="qz-card__subtitle">{subtitle}</div> : null}
          </div>
          {extra}
        </header>
      ) : null}
      <div className={flush ? 'qz-card__body qz-card__body--flush' : 'qz-card__body'}>
        {children}
      </div>
    </section>
  );
}
