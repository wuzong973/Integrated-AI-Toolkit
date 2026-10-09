import { useState } from 'react';
import { AdminChangePasswordSchema, type AdminChangePasswordDto } from '@qz/core';

import { useAuth } from '../auth/useAuth';
import { Button } from '../components/Button';
import { DescList } from '../components/DescList';
import { Field, TextInput } from '../components/Field';
import { Card, PageHeader } from '../components/PageHeader';
import { Tag } from '../components/Tag';
import { useToast } from '../components/Toast';
import { adminsApi } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { toSdkError } from '../lib/useAsync';
import { useForm } from '../lib/useForm';

/**
 * 我的账号。
 *
 * ## 为什么单独给一个页面，而不是塞在顶栏下拉里
 *
 * 这一页承担一件必须讲清楚的事：**当前账号的实际权限**。
 * 管理员被降权后（后端立刻生效），界面菜单会跟着消失，但人往往先困惑
 * "怎么少了几个菜单"。把权限清单与角色说明摊在这一页，困惑能自助解决。
 *
 * ## 改密码必须验旧密码
 *
 * 后端 `changeOwnPassword` 校验旧密码。前端不额外"聪明"地去跳过它 ——
 * 只验新密码两次一致是不够的：共享电脑上有人趁你离开改掉密码，
 * 就永久拿走了账号。
 */
export function AccountPage() {
  const { profile } = useAuth();

  return (
    <>
      <PageHeader title="我的账号" desc="当前登录的管理员身份、权限与密码。" />

      <div className="qz-col" style={{ gap: 'var(--sp-5)' }}>
        <Card title="身份信息">
          <DescList
            items={[
              { label: '显示名', value: profile?.displayName ?? '—' },
              {
                label: '用户名',
                value: <span className="qz-mono">{profile?.username ?? '—'}</span>,
              },
              { label: '角色', value: <Tag tone="brand">{profile?.adminRoleLabel ?? '—'}</Tag> },
              {
                label: '状态',
                value: profile?.status === 'active' ? '启用' : (profile?.status ?? '—'),
              },
              { label: '最近登录', value: formatDateTime(profile?.lastLoginAt) },
              {
                label: '权限点',
                value: `${profile?.permissions.length ?? 0} 项`,
              },
            ]}
          />
        </Card>

        <Card title="我的权限" subtitle="来自后端裁定；菜单与按钮均据此渲染">
          {profile?.permissions.length ? (
            <div className="qz-row qz-wrap">
              {profile.permissions.map((p) => (
                <span key={p} className="qz-tag qz-tag--success" title={p}>
                  {p}
                </span>
              ))}
            </div>
          ) : (
            <div className="qz-dim">没有任何权限点</div>
          )}
        </Card>

        <ChangePasswordCard />
      </div>
    </>
  );
}

function ChangePasswordCard() {
  const toast = useToast();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<AdminChangePasswordDto>({
    initial: { oldPassword: '', newPassword: '' },
    schema: AdminChangePasswordSchema,
    onSubmit: async (values) => {
      setServerError(null);
      try {
        await adminsApi.changeOwnPassword(values.oldPassword, values.newPassword);
        toast.success('密码已修改', '下次登录请使用新密码');
        form.reset({ oldPassword: '', newPassword: '' });
      } catch (err) {
        setServerError(toSdkError(err).message);
      }
    },
  });

  return (
    <Card title="修改密码" subtitle="必须提供当前密码">
      <div style={{ maxWidth: 380 }} className="qz-col">
        <Field label="当前密码" required error={form.errors.oldPassword}>
          <TextInput
            type="password"
            value={form.values.oldPassword}
            onChange={(v) => form.setField('oldPassword', v)}
          />
        </Field>
        <Field label="新密码" required error={form.errors.newPassword} hint="至少 8 位">
          <TextInput
            type="password"
            value={form.values.newPassword}
            onChange={(v) => form.setField('newPassword', v)}
          />
        </Field>

        {serverError ? <div className="qz-alert qz-alert--error">{serverError}</div> : null}

        <div>
          <Button variant="primary" loading={form.submitting} onClick={() => void form.submit()}>
            修改密码
          </Button>
        </div>
      </div>
    </Card>
  );
}
