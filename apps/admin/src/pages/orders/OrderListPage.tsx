import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { AsyncBoundary } from '../../components/AsyncBoundary';
import { DataTable } from '../../components/DataTable';
import { Card, PageHeader } from '../../components/PageHeader';
import { Pagination } from '../../components/Pagination';
import { Tag } from '../../components/Tag';
import { SearchInput, SelectFilter, Tabs, Toolbar } from '../../components/Toolbar';
import { ordersApi } from '../../lib/api';
import { formatDateTime, formatMoney, shorten } from '../../lib/format';
import { orderStatus, orderStatusOptions } from '../../lib/status';
import type { AdminOrderItem } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';

const SIZE = 20;

/**
 * 订单与纠纷。
 *
 * ## 两个视图，而不是一个视图加一个复选框
 *
 * "纠纷"页签不是普通筛选：它对应一条独立的处置流程（裁决放款/退款），
 * 且是一条**需要人跟进**的队列。做成页签后，运营每天上班点一下就知道
 * 有没有活要干；做成筛选条件里的一个勾选框，它会被埋没。
 *
 * ## 金额一律以「分」存储，只在这一层转元
 */
export function OrderListPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const disputed = params.get('disputed') === '1';

  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [page, setPage] = useState(1);

  const state = useAsync(
    () => ordersApi.list({ keyword, status, disputed, page, size: SIZE }),
    [keyword, status, disputed, page],
  );

  const rows = state.data?.list ?? [];
  const total = state.data?.total ?? 0;

  return (
    <>
      <PageHeader
        title="订单与纠纷"
        desc="担保交易的订单全貌。裁决（放款/退款）会真正动钱，且必须填写理由。"
        actions={
          <button className="qz-btn" onClick={state.reload} disabled={state.loading}>
            刷新
          </button>
        }
      />

      <Card flush>
        <Tabs
          value={disputed ? 'disputed' : 'all'}
          items={[
            { value: 'all', label: '全部订单' },
            { value: 'disputed', label: '纠纷 / 退款' },
          ]}
          onChange={(v) => {
            const next = new URLSearchParams();
            if (v === 'disputed') next.set('disputed', '1');
            setParams(next);
            setStatus('');
            setPage(1);
          }}
        />

        <Toolbar
          filters={
            <>
              <SearchInput
                value={keyword}
                onChange={(v) => {
                  setKeyword(v);
                  setPage(1);
                }}
                placeholder="订单号 / 需求描述"
              />
              <SelectFilter
                ariaLabel="按状态筛选"
                value={status}
                options={orderStatusOptions()}
                onChange={(v) => {
                  setStatus(v);
                  setPage(1);
                }}
              />
            </>
          }
        />

        <AsyncBoundary
          loading={state.loading && state.data === null}
          error={state.error}
          isEmpty={rows.length === 0}
          emptyTitle={disputed ? '没有需要裁决的订单' : '没有订单'}
          emptyDesc={
            disputed
              ? '当前没有处于退款中或带退款原因的订单。'
              : '订单由用户在小程序里下单产生，目前还没有数据。'
          }
          onRetry={state.reload}
        >
          <DataTable<AdminOrderItem>
            rowKey={(r) => r.id}
            rows={rows}
            onRowClick={(r) => navigate(`/orders/${r.id}`)}
            columns={[
              {
                key: 'no',
                title: '订单号',
                cellClass: 'qz-cell--main',
                render: (r) => (
                  <Link to={`/orders/${r.id}`} onClick={(e) => e.stopPropagation()}>
                    <span className="qz-mono">{r.orderNo}</span>
                  </Link>
                ),
              },
              {
                key: 'status',
                title: '状态',
                render: (r) => {
                  const s = orderStatus(r.status);
                  return (
                    <>
                      <Tag tone={s.tone}>{s.text}</Tag>
                      {r.refundReason ? (
                        <div className="qz-dim" style={{ marginTop: 4, maxWidth: 180 }}>
                          <span className="qz-clamp-2">{r.refundReason}</span>
                        </div>
                      ) : null}
                    </>
                  );
                },
              },
              {
                key: 'amount',
                title: '金额',
                align: 'right',
                render: (r) => <strong>{formatMoney(r.amount)}</strong>,
              },
              {
                key: 'fee',
                title: '平台服务费',
                align: 'right',
                render: (r) => formatMoney(r.platformFee),
              },
              {
                key: 'buyer',
                title: '买家',
                render: (r) => r.buyerName ?? shorten(r.buyerId, 6, 4),
              },
              {
                key: 'provider',
                title: '服务者',
                render: (r) => r.providerName ?? shorten(r.providerId, 6, 4),
              },
              {
                key: 'delivery',
                title: '交付',
                align: 'right',
                render: (r) =>
                  r.deliveredAt ? (
                    r.deliveryCount === 0 ? (
                      // 已交付但交付物为 0 —— 这是"交付了个空"，值得显式标出来
                      <Tag tone="warning">0 个产物</Tag>
                    ) : (
                      `${r.deliveryCount} 项`
                    )
                  ) : (
                    <span className="qz-dim">未交付</span>
                  ),
              },
              { key: 'createdAt', title: '下单时间', render: (r) => formatDateTime(r.createdAt) },
            ]}
          />
          <Pagination page={page} size={SIZE} total={total} onChange={setPage} />
        </AsyncBoundary>
      </Card>
    </>
  );
}
