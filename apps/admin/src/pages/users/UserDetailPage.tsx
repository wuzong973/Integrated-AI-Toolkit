import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AdminUserUpdateSchema, isAdminUserStatus, type AdminUserUpdateDto } from '@qz/core';

import { AsyncBoundary } from '../../components/AsyncBoundary';
import { Button } from '../../components/Button';
import { DescList, type DescItem } from '../../components/DescList';
import { Field, SelectInput, TextArea } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { Card, PageHeader } from '../../components/PageHeader';
import { Tag } from '../../components/Tag';
import { useToast } from '../../components/Toast';
import { usersApi } from '../../lib/api';
import { EMPTY, formatDateTime, formatMoney } from '../../lib/format';
import { EDITABLE_ROLES, roleText, userStatus, userStatusOptions } from '../../lib/status';
import type { AdminUserDetail } from '../../lib/types';
import { toSdkError, useAsync } from '../../lib/useAsync';
import { useForm } from '../../lib/useForm';

/** 详情字段（抽出来是为了让页面函数本体留在 50 行以内） */
function buildItems(d: AdminUserDetail): DescItem[] {
  const status = userStatus(d.status);
  return [
    { label: '昵称', value: d.nickname ?? EMPTY },
    { label: '真实姓名', value: d.realName ?? <span className="qz-dim">未填写</span> },
    { label: '手机号', value: d.phone ?? EMPTY },
    {
      label: '账号状态',
      value: <Tag tone={status.tone}>{status.text}</Tag>,
    },
    {
      label: '角色',
      value: d.roles.length ? d.roles.map((r) => roleText(r)).join('、') : EMPTY,
    },
    { label: '信用分', value: String(d.creditScore) },
    { label: '积分', value: String(d.points) },
    { label: '余额', value: formatMoney(d.balance) },
    { label: '学院', value: d.college ?? EMPTY },
    { label: '年级', value: d.grade ?? EMPTY },
    {
      label: '已通过认证',
      value: d.verified.length ? d.verified.join('、') : <span className="qz-dim">无</span>,
    },
    {
      label: '待审认证',
      value:
        d.pendingVerifications > 0 ? (
          <Tag tone="warning">{d.pendingVerifications} 条待审</Tag>
        ) : (
          '0'
        ),
    },
    { label: '订单数', value: String(d.orderCount) },
    { label: '作业数', value: String(d.jobCount) },
    { label: '最近登录', value: formatDateTime(d.lastLogin) },
    { label: '注册时间', value: formatDateTime(d.createdAt) },
  ];
}

/** 用户详情 + 编辑（状态 / 角色 / 原因） */
export function UserDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const state = useAsync(() => usersApi.detail(id), [id]);
  const d = state.data;

  return (
    <>
      <PageHeader
        title={d ? (d.nickname ?? '用户详情') : '用户详情'}
        desc={
          <span className="qz-mono">
            用户 ID：{id}
            {d?.adminAccountId ? ' · 该用户同时是后台管理员' : ''}
          </span>
        }
        actions={
          <>
            <button className="qz-btn" onClick={() => navigate('/users')}>
              返回列表
            </button>
            {d?.adminAccountId ? (
              <Link className="qz-btn" to={`/admins/${d.adminAccountId}`}>
                查看管理员账号
              </Link>
            ) : null}
            <Button variant="primary" onClick={() => setEditing(true)} disabled={!d}>
              编辑
            </Button>
          </>
        }
      />

      <AsyncBoundary loading={state.loading} error={state.error} onRetry={state.reload}>
        {d ? (
          <Card title="基本资料">
            <DescList items={buildItems(d)} />
          </Card>
        ) : null}
      </AsyncBoundary>

      {d ? (
        <UserEditModal
          open={editing}
          detail={d}
          onClose={() => setEditing(false)}
          onSaved={() => {
            state.reload();
            toast.success('用户已更新');
          }}
        />
      ) : null}
    </>
  );
}

/**
 * 编辑弹窗。
 *
 * 直接复用后端的 `AdminUserUpdateSchema`：角色集合是**全量覆盖**
 * （后端如此设计 —— 增量在并发下会丢更新）。因此表单里勾选后提交的是
 * 完整集合，而不是"新增/删除的差量"。
 *
 * `admin` 角色刻意不在可勾选项里：管理员身份要经 `admin_account` 表，
 * 在这里勾一个 `admin` 只会得到一个"有角色标记但没有后台账号"的四不像。
 */
function UserEditModal({
  open,
  detail,
  onClose,
  onSaved,
}: {
  open: boolean;
  detail: AdminUserDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [roles, setRoles] = useState<string[]>(detail.roles);
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<AdminUserUpdateDto>({
    initial: {
      // 接口返回的 status 是 string，不能直接当可提交值用：
      // 万一库里出现了状态集之外的值，这里**回落到 active 是危险的**
      // （等于把"未知状态"显示成"正常"），所以下方 hint 里会显式提示异常。
      status: isAdminUserStatus(detail.status) ? detail.status : 'active',
      roles: detail.roles,
      reason: '',
    },
    schema: AdminUserUpdateSchema,
    onSubmit: async (values) => {
      setServerError(null);
      try {
        await usersApi.update(detail.id, { ...values, roles });
        onSaved();
        onClose();
      } catch (err) {
        setServerError(toSdkError(err).message);
      }
    },
  });

  return (
    <Modal
      open={open}
      title="编辑用户"
      onClose={onClose}
      footer={
        <>
          <button className="qz-btn" onClick={onClose}>
            取消
          </button>
          <Button variant="primary" loading={form.submitting} onClick={() => void form.submit()}>
            保存
          </Button>
        </>
      }
    >
      <div className="qz-col">
        <Field label="账号状态" error={form.errors.status}>
          <SelectInput
            value={form.values.status ?? 'active'}
            onChange={(v) => form.setField('status', v)}
            options={userStatusOptions()}
          />
        </Field>

        <Field label="角色" hint="提交时为全量覆盖，未勾选的会被移除">
          <div className="qz-col" style={{ gap: 'var(--sp-2)' }}>
            {EDITABLE_ROLES.map((role) => (
              <label key={role} className="qz-checkbox">
                <input
                  type="checkbox"
                  checked={roles.includes(role)}
                  onChange={() =>
                    setRoles((prev) =>
                      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
                    )
                  }
                />
                <span>{roleText(role)}</span>
              </label>
            ))}
          </div>
        </Field>

        <Field
          label="变更原因（写入操作日志）"
          required={form.values.status !== detail.status}
          error={form.errors.reason}
        >
          <TextArea
            value={form.values.reason ?? ''}
            onChange={(v) => form.setField('reason', v)}
            rows={3}
            placeholder="如：申诉通过 / 违规处理"
          />
        </Field>

        {serverError ? <div className="qz-alert qz-alert--error">{serverError}</div> : null}
      </div>
    </Modal>
  );
}
