import { useState } from 'react';

import { AsyncBoundary } from '../../components/AsyncBoundary';
import { DataTable } from '../../components/DataTable';
import { JsonBlock } from '../../components/JsonBlock';
import { Modal } from '../../components/Modal';
import { Card, PageHeader } from '../../components/PageHeader';
import { Pagination } from '../../components/Pagination';
import { SearchInput, Toolbar } from '../../components/Toolbar';
import { auditApi } from '../../lib/api';
import { formatDateTime, shorten } from '../../lib/format';
import type { AdminAuditItem } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';

const SIZE = 20;

/**
 * 操作日志。
 *
 * ## 这是后台"事后追责"的唯一入口
 *
 * 谁封了谁、谁放了款、谁重置了密码 —— 这些动作的业务表里都不留痕
 * （例如订单时间线记的是买家），只有 `audit_log` 有真实操作人。
 * 因此这一页按 `audit:view` 单列权限：默认给审核员与财务（要做申诉复核），
 * 不给运营。
 *
 * ## `action` 用模糊匹配（后端是 contains）
 *
 * 命名形如 `order.release` / `admin.password.change`，是分层的。
 * 输入 `order` 就能捞出整组，比要求用户背完整动作名实用。
 */
export function AuditLogPage() {
  const [action, setAction] = useState('');
  const [targetType, setTargetType] = useState('');
  const [targetId, setTargetId] = useState('');
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<AdminAuditItem | null>(null);

  const state = useAsync(
    () => auditApi.list({ action, targetType, targetId, page, size: SIZE }),
    [action, targetType, targetId, page],
  );

  const rows = state.data?.list ?? [];
  const total = state.data?.total ?? 0;

  return (
    <>
      <PageHeader
        title="操作日志"
        desc="所有后台管理动作的留痕。业务表不记录真实操作人，纠纷复盘与责任认定以本页为准。"
        actions={
          <button className="qz-btn" onClick={state.reload} disabled={state.loading}>
            刷新
          </button>
        }
      />

      <Card flush>
        <Toolbar
          filters={
            <>
              <SearchInput
                value={action}
                onChange={(v) => {
                  setAction(v);
                  setPage(1);
                }}
                placeholder="动作（如 order / admin.password）"
              />
              <SearchInput
                value={targetType}
                onChange={(v) => {
                  setTargetType(v);
                  setPage(1);
                }}
                placeholder="目标类型（如 order / tool_job）"
              />
              <SearchInput
                value={targetId}
                onChange={(v) => {
                  setTargetId(v);
                  setPage(1);
                }}
                placeholder="目标 ID（精确）"
              />
            </>
          }
        />

        <AsyncBoundary
          loading={state.loading && state.data === null}
          error={state.error}
          isEmpty={rows.length === 0}
          emptyTitle="没有日志"
          emptyDesc="登录、封禁、裁决、重置密码等动作都会写入这里。"
          onRetry={state.reload}
        >
          <DataTable<AdminAuditItem>
            rowKey={(r) => r.id}
            rows={rows}
            onRowClick={(r) => setViewing(r)}
            columns={[
              {
                key: 'action',
                title: '动作',
                cellClass: 'qz-cell--main',
                render: (r) => <span className="qz-mono">{r.action}</span>,
              },
              {
                key: 'target',
                title: '目标',
                render: (r) =>
                  r.targetType ? (
                    <>
                      <span className="qz-mono">{r.targetType}</span>
                      <div className="qz-dim qz-mono">{shorten(r.targetId, 10, 4)}</div>
                    </>
                  ) : (
                    <span className="qz-dim">—</span>
                  ),
              },
              {
                key: 'actor',
                title: '操作人',
                render: (r) => (
                  <span className="qz-mono">{r.actorId ? shorten(r.actorId, 8, 4) : '—'}</span>
                ),
              },
              {
                key: 'ip',
                title: 'IP',
                render: (r) => <span className="qz-mono">{r.ip ?? '—'}</span>,
              },
              { key: 'createdAt', title: '时间', render: (r) => formatDateTime(r.createdAt) },
            ]}
          />
          <Pagination page={page} size={SIZE} total={total} onChange={setPage} />
        </AsyncBoundary>
      </Card>

      <AuditDetailModal item={viewing} onClose={() => setViewing(null)} />
    </>
  );
}

/** 单条日志的前后值对比 */
function AuditDetailModal({ item, onClose }: { item: AdminAuditItem | null; onClose: () => void }) {
  if (!item) return null;
  return (
    <Modal open wide title={`操作日志 · ${item.action}`} onClose={onClose}>
      <div className="qz-col" style={{ gap: 'var(--sp-4)' }}>
        <div className="qz-desc">
          <div>
            <div className="qz-desc__label">时间</div>
            <div className="qz-desc__value">{formatDateTime(item.createdAt)}</div>
          </div>
          <div>
            <div className="qz-desc__label">操作人</div>
            <div className="qz-desc__value qz-mono">{item.actorId ?? '—'}</div>
          </div>
          <div>
            <div className="qz-desc__label">目标</div>
            <div className="qz-desc__value qz-mono">
              {item.targetType ?? '—'} / {item.targetId ?? '—'}
            </div>
          </div>
          <div>
            <div className="qz-desc__label">来源 IP</div>
            <div className="qz-desc__value qz-mono">{item.ip ?? '—'}</div>
          </div>
        </div>

        <div>
          <div className="qz-desc__label">变更前</div>
          <JsonBlock value={item.before} />
        </div>
        <div>
          <div className="qz-desc__label">变更后</div>
          <JsonBlock value={item.after} />
        </div>
      </div>
    </Modal>
  );
}
