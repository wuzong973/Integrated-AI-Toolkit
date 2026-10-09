import { Link } from 'react-router-dom';

import { AsyncBoundary } from '../components/AsyncBoundary';
import { Card, PageHeader } from '../components/PageHeader';
import { DataTable } from '../components/DataTable';
import { dashboardApi } from '../lib/api';
import { formatMoney } from '../lib/format';
import type { AdminDashboardStats, AdminGrowthPoint } from '../lib/types';
import { useAsync } from '../lib/useAsync';

function StatCard({ label, value, foot }: { label: string; value: string; foot?: string }) {
  return (
    <div className="qz-stat">
      <div className="qz-stat__label">{label}</div>
      <div className="qz-stat__value">{value}</div>
      {foot ? <div className="qz-stat__foot">{foot}</div> : null}
    </div>
  );
}

/**
 * 环比文案（对齐微信统计页的「指标 + 日环比 / 周环比 / 月环比」）。
 *
 * 后端 `rate` 是百分数（`50` 读作 +50%，保留 1 位小数）。
 * ⚠️ `rate === null` 表示**上一周期基数为 0，环比没有定义**：这里显示原始计数
 * 而不是百分比，绝不显示"涨 100%"那种编出来的数（红线 10）。
 * 老后端没返回 `growth` 时显示 `—`，不猜。
 */
function growthLabel(prefix: string, g?: AdminGrowthPoint): string {
  if (!g) return `${prefix} —`;
  // `null`（上期为 0）与字段缺失一律按"环比没有定义"渲染，不现编百分比
  if (typeof g.rate !== 'number') {
    return g.current > 0 ? `${prefix} 不适用（上期 0 → 本期 ${g.current}）` : `${prefix} 持平`;
  }
  if (g.rate === 0) return `${prefix} 持平`;
  return `${prefix} ${g.rate > 0 ? '↑' : '↓'} ${Math.abs(g.rate)}%`;
}

/**
 * 待办提醒。
 *
 * 这是本页存在的主要理由：后台首页要回答的是**"现在有多少活要干"**。
 * 三项都链到对应的筛选视图，点一下就到"能干活的地方"，
 * 而不是让人自己回去翻菜单再选筛选条件。
 */
function TodoBanner({ todos }: { todos: AdminDashboardStats['todos'] }) {
  const items = [
    { label: '待审认证', count: todos.pendingVerifications, to: '/content?status=pending' },
    { label: '纠纷订单', count: todos.disputedOrders, to: '/orders?disputed=1' },
    { label: '今日失败作业', count: todos.failedJobsToday, to: '/jobs?status=failed' },
  ];
  const nothing = items.every((i) => i.count === 0);

  if (nothing) {
    return (
      <div className="qz-alert qz-alert--info">
        <span>✅</span>
        <div>当前没有待处理事项。下面这些数字是系统整体状态，不是待办。</div>
      </div>
    );
  }

  return (
    <div className="qz-stat-grid">
      {items.map((item) => (
        <Link key={item.label} to={item.to} style={{ color: 'inherit' }}>
          <div
            className="qz-stat"
            style={{ borderColor: item.count > 0 ? 'var(--warning-500)' : undefined }}
          >
            <div className="qz-stat__label">⏳ {item.label}</div>
            <div className="qz-stat__value" style={{ color: 'var(--warning-500)' }}>
              {item.count}
            </div>
            <div className="qz-stat__foot">点击查看 →</div>
          </div>
        </Link>
      ))}
    </div>
  );
}

/** 数据看板 */
export function DashboardPage() {
  const state = useAsync(() => dashboardApi.stats(), []);
  const d = state.data;

  return (
    <>
      <PageHeader
        title="数据看板"
        desc="平台整体状态与待办事项。金额均为人民币元，成交额只统计已完成订单；新增用户的环比按本地日切分，对比的是上一周期的同一时段。"
      />

      <AsyncBoundary loading={state.loading} error={state.error} onRetry={state.reload}>
        {d ? (
          <div className="qz-col" style={{ gap: 'var(--sp-5)' }}>
            <section>
              <div className="qz-section-title">待办</div>
              <TodoBanner todos={d.todos} />
            </section>

            <section>
              <div className="qz-section-title">用户</div>
              <div className="qz-stat-grid">
                <StatCard
                  label="用户总数"
                  value={String(d.users.total)}
                  foot={`今日新增 ${d.users.newToday} · ${growthLabel('日环比', d.users.growth?.day)}`}
                />
                <StatCard
                  label="近 7 天新增"
                  value={String(d.users.newWeek ?? 0)}
                  foot={growthLabel('周环比', d.users.growth?.week)}
                />
                <StatCard
                  label="近 30 天新增"
                  value={String(d.users.newMonth ?? 0)}
                  foot={growthLabel('月环比', d.users.growth?.month)}
                />
                <StatCard
                  label="状态正常"
                  value={String(d.users.active)}
                  foot="按账号状态统计，不是登录活跃"
                />
                <StatCard label="已封禁" value={String(d.users.banned)} />
              </div>
            </section>

            <section>
              <div className="qz-section-title">订单与资金</div>
              <div className="qz-stat-grid">
                <StatCard label="成交额（已完成）" value={formatMoney(d.orders.gmv)} />
                <StatCard
                  label="订单总数"
                  value={String(d.orders.total)}
                  foot={`进行中 ${d.orders.inProgress}`}
                />
                <StatCard label="已完成" value={String(d.orders.completed)} />
                <StatCard label="已退款" value={String(d.orders.refundedCount)} />
              </div>
            </section>

            <section>
              <div className="qz-section-title">AI 工具与作业</div>
              <div className="qz-stat-grid">
                <StatCard
                  label="工具"
                  value={String(d.tools.total)}
                  foot={`上线 ${d.tools.active} · 建设中 ${d.tools.planned}`}
                />
                <StatCard
                  label="作业总数"
                  value={String(d.jobs.total)}
                  foot={`今日 ${d.jobs.today}`}
                />
                <StatCard label="排队中" value={String(d.jobs.queued)} />
                <StatCard label="执行中" value={String(d.jobs.running)} />
                <StatCard
                  label="今日失败"
                  value={String(d.jobs.failedToday)}
                  foot={d.jobs.failedToday > 0 ? '需要关注' : undefined}
                />
              </div>
            </section>

            <Card
              title="近 7 天作业量 Top 工具"
              subtitle="用来识别「没人用」与「最该盯」的工具"
              flush
            >
              <DataTable
                rowKey={(row) => row.toolName}
                rows={d.topTools}
                columns={[
                  {
                    key: 'name',
                    title: '工具',
                    render: (r) => r.displayName,
                    cellClass: 'qz-cell--main',
                  },
                  {
                    key: 'key',
                    title: '标识',
                    render: (r) => <span className="qz-mono">{r.toolName}</span>,
                  },
                  {
                    key: 'jobs',
                    title: '作业数',
                    align: 'right',
                    render: (r) => r.jobs7d,
                  },
                ]}
              />
            </Card>
          </div>
        ) : null}
      </AsyncBoundary>
    </>
  );
}
