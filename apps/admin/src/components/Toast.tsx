import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { toSdkError } from '../lib/useAsync';

export type ToastKind = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  desc?: string;
  /** 出错时带上 traceId：这是用户能提供给开发的唯一排查锚点 */
  traceId?: string;
}

interface ToastApi {
  success: (title: string, desc?: string) => void;
  info: (title: string, desc?: string) => void;
  error: (title: string, desc?: string, traceId?: string) => void;
  /** 直接把一个异常转成错误提示（自动取 message 与 traceId） */
  fromError: (err: unknown, title?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * 全局操作反馈。
 *
 * ## 为什么错误提示要带 `traceId`
 *
 * 后端返回的 `traceId` 是**唯一**能把"用户截图里的这个报错"和
 * "日志里的那一次请求"对上的东西。不显示它，用户只能描述
 * "我点了一下然后报错了"，排查要从几十万行日志里猜。
 *
 * ## 停留时长按紧急度区分
 *
 * 成功 3 秒够了（用户只需知道"好了"）；错误 6 秒，因为要看清
 * 一句话 + 一串 traceId，3 秒来不及读完。全部统一成 3 秒的结果是
 * 用户永远读不到报错内容，只能反复重试同一个必然失败的操作。
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, title: string, desc?: string, traceId?: string) => {
      const id = nextId.current++;
      setItems((prev) => [...prev, { id, kind, title, desc, traceId }]);
      setTimeout(() => remove(id), kind === 'error' ? 6000 : 3000);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (title, desc) => push('success', title, desc),
      info: (title, desc) => push('info', title, desc),
      error: (title, desc, traceId) => push('error', title, desc, traceId),
      fromError: (err, title = '操作失败') => {
        const e = toSdkError(err);
        push('error', title, e.message, e.traceId);
      },
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="qz-toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`qz-toast qz-toast--${t.kind}`}>
            <span aria-hidden>
              {t.kind === 'success' ? '✅' : t.kind === 'error' ? '⛔' : 'ℹ️'}
            </span>
            <div className="qz-toast__body">
              <div className="qz-toast__title">{t.title}</div>
              {t.desc ? <div className="qz-toast__desc">{t.desc}</div> : null}
              {t.traceId ? <div className="qz-toast__trace">traceId: {t.traceId}</div> : null}
            </div>
            <button className="qz-modal__close" onClick={() => remove(t.id)} aria-label="关闭提示">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast 必须在 <ToastProvider> 内使用');
  return ctx;
}
