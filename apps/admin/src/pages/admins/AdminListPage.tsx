import { AdminPermission } from '@qz/core';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuth } from '../../auth/useAuth';
import { PermissionGate } from '../../auth/PermissionGate';
import { AsyncBoundary } from '../../components/AsyncBoundary';
import { DataTable } from '../../components/DataTable';
import { Card, PageHeader } from '../../components/PageHeader';
import { Pagination } from '../../components/Pagination';
import { Tag } from '../../components/Tag';
import { SearchInput, SelectFilter, Toolbar } from '../../components/Toolbar';
import { useConfirm } from '../../components/Confirm';
import { useToast } from '../../components/Toast';
import { adminsApi } from '../../lib/api';
import { formatRelative } from '../../lib/format';
import { adminStatus } from '../../lib/status';
import type { AdminAccountItem } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';

import { AdminCreateModal, AdminEditModal, AdminResetPasswordModal } from './AdminAccountModals';

const SIZE = 20;

const ROLE_FILTERS = [
  { value: 'super_admin', label: '超级管理员' },
  { value: 'operator', label: '运营' },
  { value: 'auditor', label: '审核员' },
  { value: 'finance', label: '财务' },
];

/**
 * 管理员账号管理。
 *
 * ## 界面上对"自己"这一行禁用危险动作
 *
 * 后端已有两道硬约束（不能改自己的角色/状态、不能删掉最后一个超管），
 * 这里再禁一遍**不是重复劳动**：让用户点一个必然失败的按钮，
 * 只会收获一条报错，而不是理解"为什么不行"。禁用 + 说明原因，
 * 才是把规则讲清楚的方式。
 */
export function AdminListPage() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const { profile } = useAuth();
  const [keyword, setKeyword] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminAccountItem | null>(null);
  const [resetting, setResetting] = useState<AdminAccountItem | null>(null);

  const state = useAsync(
    () => adminsApi.list({ keyword, adminRole: role, status, page, size: SIZE }),
    [keyword, role, status, page],
  );

  const rows = state.data?.list ?? [];
  const total = state.data?.total ?? 0;

  const remove = async (row: AdminAccountItem) => {
    const ok = await confirm({
      title: '删除管理员账号',
      text: `将删除「${row.displayName}（${row.username}）」的后台账号与管理员角色。该用户的普通账号会被保留，并可继续作为学生使用。`,
      confirmText: '确认删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await adminsApi.remove(row.id);
      toast.success('已删除管理员账号');
      state.reload();
    } catch (err) {
      toast.fromError(err, '删除失败');
    }
  };

  return (
    <>
      <PageHeader
        title="管理员账号"
        desc="后台账号与角色。角色决定权限，权限矩阵见「角色权限矩阵」页。"
        actions={
          <PermissionGate permission={AdminPermission.AdminManage}>
            <button className="qz-btn qz-btn--primary" onClick={() => setCreating(true)}>
              新建管理员
            </button>
          </PermissionGate>
        }
      />

      <Card flush>
        <Toolbar
          filters={
            <>
              <SearchInput
                value={keyword}
                onChange={(v) => {
                  setKeyword(v);
                  setPage(1);
                }}
                placeholder="用户名 / 显示名"
              />
              <SelectFilter
                ariaLabel="按角色筛选"
                value={role}
                options={ROLE_FILTERS}
                onChange={(v) => {
                  setRole(v);
                  setPage(1);
                }}
              />
              <SelectFilter
                ariaLabel="按状态筛选"
                value={status}
                options={[
                  { value: 'active', label: '启用' },
                  { value: 'disabled', label: '已禁用' },
                ]}
                onChange={(v) => {
                  setStatus(v);
                  setPage(1);
                }}
              />
            </>
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
          emptyTitle="没有匹配的管理员"
          onRetry={state.reload}
        >
          <DataTable<AdminAccountItem>
            rowKey={(r) => r.id}
            rows={rows}
            onRowClick={(r) => navigate(`/admins/${r.id}`)}
            columns={[
              {
                key: 'name',
                title: '管理员',
                cellClass: 'qz-cell--main',
                render: (r) => (
                  <Link to={`/admins/${r.id}`} onClick={(e) => e.stopPropagation()}>
                    {r.displayName}
                    <div className="qz-dim qz-mono">
                      {r.username}
                      {r.id === profile?.id ? ' · 我' : ''}
                    </div>
                  </Link>
                ),
              },
              {
                key: 'role',
                title: '角色',
                render: (r) => <Tag tone="brand">{r.adminRoleLabel}</Tag>,
              },
              {
                key: 'status',
                title: '状态',
                render: (r) => {
                  const s = adminStatus(r.status);
                  return <Tag tone={s.tone}>{s.text}</Tag>;
                },
              },
              {
                key: 'user',
                title: '关联用户',
                render: (r) => r.nickname ?? <span className="qz-dim">—</span>,
              },
              { key: 'login', title: '最近登录', render: (r) => formatRelative(r.lastLoginAt) },
              {
                key: 'actions',
                title: '操作',
                cellClass: 'qz-cell--actions',
                render: (r) => {
                  const isSelf = r.id === profile?.id;
                  return (
                    <div className="qz-actions" onClick={(e) => e.stopPropagation()}>
                      <Link className="qz-btn qz-btn--ghost" to={`/admins/${r.id}`}>
                        详情
                      </Link>
                      {isSelf ? (
                        <span className="qz-dim" style={{ fontSize: 'var(--fs-tag)' }}>
                          不能操作自己
                        </span>
                      ) : (
                        <PermissionGate permission={AdminPermission.AdminManage}>
                          <button className="qz-btn qz-btn--ghost" onClick={() => setEditing(r)}>
                            编辑
                          </button>
                          <button className="qz-btn qz-btn--ghost" onClick={() => setResetting(r)}>
                            重置密码
                          </button>
                          <button
                            className="qz-btn qz-btn--ghost"
                            style={{ color: 'var(--danger-500)' }}
                            onClick={() => void remove(r)}
                          >
                            删除
                          </button>
                        </PermissionGate>
                      )}
                    </div>
                  );
                },
              },
            ]}
          />
          <Pagination page={page} size={SIZE} total={total} onChange={setPage} />
        </AsyncBoundary>
      </Card>

      {creating ? (
        <AdminCreateModal onClose={() => setCreating(false)} onDone={state.reload} />
      ) : null}
      <AdminEditModal target={editing} onClose={() => setEditing(null)} onDone={state.reload} />
      {resetting ? (
        <AdminResetPasswordModal
          target={resetting}
          onClose={() => setResetting(null)}
          onDone={state.reload}
        />
      ) : null}
    </>
  );
}
