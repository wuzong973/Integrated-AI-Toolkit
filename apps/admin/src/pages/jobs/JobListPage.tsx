import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { AsyncBoundary } from '../../components/AsyncBoundary';
import { DataTable } from '../../components/DataTable';
import { Card, PageHeader } from '../../components/PageHeader';
import { Pagination } from '../../components/Pagination';
import { ScoreBadge, Tag } from '../../components/Tag';
import { ProgressBar } from '../../components/JsonBlock';
import { SearchInput, SelectFilter, Toolbar } from '../../components/Toolbar';
import { jobsApi } from '../../lib/api';
import { formatDateTime, shorten } from '../../lib/format';
import { jobStatus, jobStatusOptions, qualityTone } from '../../lib/status';
import type { AdminJobItem } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';

const SIZE = 20;

/**
 * 作业监控。
 *
 * ## 为什么这一页值得存在
 *
 * 作业失败是**静默**的：用户看到"处理失败"就走了，而运营侧看不到失败率、
 * 也看不出"是不是某个工具最近全挂了"。把 `tool_job` 按工具与状态摊开，
 * "某个工具突然 100% 失败"就变成一眼可见的事实。
 *
 * ## 筛选条件从 URL 读取
 *
 * 看板的"今日失败作业"（`?status=failed`）与工具页的"看作业"
 * （`?toolName=xxx`）都直接落到正确的视图，不需要用户再手动选一遍。
 */
export function JobListPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const [keyword, setKeyword] = useState('');
  const [toolName, setToolName] = useState(params.get('toolName') ?? '');
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [userId, setUserId] = useState(params.get('userId') ?? '');
  const [page, setPage] = useState(1);

  const state = useAsync(
    () => jobsApi.list({ keyword, toolName, status, userId, page, size: SIZE }),
    [keyword, toolName, status, userId, page],
  );

  const rows = state.data?.list ?? [];
  const total = state.data?.total ?? 0;

  /** 改筛选时同步 URL，保证刷新/分享链接看到的是同一批结果 */
  const patchParams = (next: Record<string, string>) => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) merged.set(k, v);
      else merged.delete(k);
    }
    setParams(merged);
    setPage(1);
  };

  return (
    <>
      <PageHeader
        title="作业监控"
        desc="工具实际执行的每一次作业。失败率异常、产出质量差都在这里暴露。"
        actions={
          <button className="qz-btn" onClick={state.reload} disabled={state.loading}>
            刷新
          </button>
        }
      />

      <Card flush>
        <Toolbar
          filters={
            <>
              <SearchInput
                value={keyword}
                onChange={(v) => {
                  setKeyword(v);
                  setPage(1);
                }}
                placeholder="作业 ID / 用户昵称"
              />
              <input
                className="qz-input"
                style={{ minWidth: 160 }}
                value={toolName}
                placeholder="工具标识（如 generate_ppt）"
                onChange={(e) => {
                  setToolName(e.target.value);
                  patchParams({ toolName: e.target.value });
                }}
              />
              <SelectFilter
                ariaLabel="按状态筛选"
                value={status}
                options={jobStatusOptions()}
                onChange={(v) => {
                  setStatus(v);
                  patchParams({ status: v });
                }}
              />
              {toolName || status || userId ? (
                <button
                  className="qz-btn qz-btn--sm"
                  onClick={() => {
                    setKeyword('');
                    setToolName('');
                    setStatus('');
                    setUserId('');
                    setParams({});
                    setPage(1);
                  }}
                >
                  清空筛选
                </button>
              ) : null}
            </>
          }
        />

        <AsyncBoundary
          loading={state.loading && state.data === null}
          error={state.error}
          isEmpty={rows.length === 0}
          emptyTitle="没有匹配的作业"
          emptyDesc="作业是用户调用工具时产生的；没有数据通常意味着还没人用过这些工具。"
          onRetry={state.reload}
        >
          <DataTable<AdminJobItem>
            rowKey={(r) => r.id}
            rows={rows}
            onRowClick={(r) => navigate(`/jobs/${r.id}`)}
            columns={[
              {
                key: 'id',
                title: '作业',
                cellClass: 'qz-cell--id',
                render: (r) => (
                  <Link to={`/jobs/${r.id}`} onClick={(e) => e.stopPropagation()}>
                    <span className="qz-mono">{shorten(r.id, 10, 4)}</span>
                  </Link>
                ),
              },
              {
                key: 'tool',
                title: '工具',
                cellClass: 'qz-cell--main',
                render: (r) => <span className="qz-mono">{r.toolName}</span>,
              },
              {
                key: 'status',
                title: '状态',
                render: (r) => {
                  const s = jobStatus(r.status);
                  return (
                    <>
                      <Tag tone={s.tone}>{s.text}</Tag>
                      {r.status === 'running' ? (
                        <div style={{ marginTop: 4, width: 90 }}>
                          <ProgressBar value={r.progress} />
                        </div>
                      ) : null}
                    </>
                  );
                },
              },
              {
                key: 'quality',
                title: '质量分',
                align: 'right',
                render: (r) => (
                  <ScoreBadge score={r.qualityScore} tone={qualityTone(r.qualityScore)} />
                ),
              },
              { key: 'output', title: '产物', align: 'right', render: (r) => r.outputCount },
              {
                key: 'user',
                title: '用户',
                render: (r) => r.nickname ?? <span className="qz-dim">—</span>,
              },
              {
                key: 'error',
                title: '错误',
                render: (r) =>
                  r.error ? (
                    <span
                      className="qz-truncate"
                      style={{ display: 'inline-block', maxWidth: 200 }}
                      title={r.error}
                    >
                      {r.error}
                    </span>
                  ) : (
                    <span className="qz-dim">—</span>
                  ),
              },
              { key: 'createdAt', title: '创建时间', render: (r) => formatDateTime(r.createdAt) },
            ]}
          />
          <Pagination page={page} size={SIZE} total={total} onChange={setPage} />
        </AsyncBoundary>
      </Card>
    </>
  );
}
