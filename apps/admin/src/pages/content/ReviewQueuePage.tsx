import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AdminPermission } from '@qz/core';

import { PermissionGate } from '../../auth/PermissionGate';
import { AsyncBoundary } from '../../components/AsyncBoundary';
import { useConfirm } from '../../components/Confirm';
import { DataTable } from '../../components/DataTable';
import { Card, PageHeader } from '../../components/PageHeader';
import { Pagination } from '../../components/Pagination';
import { Tag } from '../../components/Tag';
import { SelectFilter, Tabs, Toolbar } from '../../components/Toolbar';
import { useToast } from '../../components/Toast';
import { contentApi } from '../../lib/api';
import { EMPTY, formatDateTime } from '../../lib/format';
import { verificationStatus } from '../../lib/status';
import type { AdminVerificationItem } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';

import { MaterialsModal, RejectModal } from './ReviewModals';

const SIZE = 20;

type TabValue = '' | 'pending' | 'approved' | 'rejected';

const TABS: { value: TabValue; label: string }[] = [
  { value: 'pending', label: '待审核' },
  { value: 'approved', label: '已通过' },
  { value: 'rejected', label: '已拒绝' },
  { value: '', label: '全部' },
];

const TYPE_OPTIONS = [
  { value: 'provider', label: '服务者认证' },
  { value: 'student', label: '学生认证' },
  { value: 'merchant', label: '商户认证' },
];

/**
 * 认证审核队列。
 *
 * ## 默认落在"待审核"页签
 *
 * 审核员打开这一页就是要干活。默认显示"全部"会把已审的历史混进来，
 * 每次都要先点一下页签。状态由 URL 承载（`?status=pending`），
 * 因此看板上的"待审认证"入口点进来就是正确视图。
 *
 * ## 通过是有副作用的，所以用不同的交互
 *
 * 「通过」会授予接单角色、写回真实姓名与技能画像 —— 一步到位、无法在界面上撤销；
 * 「拒绝」只改状态，且必须写明原因（后端 schema 强制 ≥4 字）。
 * 因此通过走确认框（把后果讲清），拒绝走带理由的弹窗。
 */
export function ReviewQueuePage() {
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') ?? 'pending') as TabValue;
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [rejecting, setRejecting] = useState<AdminVerificationItem | null>(null);
  const [viewing, setViewing] = useState<AdminVerificationItem | null>(null);

  const confirm = useConfirm();
  const toast = useToast();

  const state = useAsync(
    () => contentApi.verifications({ status, type, page, size: SIZE }),
    [status, type, page],
  );

  const rows = state.data?.list ?? [];
  const total = state.data?.total ?? 0;

  const approve = async (row: AdminVerificationItem) => {
    const ok = await confirm({
      title: '通过认证申请',
      text: `通过后该用户将获得「${row.typeLabel}」对应的角色，并写回真实姓名与技能画像。 此操作在界面上不可撤销。`,
      confirmText: '确认通过',
    });
    if (!ok) return;
    try {
      await contentApi.review(row.id, true);
      toast.success('已通过', `${row.nickname ?? row.userId} 的${row.typeLabel}已生效`);
      state.reload();
    } catch (err) {
      toast.fromError(err, '审核失败');
    }
  };

  return (
    <>
      <PageHeader
        title="认证审核"
        desc="当前全平台只有服务者认证定义了审核流程；其它类型会明确报错而不是半实现。"
      />

      <Card flush>
        <Tabs
          value={status}
          items={TABS}
          onChange={(v) => {
            setParams(v ? { status: v } : {});
            setPage(1);
          }}
        />
        <Toolbar
          filters={
            <SelectFilter
              ariaLabel="按认证类型筛选"
              value={type}
              options={TYPE_OPTIONS}
              onChange={(v) => {
                setType(v);
                setPage(1);
              }}
            />
          }
          actions={
            <button className="qz-btn qz-btn--sm" onClick={state.reload} disabled={state.loading}>
              刷新
            </button>
          }
        />

        <AsyncBoundary
          loading={state.loading && state.data === null}
          error={state.error}
          isEmpty={rows.length === 0}
          emptyTitle={status === 'pending' ? '没有待审核的申请' : '没有匹配的申请'}
          emptyDesc={
            status === 'pending' ? '所有认证申请都已处理完毕。' : '试试切换页签或放宽筛选条件。'
          }
          onRetry={state.reload}
        >
          <DataTable<AdminVerificationItem>
            rowKey={(r) => r.id}
            rows={rows}
            columns={[
              {
                key: 'user',
                title: '申请人',
                cellClass: 'qz-cell--main',
                render: (r) => (
                  <>
                    {r.nickname ?? '(未设置昵称)'}
                    <div className="qz-dim">{r.phone ?? r.userId.slice(0, 8)}</div>
                  </>
                ),
              },
              { key: 'type', title: '类型', render: (r) => <Tag tone="info">{r.typeLabel}</Tag> },
              { key: 'realName', title: '真实姓名', render: (r) => r.realName ?? EMPTY },
              {
                key: 'college',
                title: '学院 / 学校',
                render: (r) => r.college ?? r.schoolName ?? EMPTY,
              },
              {
                key: 'skills',
                title: '技能标签',
                render: (r) =>
                  r.skillTags.length ? (
                    <span className="qz-row qz-wrap" style={{ gap: 4 }}>
                      {r.skillTags.slice(0, 3).map((t) => (
                        <span key={t} className="qz-tag qz-tag--neutral">
                          {t}
                        </span>
                      ))}
                      {r.skillTags.length > 3 ? <span className="qz-dim">…</span> : null}
                    </span>
                  ) : (
                    <span className="qz-dim">—</span>
                  ),
              },
              {
                key: 'status',
                title: '状态',
                render: (r) => {
                  const s = verificationStatus(r.status);
                  return <Tag tone={s.tone}>{s.text}</Tag>;
                },
              },
              { key: 'materials', title: '材料', render: (r) => `${r.materials.length} 项` },
              { key: 'createdAt', title: '提交时间', render: (r) => formatDateTime(r.createdAt) },
              {
                key: 'actions',
                title: '操作',
                cellClass: 'qz-cell--actions',
                render: (r) => (
                  <div className="qz-actions">
                    <button className="qz-btn qz-btn--ghost" onClick={() => setViewing(r)}>
                      查看材料
                    </button>
                    {r.status === 'pending' ? (
                      <PermissionGate permission={AdminPermission.ContentReview}>
                        <button className="qz-btn qz-btn--ghost" onClick={() => void approve(r)}>
                          通过
                        </button>
                        <button
                          className="qz-btn qz-btn--ghost"
                          style={{ color: 'var(--danger-500)' }}
                          onClick={() => setRejecting(r)}
                        >
                          拒绝
                        </button>
                      </PermissionGate>
                    ) : (
                      <span className="qz-dim" style={{ fontSize: 'var(--fs-tag)' }}>
                        已处理
                      </span>
                    )}
                  </div>
                ),
              },
            ]}
          />
          <Pagination page={page} size={SIZE} total={total} onChange={setPage} />
        </AsyncBoundary>
      </Card>

      {rejecting ? (
        <RejectModal target={rejecting} onClose={() => setRejecting(null)} onDone={state.reload} />
      ) : null}

      <MaterialsModal target={viewing} onClose={() => setViewing(null)} />
    </>
  );
}
