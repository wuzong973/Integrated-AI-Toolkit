import { useState } from 'react';
import { ReviewVerificationSchema, type ReviewVerificationDto } from '@qz/core';

import { Button } from '../../components/Button';
import { Field, TextArea } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { contentApi } from '../../lib/api';
import { EMPTY } from '../../lib/format';
import type { AdminVerificationItem } from '../../lib/types';
import { toSdkError } from '../../lib/useAsync';
import { useForm } from '../../lib/useForm';

/**
 * 审核动作的两个弹窗（从 ReviewQueuePage 拆出）。
 *
 * 拆分的直接原因是单文件 300 行红线，但更实际的理由是：
 * 列表页已经要处理页签、筛选、分页、表格与三种行内状态，
 * 再把两个弹窗的表单塞进去，读一遍要跨过 300 行无关上下文。
 */

/** 拒绝（必须写明原因 —— 后端 schema 也强制 ≥4 字） */
export function RejectModal({
  target,
  onClose,
  onDone,
}: {
  target: AdminVerificationItem;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<ReviewVerificationDto>({
    initial: { approved: false, reason: '' },
    schema: ReviewVerificationSchema,
    onSubmit: async (values) => {
      setServerError(null);
      try {
        await contentApi.review(target.id, false, values.reason);
        toast.success('已拒绝', '原因已随驳回通知发送');
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
      title={`拒绝认证 · ${target.nickname ?? target.userId}`}
      onClose={onClose}
      footer={
        <>
          <button className="qz-btn" onClick={onClose}>
            取消
          </button>
          <Button variant="danger" loading={form.submitting} onClick={() => void form.submit()}>
            确认拒绝
          </Button>
        </>
      }
    >
      <div className="qz-col">
        <div className="qz-alert qz-alert--warning">
          驳回原因会展示给申请人。写清"缺什么、怎么补"，否则他只会反复提交同一份材料。
        </div>
        <Field label="驳回原因" required error={form.errors.reason} hint="至少 4 个字，最多 300 字">
          <TextArea
            value={form.values.reason ?? ''}
            onChange={(v) => form.setField('reason', v)}
            rows={4}
            placeholder="如：学生证照片模糊，请重新上传清晰的学生证内页"
          />
        </Field>
        {serverError ? <div className="qz-alert qz-alert--error">{serverError}</div> : null}
      </div>
    </Modal>
  );
}

/** 查看提交的材料（只读） */
export function MaterialsModal({
  target,
  onClose,
}: {
  target: AdminVerificationItem | null;
  onClose: () => void;
}) {
  if (!target) return null;
  return (
    <Modal open title={`申请材料 · ${target.typeLabel}`} onClose={onClose}>
      <div className="qz-col" style={{ gap: 'var(--sp-4)' }}>
        <div>
          <div className="qz-desc__label">申请人</div>
          <div className="qz-desc__value">
            {target.nickname ?? '—'} · {target.phone ?? '未绑定手机号'}
          </div>
        </div>
        <div>
          <div className="qz-desc__label">真实姓名</div>
          <div className="qz-desc__value">{target.realName ?? EMPTY}</div>
        </div>
        <div>
          <div className="qz-desc__label">学院 / 学校</div>
          <div className="qz-desc__value">
            {target.college ?? EMPTY} · {target.schoolName ?? EMPTY}
          </div>
        </div>
        {target.rejectReason ? (
          <div className="qz-alert qz-alert--error">已驳回原因：{target.rejectReason}</div>
        ) : null}
        <div>
          <div className="qz-desc__label">材料（{target.materials.length} 项）</div>
          {target.materials.length ? (
            <ul className="qz-col" style={{ gap: 4, marginTop: 4 }}>
              {target.materials.map((m) => (
                <li key={m}>
                  {/* 材料可能是对象存储 URL，也可能是纯文本描述 */}
                  {/^https?:\/\//.test(m) ? (
                    <a href={m} target="_blank" rel="noreferrer">
                      {m}
                    </a>
                  ) : (
                    <span className="qz-mono">{m}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="qz-dim">未提交材料</div>
          )}
        </div>
      </div>
    </Modal>
  );
}
