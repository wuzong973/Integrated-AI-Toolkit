import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { AsyncBoundary } from '../../components/AsyncBoundary';
import { DataTable } from '../../components/DataTable';
import { Card, PageHeader } from '../../components/PageHeader';
import { Pagination } from '../../components/Pagination';
import { Tag } from '../../components/Tag';
import { SearchInput, SelectFilter, Toolbar } from '../../components/Toolbar';
import { usersApi } from '../../lib/api';
import { formatDateTime, formatRelative, shorten } from '../../lib/format';
import { roleOptions, roleText, userStatus, userStatusOptions } from '../../lib/status';
import type { AdminUserItem } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';

import { UserStatusModal } from './UserStatusModal';

const SIZE = 20;

/**
 * 用户管理。
 *
 * ## 为什么没有"新建用户"
 *
 * 用户身份来自微信 openid，后台造不出一个能真正登录的账号；
 * 同理也没有"删除用户"—— 那会顺着外键级联清掉订单、作业、钱包，
 * 是数据事故而不是"清理"。后台能做的是改状态与改角色。
 */
export function UserListPage() {
  const navigate = useNavigate();
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(1);
  const [modalTarget, setModalTarget] = useState<AdminUserItem | null>(null);

  const state = useAsync(
    () => usersApi.list({ keyword, status, role, page, size: SIZE }),
    [keyword, status, role, page],
  );

  const rows = state.data?.list ?? [];
  const total = state.data?.total ?? 0;

  return (
    <>
      <PageHeader
        title="用户管理"
        desc="查看用户资料、信用与资产；封禁会立即生效并写入操作日志。"
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
                placeholder="昵称 / 手机号 / 真实姓名"
              />
              <SelectFilter
                ariaLabel="按状态筛选"
                value={status}
                options={userStatusOptions()}
                onChange={(v) => {
                  setStatus(v);
                  setPage(1);
                }}
              />
              <SelectFilter
                ariaLabel="按角色筛选"
                value={role}
                options={roleOptions()}
                onChange={(v) => {
                  setRole(v);
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
          emptyTitle="没有匹配的用户"
          emptyDesc="试试放宽筛选条件，或清空搜索关键词。"
          onRetry={state.reload}
        >
          <DataTable<AdminUserItem>
            rowKey={(r) => r.id}
            rows={rows}
            onRowClick={(r) => navigate(`/users/${r.id}`)}
            columns={[
              {
                key: 'user',
                title: '用户',
                cellClass: 'qz-cell--main',
                render: (r) => (
                  <Link to={`/users/${r.id}`} onClick={(e) => e.stopPropagation()}>
                    {r.nickname ?? '(未设置昵称)'}
                    <div className="qz-dim qz-mono">{shorten(r.id)}</div>
                  </Link>
                ),
              },
              {
                key: 'phone',
                title: '手机号',
                render: (r) => r.phone ?? <span className="qz-dim">—</span>,
              },
              {
                key: 'status',
                title: '状态',
                render: (r) => {
                  const s = userStatus(r.status);
                  return <Tag tone={s.tone}>{s.text}</Tag>;
                },
              },
              {
                key: 'roles',
                title: '角色',
                render: (r) =>
                  r.roles.length ? (
                    <span className="qz-row qz-wrap" style={{ gap: 4 }}>
                      {r.roles.map((x) => (
                        <span key={x} className="qz-tag qz-tag--neutral">
                          {roleText(x)}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="qz-dim">—</span>
                  ),
              },
              { key: 'credit', title: '信用分', align: 'right', render: (r) => r.creditScore },
              { key: 'points', title: '积分', align: 'right', render: (r) => r.points },
              {
                key: 'login',
                title: '最近登录',
                render: (r) => (
                  <span title={formatDateTime(r.lastLogin)}>{formatRelative(r.lastLogin)}</span>
                ),
              },
              {
                key: 'actions',
                title: '操作',
                cellClass: 'qz-cell--actions',
                render: (r) => (
                  <div className="qz-actions" onClick={(e) => e.stopPropagation()}>
                    <Link className="qz-btn qz-btn--ghost" to={`/users/${r.id}`}>
                      详情
                    </Link>
                    <button
                      className="qz-btn qz-btn--ghost"
                      onClick={() => setModalTarget(r)}
                      style={{ color: r.status === 'active' ? 'var(--danger-500)' : undefined }}
                    >
                      {r.status === 'active' ? '封禁' : '解封'}
                    </button>
                  </div>
                ),
              },
            ]}
          />
          <Pagination page={page} size={SIZE} total={total} onChange={setPage} />
        </AsyncBoundary>
      </Card>

      {modalTarget ? (
        <UserStatusModal
          target={modalTarget}
          onClose={() => setModalTarget(null)}
          onDone={state.reload}
        />
      ) : null}
    </>
  );
}
