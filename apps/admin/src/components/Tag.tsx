import type { ReactNode } from 'react';

import type { Tone } from '../lib/status';

/** 状态标签 */
export function Tag({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`qz-tag qz-tag--${tone}`}>{children}</span>;
}

/**
 * 质量分徽章。
 *
 * `null` 渲染成 `—` 而不是 `0`：非 AI 工具本来就没有质量分，
 * 显示 0 分会让运营去追查一个并不存在的问题。
 */
export function ScoreBadge({
  score,
  tone,
}: {
  score: number | null;
  tone: 'good' | 'fair' | 'poor' | null;
}) {
  if (tone === null || score === null) return <span className="qz-dim">—</span>;
  return (
    <span className={`qz-score qz-score--${tone}`}>
      {score}
      <span className="qz-dim" style={{ fontSize: 11 }}>
        分
      </span>
    </span>
  );
}
