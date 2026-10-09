import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { Button } from './Button';

export interface ConfirmOptions {
  title: string;
  text: ReactNode;
  /** ⚠️ 必须写明动作（"确认删除"而不是"确定"），让人不必回读标题 */
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface Pending {
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

/**
 * 确认框（命令式：`const ok = await confirm({...})`）。
 *
 * ## 三个刻意的设计
 *
 * ① **点遮罩不关闭**：删除账号、放款、封禁这类操作，被误触遮罩关掉后
 *    用户会以为"已经执行了"（弹窗消失了），而实际什么都没发生 ——
 *    与"以为取消了但实际执行了"相比，这个方向的误解更隐蔽。
 *    所以必须显式点"取消"或"确认"。
 *
 * ② **默认焦点在"取消"**：回车不会执行危险操作。危险按钮上默认聚焦
 *    是事故的经典来源。
 *
 * ③ **去掉按钮上的 loading 态**：确认框在点下按钮的瞬间就关闭，
 *    真正耗时的请求由调用方用自己的状态展示（页面上的行内 loading）。
 *    在这里做 loading 会出现"两个进度指示器"。
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const confirm = useCallback<ConfirmFn>(
    (options) => new Promise<boolean>((resolve) => setPending({ options, resolve })),
    [],
  );

  useEffect(() => {
    if (pending) cancelRef.current?.focus();
  }, [pending]);

  const finish = useCallback(
    (ok: boolean) => {
      pending?.resolve(ok);
      setPending(null);
    },
    [pending],
  );

  // Esc 视作取消（与"默认焦点在取消"同一取向：安全的那一侧）
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, finish]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending ? (
        <div className="qz-mask">
          <div className="qz-confirm" role="alertdialog" aria-modal="true">
            <div className="qz-confirm__title">{pending.options.title}</div>
            <div className="qz-confirm__text">{pending.options.text}</div>
            <div className="qz-confirm__actions">
              <button className="qz-btn" ref={cancelRef} onClick={() => finish(false)}>
                {pending.options.cancelText ?? '取消'}
              </button>
              <Button
                variant={pending.options.danger ? 'danger' : 'primary'}
                onClick={() => finish(true)}
              >
                {pending.options.confirmText ?? '确认'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm 必须在 <ConfirmProvider> 内使用');
  return ctx;
}
