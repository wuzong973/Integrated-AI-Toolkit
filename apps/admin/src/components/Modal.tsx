import { useEffect, type ReactNode } from 'react';

/** 模态框（表单编辑、JSON 查看等） */
export function Modal({
  open,
  title,
  onClose,
  footer,
  wide = false,
  children,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  // Esc 关闭：键盘用户不该被迫去点那个 ×
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 打开时锁背景滚动，避免"拖着弹窗背后的表格一起滚"
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="qz-mask"
      onMouseDown={(e) => {
        // 只在"按下时就在遮罩上"才关闭：否则从弹窗内拖选文本到遮罩会误关
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={wide ? 'qz-modal qz-modal--wide' : 'qz-modal'}
        role="dialog"
        aria-modal="true"
      >
        <header className="qz-modal__header">
          <div className="qz-modal__title">{title}</div>
          <button className="qz-modal__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="qz-modal__body">{children}</div>
        {footer ? <footer className="qz-modal__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
