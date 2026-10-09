import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AdminPermission, AdminOrderResolveSchema, type AdminOrderResolveDto } from '@qz/core';

import { PermissionGate } from '../../auth/PermissionGate';
import { AsyncBoundary } from '../../components/AsyncBoundary';
import { Button } from '../../components/Button';
import { useConfirm } from '../../components/Confirm';
import { DescList } from '../../components/DescList';
import { Field, SelectInput, TextArea } from '../../components/Field';
import { JsonBlock } from '../../components/JsonBlock';
import { Modal } from '../../components/Modal';
import { Card, PageHeader } from '../../components/PageHeader';
import { Tag } from '../../components/Tag';
import { useToast } from '../../components/Toast';
import { ordersApi } from '../../lib/api';
import { EMPTY, formatDateTime, formatMoney, shorten } from '../../lib/format';
import { orderEventText, orderStatus } from '../../lib/status';
import type { AdminOrderDetail } from '../../lib/types';
import { toSdkError, useAsync } from '../../lib/useAsync';
import { useForm } from '../../lib/useForm';

/** 只有这两个状态允许裁决：钱已托管、还没结清 */
const SETTLEABLE_STATUSES = ['pending_acceptance', 'refund_requested'];

function isSettleable(status: string): boolean {
  return SETTLEABLE_STATUSES.includes(status);
}

function hasPayload(payload: unknown): boolean {
  return Boolean(payload) && Object.keys(payload as object).length > 0;
}

/**
 * 订单详情与纠纷裁决。
 *
 * ## ⚠️ 时间线里的操作人不是管理员
 *
 * 后端的两个资金动作（放款 / 退款）复用 `OrderPayService`，它们以**买家身份**
 * 被触发（校验 `order.buyerId === userId`），所以时间线里的 `operatorId`
 * 记的是买家。管理员的真实身份与理由落在 `audit_log`。
 *
 * 这一点必须写在界面上：不写，复盘纠纷时会一路追到买家头上，
 * 而真正拍板的人查不到 —— 那正好是"事后追责"最需要的那条信息。
 */
export function OrderDetailPage() {
  const { id = '' } = useParams();
  const state = useAsync(() => ordersApi.detail(id), [id]);
  const d = state.data;
  const [resolving, setResolving] = useState(false);

  return (
    <>
      <PageHeader
        title={d ? `订单 · ${d.orderNo}` : '订单详情'}
        desc={<span className="qz-mono">订单 ID：{id}</span>}
        actions={<HeaderActions order={d} onResolve={() => setResolving(true)} />}
      />

      <AsyncBoundary loading={state.loading} error={state.error} onRetry={state.reload}>
        {d ? <OrderBody order={d} /> : null}
      </AsyncBoundary>

      {resolving && d ? (
        <ResolveModal order={d} onClose={() => setResolving(false)} onDone={state.reload} />
      ) : null}
    </>
  );
}

function HeaderActions({
  order,
  onResolve,
}: {
  order: AdminOrderDetail | null;
  onResolve: () => void;
}) {
  const navigate = useNavigate();
  const settleable = order ? isSettleable(order.status) : false;

  return (
    <>
      <button className="qz-btn" onClick={() => navigate('/orders')}>
        返回列表
      </button>
      <PermissionGate permission={AdminPermission.OrderSettle}>
        <Button
          variant="primary"
          disabled={!settleable}
          title={settleable ? undefined : '当前状态不需要（或不允许）裁决'}
          onClick={onResolve}
        >
          裁决
        </Button>
      </PermissionGate>
    </>
  );
}

function OrderBody({ order }: { order: AdminOrderDetail }) {
  return (
    <div className="qz-col" style={{ gap: 'var(--sp-5)' }}>
      <OrderOverview order={order} />

      {order.refundReason ? (
        <div className="qz-alert qz-alert--warning">
          <div>
            <strong>买家退款原因：</strong>
            {order.refundReason}
          </div>
        </div>
      ) : null}

      <RequirementCard order={order} />
      <Timeline entries={order.timeline} />
    </div>
  );
}

function UserLink({ id, name }: { id: string; name: string | null }) {
  return <Link to={`/users/${id}`}>{name ?? shorten(id, 8, 4)}</Link>;
}

function OrderOverview({ order }: { order: AdminOrderDetail }) {
  const status = orderStatus(order.status);

  return (
    <Card title="订单信息">
      <DescList
        items={[
          { label: '状态', value: <Tag tone={status.tone}>{status.text}</Tag> },
          { label: '订单金额', value: <strong>{formatMoney(order.amount)}</strong> },
          { label: '平台服务费', value: formatMoney(order.platformFee) },
          { label: '服务者实收', value: formatMoney(order.providerIncome) },
          { label: '买家', value: <UserLink id={order.buyerId} name={order.buyerName} /> },
          { label: '服务者', value: <UserLink id={order.providerId} name={order.providerName} /> },
          { label: '关联任务', value: order.hasTask ? '是' : <span className="qz-dim">否</span> },
          { label: '修改次数', value: String(order.revisionCount) },
          { label: '下单时间', value: formatDateTime(order.createdAt) },
          { label: '支付时间', value: formatDateTime(order.paidAt) },
          { label: '支付截止', value: formatDateTime(order.payDeadline) },
          { label: '交付时间', value: formatDateTime(order.deliveredAt) },
          { label: '完成时间', value: formatDateTime(order.completedAt) },
          { label: '退款时间', value: formatDateTime(order.refundedAt) },
        ]}
      />
    </Card>
  );
}

function RequirementCard({ order }: { order: AdminOrderDetail }) {
  const files = order.deliveryFiles;

  return (
    <Card title="需求与交付">
      <DescList
        single
        items={[
          { label: '需求描述', value: order.requirement ?? EMPTY, span: true },
          { label: '交付说明', value: order.deliveryRemark ?? EMPTY, span: true },
          {
            label: `交付物（${files.length}）`,
            span: true,
            value: files.length ? (
              <ul className="qz-col" style={{ gap: 4 }}>
                {files.map((f) => (
                  <li key={f}>
                    <a href={f} target="_blank" rel="noreferrer" className="qz-mono">
                      {f}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="qz-dim">未交付任何文件</span>
            ),
          },
        ]}
      />
    </Card>
  );
}

function Timeline({ entries }: { entries: AdminOrderDetail['timeline'] }) {
  return (
    <Card
      title={`订单时间线（${entries.length}）`}
      subtitle="⚠️ 操作人记的是买家（资金动作由买家的身份触发），裁决人请以操作日志为准"
    >
      {entries.length ? (
        <div className="qz-timeline">
          {entries.map((entry, idx) => (
            <TimelineItem key={`${entry.event}-${entry.createdAt}-${idx}`} entry={entry} />
          ))}
        </div>
      ) : (
        <div className="qz-dim">没有时间线记录</div>
      )}
    </Card>
  );
}

function TimelineItem({ entry }: { entry: AdminOrderDetail['timeline'][number] }) {
  return (
    <div
      className={
        entry.event === 'refunded' ? 'qz-timeline__item is-danger' : 'qz-timeline__item is-done'
      }
    >
      <span className="qz-timeline__dot" />
      <div className="qz-timeline__title">{orderEventText(entry.event)}</div>
      <div className="qz-timeline__time">
        {formatDateTime(entry.createdAt)}
        {entry.operatorId ? (
          <span className="qz-mono"> · {shorten(entry.operatorId, 8, 4)}</span>
        ) : null}
      </div>
      {hasPayload(entry.payload) ? (
        <div className="qz-mt-2">
          <JsonBlock value={entry.payload} maxHeight={120} />
        </div>
      ) : null}
    </div>
  );
}

/** 裁决（放款 / 退款）—— 两者都必须填理由 */
function ResolveModal({
  order,
  onClose,
  onDone,
}: {
  order: AdminOrderDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<AdminOrderResolveDto>({
    initial: { action: 'release', reason: '' },
    schema: AdminOrderResolveSchema,
    onSubmit: async (values) => {
      // 二次确认：这是真正动钱的动作，理由写完了还要再确认一次
      const ok = await confirm({
        title: values.action === 'release' ? '放款给服务者' : '退款给买家',
        text:
          values.action === 'release'
            ? `将从担保账户把 ${formatMoney(order.providerIncome)} 结算给服务者「${order.providerName ?? order.providerId}」。该操作不可撤销。`
            : `将把 ${formatMoney(order.amount)} 退回买家「${order.buyerName ?? order.buyerId}」。该操作不可撤销。`,
        confirmText: values.action === 'release' ? '确认放款' : '确认退款',
        danger: values.action === 'refund',
      });
      if (!ok) return;

      setServerError(null);
      try {
        await ordersApi.resolve(order.id, values);
        toast.success('裁决完成', values.reason);
        onDone();
        onClose();
      } catch (err) {
        // 状态不匹配等错误由后端状态机裁定（40904），原样展示
        setServerError(toSdkError(err).message);
      }
    },
  });

  return (
    <Modal
      open
      title={`裁决 · ${order.orderNo}`}
      onClose={onClose}
      footer={
        <>
          <button className="qz-btn" onClick={onClose}>
            取消
          </button>
          <Button
            variant={form.values.action === 'release' ? 'primary' : 'danger'}
            loading={form.submitting}
            onClick={() => void form.submit()}
          >
            {form.values.action === 'release' ? '确认放款' : '确认退款'}
          </Button>
        </>
      }
    >
      <div className="qz-col">
        <div className="qz-alert qz-alert--warning">
          裁决会<strong>真正动钱</strong>。适用状态由后端状态机兜底 ——
          对不适用当前状态的动作，接口会直接拒绝（而不是悄悄执行）。
        </div>

        <Field label="裁决动作" required error={form.errors.action}>
          <SelectInput
            value={form.values.action}
            onChange={(v) => form.setField('action', v)}
            options={[
              { value: 'release', label: `放款给服务者（${formatMoney(order.providerIncome)}）` },
              { value: 'refund', label: `退款给买家（${formatMoney(order.amount)}）` },
            ]}
          />
        </Field>

        <Field
          label="裁决理由"
          required
          error={form.errors.reason}
          hint="至少 4 个字。这是纠纷复盘时唯一的依据，也会写入操作日志。"
        >
          <TextArea
            value={form.values.reason}
            onChange={(v) => form.setField('reason', v)}
            rows={4}
            placeholder="如：交付物完整且符合需求，买家无正当理由拒绝验收"
          />
        </Field>

        {serverError ? <div className="qz-alert qz-alert--error">{serverError}</div> : null}
      </div>
    </Modal>
  );
}
