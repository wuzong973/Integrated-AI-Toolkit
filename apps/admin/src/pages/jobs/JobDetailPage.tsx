import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AdminPermission } from '@qz/core';

import { PermissionGate } from '../../auth/PermissionGate';
import { AsyncBoundary } from '../../components/AsyncBoundary';
import { Button } from '../../components/Button';
import { useConfirm } from '../../components/Confirm';
import { DescList } from '../../components/DescList';
import { JsonBlock, ProgressBar } from '../../components/JsonBlock';
import { Card, PageHeader } from '../../components/PageHeader';
import { ScoreBadge, Tag } from '../../components/Tag';
import { useToast } from '../../components/Toast';
import { jobsApi } from '../../lib/api';
import { EMPTY, formatDateTime, formatDuration, formatMoney, shorten } from '../../lib/format';
import { jobStatus, qualityTone } from '../../lib/status';
import type { AdminJobDetail } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';

/** 已结束的状态（只有这些能重跑；取消相反，只对未结束的开放） */
const TERMINAL = ['succeeded', 'failed', 'canceled', 'rejected'];

/**
 * 作业详情 + 运维动作。
 *
 * ## 重跑的两条硬事实必须讲在按钮旁边
 *
 * ① **计费落在作业所属用户身上**：后端把 userId 换成作业的 owner 再调
 *    `JobRetryService.retry`，会重新预扣**他的**积分。管理员只是替他按了按钮。
 *    不讲清楚，运营会以为重跑免费，反复重跑把用户的积分刷光。
 * ② 重跑会**新建一个作业**（新 id），原作业保持不变。所以"重跑"之后
 *    这一页看到的状态不会变 —— 界面必须说明，否则会被当成"点了没反应"。
 */
export function JobDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const state = useAsync(() => jobsApi.detail(id), [id]);
  const d = state.data;

  return (
    <>
      <PageHeader
        title={d ? `作业 · ${d.toolName}` : '作业详情'}
        desc={<span className="qz-mono">作业 ID：{id}</span>}
        actions={
          <>
            <button className="qz-btn" onClick={() => navigate('/jobs')}>
              返回列表
            </button>
            {d ? <JobActions job={d} onDone={state.reload} /> : null}
          </>
        }
      />

      <AsyncBoundary loading={state.loading} error={state.error} onRetry={state.reload}>
        {d ? <JobOverview job={d} /> : null}
      </AsyncBoundary>
    </>
  );
}

/** 重跑 / 取消（含各自的二次确认） */
function JobActions({ job, onDone }: { job: AdminJobDetail; onDone: () => void }) {
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const terminated = TERMINAL.includes(job.status);

  const retry = async () => {
    const ok = await confirm({
      title: '重新执行这个作业',
      text: `将新建一个作业并把积分重新记在「${job.nickname ?? job.userId}」账上（不是免费的），原作业不受影响。`,
      confirmText: '确认重跑',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const created = await jobsApi.retry(job.id);
      toast.success('已重新排队', `新作业 ${shorten(created.id, 10, 4)}`);
      navigate(`/jobs/${created.id}`);
    } catch (err) {
      toast.fromError(err, '重跑失败');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    const ok = await confirm({
      title: '取消作业',
      text: '仅未结束的作业可取消。取消后由既有逻辑退回积分。',
      confirmText: '确认取消',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await jobsApi.cancel(job.id);
      toast.success('已取消');
      onDone();
    } catch (err) {
      toast.fromError(err, '取消失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <PermissionGate permission={AdminPermission.JobManage}>
      <Button
        loading={busy}
        disabled={!terminated}
        onClick={() => void retry()}
        title={terminated ? undefined : '进行中的作业不能重跑'}
      >
        重跑
      </Button>
      <Button variant="danger" disabled={terminated} onClick={() => void cancel()}>
        取消
      </Button>
    </PermissionGate>
  );
}

/** 详情主体（拆出来是为了让页面组件的分支数留在可读范围内） */
function JobOverview({ job }: { job: AdminJobDetail }) {
  const status = jobStatus(job.status);
  const failed = job.status === 'failed' || job.status === 'rejected';

  return (
    <div className="qz-col" style={{ gap: 'var(--sp-5)' }}>
      <Card title="执行情况">
        <DescList
          items={[
            { label: '状态', value: <Tag tone={status.tone}>{status.text}</Tag> },
            { label: '阶段', value: job.stage ?? EMPTY },
            {
              label: '进度',
              value: (
                <div style={{ minWidth: 140 }}>
                  <ProgressBar value={job.progress} failed={failed} />
                  <div className="qz-dim" style={{ marginTop: 4 }}>
                    {job.progress}%
                  </div>
                </div>
              ),
            },
            { label: '消耗积分', value: formatMoney(job.cost) },
            {
              label: '质量分',
              value: <ScoreBadge score={job.qualityScore} tone={qualityTone(job.qualityScore)} />,
            },
            { label: '产物数量', value: String(job.outputCount) },
            {
              label: '发起用户',
              value: (
                <Link to={`/users/${job.userId}`}>{job.nickname ?? shorten(job.userId, 8, 4)}</Link>
              ),
            },
            { label: '创建时间', value: formatDateTime(job.createdAt) },
            { label: '结束时间', value: formatDateTime(job.finishedAt) },
            { label: '耗时', value: formatDuration(job.createdAt, job.finishedAt) },
          ]}
        />
      </Card>

      {job.error ? (
        <div className="qz-alert qz-alert--error">
          <div>
            <strong>失败原因：</strong>
            {job.error}
          </div>
        </div>
      ) : null}

      {job.qualityIssues.length ? (
        <Card title="质量扣分项" subtitle="AI 产出未达标的具体原因（评分器与提示词、质检同源）">
          <ul className="qz-col" style={{ gap: 6 }}>
            {job.qualityIssues.map((issue) => (
              <li key={issue}>· {issue}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="调用参数" subtitle="用户提交的原始参数（排查「是不是参数没给对」时看这里）">
        <JsonBlock value={job.params} />
      </Card>

      <Card title={`产出文件（${job.outputFiles.length}）`}>
        <FileList files={job.outputFiles} />
      </Card>
    </div>
  );
}

function FileList({ files }: { files: string[] }) {
  if (!files.length) return <div className="qz-dim">没有产物</div>;
  return (
    <ul className="qz-col" style={{ gap: 6 }}>
      {files.map((f) => (
        <li key={f}>
          <a href={f} target="_blank" rel="noreferrer" className="qz-mono">
            {f}
          </a>
        </li>
      ))}
    </ul>
  );
}
