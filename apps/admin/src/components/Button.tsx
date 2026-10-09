import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'default' | 'primary' | 'danger' | 'ghost';
type Size = 'md' | 'sm';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** 请求进行中：自动禁用并显示转圈，**防止重复提交** */
  loading?: boolean;
  block?: boolean;
  children: ReactNode;
}

/**
 * 按钮。
 *
 * `loading` 时必须同时 `disabled` —— 否则用户可以在请求飞行中再点一次，
 * 而"重跑作业""放款"这类操作重复提交的后果是钱和额度，不只是脏数据。
 */
export function Button({
  variant = 'default',
  size = 'md',
  loading = false,
  block = false,
  disabled,
  children,
  className,
  ...rest
}: Props) {
  const classes = [
    'qz-btn',
    variant !== 'default' && `qz-btn--${variant}`,
    size === 'sm' && 'qz-btn--sm',
    block && 'qz-btn--block',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={classes} disabled={disabled || loading} {...rest}>
      {loading && <span className="qz-spinner" />}
      {children}
    </button>
  );
}
