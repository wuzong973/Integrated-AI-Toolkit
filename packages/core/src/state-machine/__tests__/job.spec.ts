import { describe, expect, it } from 'vitest';

import { JobStatus } from '../../enums';
import { JOB_TRANSITIONS, shouldRefundPoints, transitionJob } from '../job';

describe('Job 状态机（文档 6.5.1）', () => {
  it('全部合法迁移通过、全部非法迁移抛错（自迁移视为非法）', () => {
    const all = Object.values(JobStatus);
    for (const from of all) {
      const allowed = JOB_TRANSITIONS[from] ?? [];
      for (const to of all) {
        if (to !== from && allowed.includes(to)) {
          expect(() => transitionJob(from, to)).not.toThrow();
        } else {
          expect(() => transitionJob(from, to)).toThrow(/非法状态迁移/);
        }
      }
    }
  });

  it('失败与取消都要退回积分', () => {
    expect(shouldRefundPoints(JobStatus.Failed)).toBe(true);
    expect(shouldRefundPoints(JobStatus.Canceled)).toBe(true);
  });

  it('成功与拒绝不退回积分', () => {
    expect(shouldRefundPoints(JobStatus.Succeeded)).toBe(false);
    expect(shouldRefundPoints(JobStatus.Rejected)).toBe(false);
  });

  it('succeeded 是终态，不可再迁移', () => {
    expect(() => transitionJob(JobStatus.Succeeded, JobStatus.Running)).toThrow();
  });

  it('queued 可被拒绝（参数校验未通过，未扣费）', () => {
    expect(transitionJob(JobStatus.Queued, JobStatus.Rejected)).toBe(JobStatus.Rejected);
  });
});
