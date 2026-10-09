import { JobStatus } from '../enums';

import { IllegalTransitionError } from './index';

/**
 * Job（工具执行作业）状态机（文档 6.5.1）
 *
 * queued --> running --+--> succeeded
 *    |         |       +--> failed --> (积分退回)
 *    |         |       +--> canceled --> (积分退回)
 *    |         +--> timeout -> failed -> (积分退回)
 *    +--> rejected（校验未通过，未扣费）
 */
export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  [JobStatus.Queued]: [JobStatus.Running, JobStatus.Canceled, JobStatus.Rejected],
  [JobStatus.Running]: [JobStatus.Succeeded, JobStatus.Failed, JobStatus.Canceled],
  [JobStatus.Succeeded]: [],
  [JobStatus.Failed]: [],
  [JobStatus.Canceled]: [],
  [JobStatus.Rejected]: [],
};

export const JOB_TERMINAL_STATUSES: readonly JobStatus[] = [
  JobStatus.Succeeded,
  JobStatus.Failed,
  JobStatus.Canceled,
  JobStatus.Rejected,
];

export function transitionJob(from: JobStatus, to: JobStatus): JobStatus {
  const allowed = JOB_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new IllegalTransitionError(from, to, 'job');
  }
  return to;
}

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return (JOB_TRANSITIONS[from] ?? []).includes(to);
}

export function isJobTerminal(status: JobStatus): boolean {
  return JOB_TERMINAL_STATUSES.includes(status);
}

/** 是否需要退回预扣积分（失败/取消/超时都退） */
export function shouldRefundPoints(status: JobStatus): boolean {
  return status === JobStatus.Failed || status === JobStatus.Canceled;
}
