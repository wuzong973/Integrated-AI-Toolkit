import { Link, useNavigate, useParams } from 'react-router-dom';
import { ADMIN_PERMISSION_GROUPS, ADMIN_PERMISSION_LABELS } from '@qz/core';

import { AsyncBoundary } from '../../components/AsyncBoundary';
import { DescList } from '../../components/DescList';
import { Card, PageHeader } from '../../components/PageHeader';
import { Tag } from '../../components/Tag';
import { adminsApi } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { adminStatus } from '../../lib/status';
import { useAsync } from '../../lib/useAsync';

/** 状态标签（抽成函数，避免在描述数组里塞 IIFE） */
function StatusTag({ status }: { status: string }) {
  const s = adminStatus(status);
  return <Tag tone={s.tone}>{s.text}</Tag>;
}

/**
 * 管理员详情。
 *
 * 权限列表按 `@qz/core` 的 `ADMIN_PERMISSION_GROUPS` 分组渲染，
 * **从后端返回的 `permissions` 里筛**（而不是拿角色去查矩阵）：
 * 这样"后端改了矩阵、账号权限还没同步"时，界面上看到的与接口实际放行的
 * 是一致的 —— 排查 403 时不会被一份过期的矩阵带偏。
 */
export function AdminDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const state = useAsync(() => adminsApi.detail(id), [id]);
  const d = state.data;

  return (
    <>
      <PageHeader
        title={d ? d.displayName : '管理员详情'}
        desc={<span className="qz-mono">账号 ID：{id}</span>}
        actions={
          <>
            <button className="qz-btn" onClick={() => navigate('/admins')}>
              返回列表
            </button>
            {d ? (
              <Link className="qz-btn" to={`/users/${d.userId}`}>
                查看关联用户
              </Link>
            ) : null}
          </>
        }
      />

      <AsyncBoundary loading={state.loading} error={state.error} onRetry={state.reload}>
        {d ? (
          <div className="qz-col" style={{ gap: 'var(--sp-5)' }}>
            <Card title="账号信息">
              <DescList
                items={[
                  { label: '用户名', value: <span className="qz-mono">{d.username}</span> },
                  { label: '显示名', value: d.displayName },
                  { label: '角色', value: <Tag tone="brand">{d.adminRoleLabel}</Tag> },
                  { label: '状态', value: <StatusTag status={d.status} /> },
                  { label: '关联用户昵称', value: d.nickname ?? '—' },
                  { label: '关联用户手机号', value: d.phone ?? '—' },
                  { label: '最近登录', value: formatDateTime(d.lastLoginAt) },
                  { label: '创建时间', value: formatDateTime(d.createdAt) },
                  {
                    label: '权限点数量',
                    value: `${d.permissions.length} 项`,
                    span: true,
                  },
                ]}
              />
            </Card>

            <Card title="实际生效的权限" subtitle="来自后端裁定；界面菜单与按钮均以此为准">
              <div className="qz-col" style={{ gap: 'var(--sp-4)' }}>
                {ADMIN_PERMISSION_GROUPS.map((group) => {
                  const granted = group.permissions.filter((p) => d.permissions.includes(p));
                  return (
                    <div key={group.key}>
                      <div className="qz-desc__label">
                        {group.label}
                        <span className="qz-dim">
                          {' '}
                          {granted.length}/{group.permissions.length}
                        </span>
                      </div>
                      <div className="qz-row qz-wrap qz-mt-2">
                        {group.permissions.map((perm) => {
                          const on = d.permissions.includes(perm);
                          return (
                            <span
                              key={perm}
                              className={`qz-tag qz-tag--${on ? 'success' : 'neutral'}`}
                              title={perm}
                            >
                              {on ? '✓' : '✗'} {ADMIN_PERMISSION_LABELS[perm]}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>
        ) : null}
      </AsyncBoundary>
    </>
  );
}
