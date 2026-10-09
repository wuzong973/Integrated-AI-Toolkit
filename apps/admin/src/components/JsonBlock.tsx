import { prettyJson } from '../lib/format';

/**
 * JSON 展示块（作业参数、审计前后值）。
 *
 * `null` / `{}` / `[]` 统一显示为 `—`：审计日志里大量条目本来就没有
 * `before`（如"新建"），渲染成一个空的大括号会让页面里塞满无意义的符号。
 */
export function JsonBlock({ value, maxHeight = 220 }: { value: unknown; maxHeight?: number }) {
  const text = prettyJson(value);
  if (text === '—') return <span className="qz-dim">—</span>;
  return (
    <pre
      className="qz-mono"
      style={{
        margin: 0,
        padding: 'var(--sp-3)',
        background: 'var(--bg-sunken)',
        border: '1px solid var(--border-soft)',
        borderRadius: 'var(--r-md)',
        maxHeight,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        lineHeight: 1.5,
      }}
    >
      {text}
    </pre>
  );
}

/** 进度条（作业进度；失败态用红色，避免"红着还是满格绿"的误导） */
export function ProgressBar({ value, failed = false }: { value: number; failed?: boolean }) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div
      className="qz-progress"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={failed ? 'qz-progress__bar is-failed' : 'qz-progress__bar'}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
