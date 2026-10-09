import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AdminLoginSchema, type AdminLoginDto } from '@qz/core';

import { useAuth } from '../auth/useAuth';
import { Button } from '../components/Button';
import { Field, TextInput } from '../components/Field';
import { toSdkError } from '../lib/useAsync';
import { useForm } from '../lib/useForm';

interface RedirectState {
  from?: string;
}

/**
 * 后台登录。
 *
 * ## 为什么是账号密码，不是微信扫码
 *
 * 微信开放平台的「网站应用」扫码登录需要**企业资质**，当前跑不通。
 * 后台是 PC 场景，账号密码本来就是标准形态，且签发复用 `TokenService.issue`，
 * 因此 401 自动刷新、`@Roles(Role.Admin)` 等链路全部沿用，没有第二套鉴权。
 *
 * ## 错误文案刻意统一为"用户名或密码错误"
 *
 * 后端对"用户不存在"和"密码错误"返回同一句话（并做了等时处理，防用户名枚举）。
 * **前端不能自作聪明地细化** —— 比如把"用户不存在"单独提示出来，
 * 那等于把这个接口重新变回一个用户名枚举器。
 */
export function LoginPage() {
  const { login, profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [serverError, setServerError] = useState<string | null>(null);

  const from = (location.state as RedirectState | null)?.from ?? '/dashboard';

  const form = useForm<AdminLoginDto>({
    initial: { username: '', password: '' },
    schema: AdminLoginSchema,
    onSubmit: async (values) => {
      setServerError(null);
      try {
        await login(values.username, values.password);
        navigate(from, { replace: true });
      } catch (err) {
        // 登录失败不弹 Toast：错误信息要留在表单里，用户才能对着改
        setServerError(toSdkError(err).message);
      }
    },
  });

  // 已登录时直接送回目标页（避免手动敲 /login 看到登录表单）。
  // 用 <Navigate> 而不是在渲染里调 navigate()：渲染期间产生副作用会在
  // 严格模式下被调用两次，且 React 会给出警告。
  if (profile) return <Navigate to={from} replace />;

  return (
    <div className="qz-login">
      <form
        className="qz-login__card"
        onSubmit={(e) => {
          e.preventDefault();
          void form.submit();
        }}
      >
        <div className="qz-login__brand">
          <div className="qz-sidebar__logo">青智</div>
          <h1>管理后台</h1>
        </div>

        <div className="qz-col">
          <Field label="用户名" required error={form.errors.username}>
            <TextInput
              value={form.values.username}
              onChange={(v) => form.setField('username', v)}
              placeholder="请输入管理员用户名"
              autoFocus
            />
          </Field>

          <Field label="密码" required error={form.errors.password}>
            <TextInput
              type="password"
              value={form.values.password}
              onChange={(v) => form.setField('password', v)}
              placeholder="请输入密码"
            />
          </Field>
        </div>

        {serverError ? <div className="qz-alert qz-alert--error qz-mt-4">{serverError}</div> : null}

        <div className="qz-mt-6">
          <Button type="submit" variant="primary" block loading={form.submitting}>
            登录
          </Button>
        </div>

        <div className="qz-login__hint">
          <div>账号被禁用或密码遗忘，请联系超级管理员处理。</div>
          <div>登录凭证只在当前标签页有效，关闭浏览器后需重新登录。</div>
        </div>
      </form>
    </div>
  );
}
