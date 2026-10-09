import type { ReactNode } from 'react';

import type { SdkError } from '../lib/http';

/** 空态 */
export function EmptyState({
  icon = '📭',
  title,
  desc,
  action,
}: {
  icon?: string;
  title: string;
  desc?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="qz-empty">
      <div className="qz-empty__icon">{icon}</div>
      <div className="qz-empty__title">{title}</div>
      {desc ? <div className="qz-empty__desc">{desc}</div> : null}
      {action}
    </div>
  );
}

/**
 * 数据区域的四态渲染：加载 / 出错 / 空 / 正常。
 *
 * ## 为什么错误态必须显式渲染（不能只显示空列表）
 *
 * "请求失败"与"确实没有数据"在界面上长得一样（都是空表格），
 * 但处置完全不同：前者要重试，后者要看筛选条件。把失败渲染成空，
 * 运营会得出"今天没有待审"的结论并直接下班 —— 这是最危险的一类误读。
 *
 * 因此这里错误态**一定**显示错误信息 + traceId（可拿去查日志）+ 重试按钮。
 */
export function AsyncBoundary({
  loading,
  error,
  isEmpty = false,
  emptyTitle = '暂无数据',
  emptyDesc,
  onRetry,
  children,
}: {
  loading: boolean;
  error: SdkError | null;
  isEmpty?: boolean;
  emptyTitle?: string;
  emptyDesc?: ReactNode;
  onRetry?: () => void;
  children: ReactNode;
}) {
  // 首次加载（还没有任何数据）时显示居中 loading；后续刷新由工具栏提示
  if (loading) {
    return (
      <div className="qz-loading">
        <span className="qz-spinner" />
        加载中…
      </div>
    );
  }

  if (error) {
    return (
      <div className="qz-card__body">
        <div className="qz-alert qz-alert--error">
          <div>
            <div style={{ fontWeight: 500 }}>{error.message}</div>
            {error.traceId ? <div className="qz-mono">traceId: {error.traceId}</div> : null}
          </div>
        </div>
        {onRetry ? (
          <div className="qz-mt-4">
            <button className="qz-btn" onClick={onRetry}>
              重试
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  if (isEmpty) {
    return <EmptyState title={emptyTitle} desc={emptyDesc} />;
  }

  return <>{children}</>;
}
