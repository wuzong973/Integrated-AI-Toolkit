import { AdminPermission } from '@qz/core';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { PermissionGate } from '../../auth/PermissionGate';
import { AsyncBoundary } from '../../components/AsyncBoundary';
import { DataTable } from '../../components/DataTable';
import { useConfirm } from '../../components/Confirm';
import { Card, PageHeader } from '../../components/PageHeader';
import { Tag } from '../../components/Tag';
import { useToast } from '../../components/Toast';
import { jobsApi } from '../../lib/api';
import { formatMoney } from '../../lib/format';
import { toolCategoryText, toolStatus } from '../../lib/status';
import type { AdminToolItem } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';

/**
 * 工具管理。
 *
 * ## 上下线只开放 active / planned
 *
 * 这两个取值与 `seed.ts`、`check:tools` 的既有约定一致（只有 `active`
 * 会出现在 C 端且真能跑）。后台"下线"的语义是"先藏起来"，
 * 而不是发明第三种状态 —— 多一个状态就会多一个"这个状态到底可不可见"
 * 的判断点，而那些判断散落在 C 端各处。
 *
 * ## 为什么把"近 7 天作业数"放在列表里
 *
 * 它是判断"这个工具该不该下线"的唯一客观依据。没有它，运营只能凭印象；
 * 有了它，一个 7 天 0 次调用的工具一眼可见。
 */
export function ToolListPage() {
  const state = useAsync(() => jobsApi.tools(), []);
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const rows = state.data ?? [];
  const online = rows.filter((r) => r.status === 'active').length;

  const toggle = async (row: AdminToolItem) => {
    const goingOffline = row.status === 'active';
    const ok = await confirm({
      title: goingOffline ? '下线工具' : '上线工具',
      text: goingOffline
        ? `「${row.displayName}」将从 C 端隐藏，用户无法再调用。已产生的作业与文件不受影响。`
        : `「${row.displayName}」将出现在 C 端，用户可以调用。请确认它现在真的能跑通（否则界面写着"可用"、点了报错）。`,
      confirmText: goingOffline ? '确认下线' : '确认上线',
      danger: goingOffline,
    });
    if (!ok) return;

    setBusy(row.name);
    try {
      await jobsApi.setToolStatus(row.name, goingOffline ? 'planned' : 'active');
      toast.success(goingOffline ? '已下线' : '已上线', row.displayName);
      state.reload();
    } catch (err) {
      toast.fromError(err, '操作失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="工具管理"
        desc={`共 ${rows.length} 个工具，其中 ${online} 个已上线。只有「已上线」的工具会出现在小程序并真正可调用。`}
        actions={
          <button className="qz-btn" onClick={state.reload} disabled={state.loading}>
            刷新
          </button>
        }
      />

      <Card flush>
        <AsyncBoundary
          loading={state.loading && state.data === null}
          error={state.error}
          isEmpty={rows.length === 0}
          emptyTitle="没有工具"
          emptyDesc="先执行 npm run db:seed 灌入工具定义。"
          onRetry={state.reload}
        >
          <DataTable<AdminToolItem>
            rowKey={(r) => r.name}
            rows={rows}
            columns={[
              {
                key: 'name',
                title: '工具',
                cellClass: 'qz-cell--main',
                render: (r) => (
                  <>
                    {r.displayName}
                    <div className="qz-dim qz-mono">{r.name}</div>
                  </>
                ),
              },
              { key: 'category', title: '分类', render: (r) => toolCategoryText(r.category) },
              {
                key: 'status',
                title: '状态',
                render: (r) => {
                  const s = toolStatus(r.status);
                  return <Tag tone={s.tone}>{s.text}</Tag>;
                },
              },
              {
                key: 'visible',
                title: 'C 端可见',
                render: (r) => (r.visible ? '是' : <span className="qz-dim">否</span>),
              },
              { key: 'price', title: '价格', align: 'right', render: (r) => formatMoney(r.price) },
              {
                key: 'jobs7d',
                title: '近 7 天作业',
                align: 'right',
                render: (r) =>
                  r.jobs7d === 0 ? <span className="qz-dim">0</span> : <strong>{r.jobs7d}</strong>,
              },
              {
                key: 'actions',
                title: '操作',
                cellClass: 'qz-cell--actions',
                render: (r) => (
                  <div className="qz-actions">
                    <Link className="qz-btn qz-btn--ghost" to={`/jobs?toolName=${r.name}`}>
                      看作业
                    </Link>
                    <PermissionGate permission={AdminPermission.JobManage}>
                      <button
                        className="qz-btn qz-btn--ghost"
                        disabled={busy === r.name}
                        style={{ color: r.status === 'active' ? 'var(--danger-500)' : undefined }}
                        onClick={() => void toggle(r)}
                      >
                        {r.status === 'active' ? '下线' : '上线'}
                      </button>
                    </PermissionGate>
                  </div>
                ),
              },
            ]}
          />
        </AsyncBoundary>
      </Card>
    </>
  );
}
