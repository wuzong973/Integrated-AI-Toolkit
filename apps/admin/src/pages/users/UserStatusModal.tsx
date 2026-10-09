import { useState } from 'react';
import { z } from 'zod';

import { Button } from '../../components/Button';
import { Field, TextArea } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { usersApi } from '../../lib/api';
import { toSdkError } from '../../lib/useAsync';
import { useForm } from '../../lib/useForm';
import type { AdminUserItem } from '../../lib/types';

/**
 * 封禁 / 解封（列表页的快捷动作）。
 *
 * ## 为什么必须填原因
 *
 * 封禁**立刻生效** —— `auth.service` 在登录与 `/auth/me` 都会校验 `User.status`，
 * 被禁用户下一次请求就进不来，不必等 token 过期。也就是说这是"影响真人、
 * 没有记录就说不清"的操作，原因是写进 `audit_log` 的唯一凭据，
 * 申诉复核全靠它。
 */
const ReasonSchema = z.object({
  reason: z.string().min(2, '请填写原因（至少 2 个字）').max(200),
});

interface Props {
  /**
   * 目标用户。
   *
   * 由调用方**条件渲染**（`{target && <UserStatusModal/>}`）而不是用
   * `open` 切换：表单初值只在内层 `useForm` 首次挂载时生效，保持挂载会让
   * 上一个用户填过的原因残留在下一个用户的弹窗里。
   */
  target: Pick<AdminUserItem, 'id' | 'nickname' | 'status'>;
  onClose: () => void;
  /** 成功后由调用方刷新列表 */
  onDone: () => void;
}

export function UserStatusModal({ target, onClose, onDone }: Props) {
  const toast = useToast();
  const [serverError, setServerError] = useState<string | null>(null);
  const willBan = target.status === 'active';

  const form = useForm<{ reason: string }>({
    initial: { reason: '' },
    schema: ReasonSchema,
    onSubmit: async (values) => {
      setServerError(null);
      try {
        await usersApi.update(target.id, {
          status: willBan ? 'banned' : 'active',
          reason: values.reason,
        });
        toast.success(willBan ? '已封禁' : '已解封', `${target.nickname ?? target.id} 状态已更新`);
        onDone();
        onClose();
      } catch (err) {
        // 服务端错误留在弹窗里（关掉弹窗会让用户以为已经成功了）
        setServerError(toSdkError(err).message);
      }
    },
  });

  return (
    <Modal
      open
      title={willBan ? '封禁用户' : '解除封禁'}
      onClose={onClose}
      footer={
        <>
          <button className="qz-btn" onClick={onClose}>
            取消
          </button>
          <Button
            variant={willBan ? 'danger' : 'primary'}
            loading={form.submitting}
            onClick={() => void form.submit()}
          >
            {willBan ? '确认封禁' : '确认解封'}
          </Button>
        </>
      }
    >
      <div className="qz-col">
        <div className="qz-alert qz-alert--warning">
          {willBan
            ? '封禁后该用户无法登录，也无法调用任何需要登录的接口（立即生效，不等 token 过期）。'
            : '解封后该用户可立即恢复登录与使用。'}
        </div>

        <Field label="原因（写入操作日志）" required error={form.errors.reason}>
          <TextArea
            value={form.values.reason}
            onChange={(v) => form.setField('reason', v)}
            rows={3}
            placeholder={willBan ? '如：多次发布违规内容 / 恶意刷单' : '如：申诉通过，证据不足'}
          />
        </Field>

        {serverError ? <div className="qz-alert qz-alert--error">{serverError}</div> : null}
      </div>
    </Modal>
  );
}
