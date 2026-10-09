import { useState } from 'react';
import {
  ADMIN_ROLE_DESCRIPTIONS,
  ADMIN_ROLE_LABELS,
  ADMIN_ROLES,
  AdminAccountCreateSchema,
  AdminAccountUpdateSchema,
  AdminResetPasswordSchema,
  type AdminAccountCreateDto,
  type AdminAccountUpdateDto,
  type AdminResetPasswordDto,
  type AdminRole,
} from '@qz/core';

import { Button } from '../../components/Button';
import { Field, SelectInput, TextInput } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { adminsApi } from '../../lib/api';
import { toSdkError } from '../../lib/useAsync';
import { useForm } from '../../lib/useForm';
import type { AdminAccountItem } from '../../lib/types';

/** 角色下拉选项（文案取自 `@qz/core`，两侧同一份，不会出现角色名对不上） */
const ROLE_OPTIONS = ADMIN_ROLES.map((role) => ({ value: role, label: ADMIN_ROLE_LABELS[role] }));

/**
 * 新建管理员。
 *
 * 不接 `open` 属性、由调用方**条件渲染**（`{open && <AdminCreateModal/>}`）：
 * 表单的初始值只在内层 `useForm` 首次挂载时生效，保持挂载会让"上次填了一半
 * 的内容"残留到下一次打开，表现为"新建时输入框里已经有别人的密码"。
 * 卸载重挂是唯一不会错的解法。
 */
export function AdminCreateModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<AdminAccountCreateDto>({
    initial: { username: '', password: '', displayName: '', adminRole: ADMIN_ROLES[1] },
    schema: AdminAccountCreateSchema,
    onSubmit: async (values) => {
      setServerError(null);
      try {
        await adminsApi.create(values);
        toast.success('管理员已创建', `用户名：${values.username}`);
        onDone();
        onClose();
      } catch (err) {
        setServerError(toSdkError(err).message);
      }
    },
  });

  const role = form.values.adminRole as AdminRole;

  return (
    <Modal
      open
      title="新建管理员"
      onClose={onClose}
      footer={
        <>
          <button className="qz-btn" onClick={onClose}>
            取消
          </button>
          <Button variant="primary" loading={form.submitting} onClick={() => void form.submit()}>
            创建
          </Button>
        </>
      }
    >
      <div className="qz-col">
        <Field label="用户名" required error={form.errors.username} hint="登录凭据，创建后不可修改">
          <TextInput
            value={form.values.username}
            onChange={(v) => form.setField('username', v)}
            placeholder="3-32 位字母、数字、下划线或短横线"
          />
        </Field>

        <Field label="初始密码" required error={form.errors.password} hint="至少 8 位">
          <TextInput
            type="password"
            value={form.values.password}
            onChange={(v) => form.setField('password', v)}
            placeholder="由你转告本人，首次登录后建议修改"
          />
        </Field>

        <Field label="显示名" required error={form.errors.displayName}>
          <TextInput
            value={form.values.displayName}
            onChange={(v) => form.setField('displayName', v)}
            placeholder="界面上显示的名字"
          />
        </Field>

        <Field label="角色" required hint={ADMIN_ROLE_DESCRIPTIONS[role]}>
          <SelectInput
            value={role}
            onChange={(v) => form.setField('adminRole', v)}
            options={ROLE_OPTIONS}
          />
        </Field>

        {serverError ? <div className="qz-alert qz-alert--error">{serverError}</div> : null}
      </div>
    </Modal>
  );
}

/**
 * 编辑管理员（用户名不可改）。
 *
 * 关闭时**直接返回 null** 而不是渲染一个 `open={false}` 的空 Modal：
 * 表单的初始值来自 `target`，若保持挂载，切换目标时 `useState` 的初始值
 * 不会重算（React 只在首次挂载时用 initial），会出现"点 B 却显示 A 的资料"。
 * 卸载重挂是最省心且不会错的解法。
 */
export function AdminEditModal({
  target,
  onClose,
  onDone,
}: {
  target: AdminAccountItem | null;
  onClose: () => void;
  onDone: () => void;
}) {
  if (!target) return null;
  return <EditForm target={target} onClose={onClose} onDone={onDone} />;
}

function EditForm({
  target,
  onClose,
  onDone,
}: {
  target: AdminAccountItem;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<AdminAccountUpdateDto>({
    initial: {
      displayName: target.displayName,
      adminRole: target.adminRole,
      status: target.status === 'disabled' ? 'disabled' : 'active',
    },
    schema: AdminAccountUpdateSchema,
    onSubmit: async (values) => {
      setServerError(null);
      try {
        await adminsApi.update(target.id, values);
        toast.success('已保存');
        onDone();
        onClose();
      } catch (err) {
        setServerError(toSdkError(err).message);
      }
    },
  });

  const role = form.values.adminRole ?? target.adminRole;

  return (
    <Modal
      open
      title={`编辑管理员 · ${target.username}`}
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
        <div className="qz-alert qz-alert--info">
          用户名是登录凭据的一半，<strong>不可修改</strong> —— 改了等于换账号，
          而审计日志里记的仍是旧名字，追溯时"这个人"就对不上了。 确实要换，请禁用旧账号并新建一个。
        </div>

        <Field label="显示名" required error={form.errors.displayName}>
          <TextInput
            value={form.values.displayName ?? ''}
            onChange={(v) => form.setField('displayName', v)}
          />
        </Field>

        <Field label="角色" hint={ADMIN_ROLE_DESCRIPTIONS[role]}>
          <SelectInput
            value={role}
            onChange={(v) => form.setField('adminRole', v)}
            options={ROLE_OPTIONS}
          />
        </Field>

        <Field label="状态" hint="禁用后该账号立刻无法登录，无需等 token 过期">
          <SelectInput
            value={form.values.status ?? 'active'}
            onChange={(v) => form.setField('status', v)}
            options={[
              { value: 'active', label: '启用' },
              { value: 'disabled', label: '禁用' },
            ]}
          />
        </Field>

        {serverError ? <div className="qz-alert qz-alert--error">{serverError}</div> : null}
      </div>
    </Modal>
  );
}

/** 重置他人密码（同样由调用方条件渲染，理由见 `AdminCreateModal`） */
export function AdminResetPasswordModal({
  target,
  onClose,
  onDone,
}: {
  target: AdminAccountItem;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<AdminResetPasswordDto>({
    initial: { newPassword: '' },
    schema: AdminResetPasswordSchema,
    onSubmit: async (values) => {
      setServerError(null);
      try {
        await adminsApi.resetPassword(target.id, values.newPassword);
        toast.success('密码已重置', '请通过安全渠道告知本人');
        onDone();
        onClose();
      } catch (err) {
        setServerError(toSdkError(err).message);
      }
    },
  });

  return (
    <Modal
      open
      title={`重置密码 · ${target.username}`}
      onClose={onClose}
      footer={
        <>
          <button className="qz-btn" onClick={onClose}>
            取消
          </button>
          <Button variant="danger" loading={form.submitting} onClick={() => void form.submit()}>
            确认重置
          </Button>
        </>
      }
    >
      <div className="qz-col">
        <div className="qz-alert qz-alert--warning">
          重置后旧密码立即失效。<strong>本次操作会写入操作日志</strong>，
          请通过可信渠道把新密码交给本人，并提醒其尽快修改。
        </div>
        <Field label="新密码" required error={form.errors.newPassword} hint="至少 8 位">
          <TextInput
            type="password"
            value={form.values.newPassword}
            onChange={(v) => form.setField('newPassword', v)}
          />
        </Field>
        {serverError ? <div className="qz-alert qz-alert--error">{serverError}</div> : null}
      </div>
    </Modal>
  );
}
