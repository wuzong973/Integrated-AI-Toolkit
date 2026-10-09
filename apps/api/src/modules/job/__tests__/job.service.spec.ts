import { describe, expect, it, vi } from 'vitest';
import { BizException, ErrorCode, JobStatus } from '@qz/core';

import { JobService } from '../job.service';
import { JobRetryService } from '../job-retry.service';

/** 内存版 ToolJob / Tool 表，只实现 JobService 用到的方法 */
function makePrisma(
  seed: {
    timeoutSec?: number;
    toolPrice?: number;
    toolStatus?: string;
    toolDisplayName?: string;
  } = {},
) {
  const jobs: Record<string, Record<string, unknown>>[] = [];
  let seq = 0;

  const prisma = {
    toolJob: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        // 模拟真实的**复合唯一约束** `(user_id, idempotency_key)`：
        // 同一用户同一键再插会撞 P2002，不同用户用同一个键则互不影响。
        // 假实现必须还原这条语义，否则"跨用户幂等"的回归测试就失去意义。
        if (data.idempotencyKey) {
          const dup = jobs.find(
            (j) => j.userId === data.userId && j.idempotencyKey === data.idempotencyKey,
          );
          if (dup) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }

        const row = {
          id: `job-${++seq}`,
          progress: 0,
          stage: null,
          error: null,
          outputFiles: [],
          startedAt: null,
          finishedAt: null,
          createdAt: new Date(),
          idempotencyKey: null,
          runId: null,
          nodeId: null,
          ...data,
        };
        jobs.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id) return jobs.find((j) => j.id === where.id) ?? null;
        return null;
      },
      /** JobService 现在按 (userId, idempotencyKey) 查（幂等范围是单个用户） */
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        return (
          jobs.find(
            (j) =>
              (where.userId === undefined || j.userId === where.userId) &&
              (where.idempotencyKey === undefined || j.idempotencyKey === where.idempotencyKey),
          ) ?? null
        );
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        return jobs.filter((j) => !where.status || j.status === where.status);
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = jobs.find((j) => j.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    tool: {
      findUnique: async ({ where }: { where?: { name?: string } } = {}) => ({
        name: where?.name ?? 'demo-tool',
        displayName: seed.toolDisplayName ?? '演示工具',
        status: seed.toolStatus ?? 'active',
        price: seed.toolPrice ?? 0,
        timeoutSec: seed.timeoutSec ?? 300,
      }),
      /**
       * 超时扫描改为**批量预取**（`name: { in: [...] }`）后不再是 N+1，
       * 假对象必须跟着补上 —— 否则测出来的是"假 Prisma 没有这个方法"，
       * 而不是被测代码的行为。
       */
      findMany: async ({ where }: { where?: { name?: { in?: string[] } } } = {}) =>
        (where?.name?.in ?? []).map((name) => ({ name, timeoutSec: seed.timeoutSec ?? 300 })),
    },
  };

  return { prisma, jobs };
}

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/**
 * 作业事件总线的假实现（M1-05 起 JobService 会在状态变更时发布事件）。
 * 记录发布内容，让"状态变更必须伴随推送"这件事可以被断言 ——
 * 漏发的表现是"界面永远不动"，是联调时最难定位的一类问题。
 */
function makeEvents() {
  const progress: { jobId: string; status: string; progress: number }[] = [];
  const finished: { jobId: string; status: string; progress: number }[] = [];
  return {
    progress,
    finished,
    events: {
      publishProgress: (
        _userId: string,
        snapshot: { jobId: string; status: string; progress: number },
      ) => {
        progress.push(snapshot);
      },
      publishFinished: (
        _userId: string,
        snapshot: { jobId: string; status: string; progress: number },
      ) => {
        finished.push(snapshot);
      },
    },
  };
}

/**
 * 计费的假实现（M1-06 起 JobService 会在进入终态时结清积分）。
 * 记录调用，断言"成功转正 / 失败退回"确实挂在了状态流转的唯一出口上。
 * `failHold` 用来模拟余额不足（重试必须因此被拒、并把作业置 rejected）。
 */
function makeBilling(opts: { failHold?: boolean } = {}) {
  const terminal: { jobId: string; status: string }[] = [];
  const holds: { userId: string; jobId: string; cost: number }[] = [];
  return {
    terminal,
    holds,
    billing: {
      onJobTerminal: async (_userId: string, jobId: string, status: string) => {
        terminal.push({ jobId, status });
      },
      hold: async (userId: string, jobId: string, cost: number) => {
        if (opts.failHold) {
          throw new BizException(ErrorCode.PointsNotEnough, undefined, '积分不足');
        }
        holds.push({ userId, jobId, cost });
        return { held: cost > 0, alreadyHeld: false, balanceAfter: 0 };
      },
    },
  };
}

function makeService(
  seed: {
    timeoutSec?: number;
    toolPrice?: number;
    toolStatus?: string;
    toolDisplayName?: string;
    failHold?: boolean;
  } = {},
) {
  const { prisma, jobs } = makePrisma(seed);
  const { events, progress, finished } = makeEvents();
  const { billing, terminal, holds } = makeBilling({ failHold: seed.failHold });
  const service = new JobService(
    prisma as never,
    events as never,
    billing as never,
    logger as never,
  );
  const retry = new JobRetryService(prisma as never, service, billing as never);
  return { service, retry, jobs, progress, finished, terminal, holds };
}

const base = {
  userId: 'u1',
  toolName: 'generate_ppt',
  params: {},
  inputFiles: [],
  cost: 5,
};

describe('JobService（M1-03 状态机与超时）', () => {
  it('创建作业：初始状态 queued，成本落库', async () => {
    const { service } = makeService();
    const { job, reused } = await service.create(base);

    expect(job.status).toBe(JobStatus.Queued);
    expect(job.cost).toBe(5);
    expect(reused).toBe(false);
  });

  it('幂等：同一 idempotencyKey 第二次调用返回既有作业且 reused=true', async () => {
    const { service, jobs } = makeService();
    const first = await service.create({ ...base, idempotencyKey: 'k1' });
    const second = await service.create({ ...base, idempotencyKey: 'k1' });

    expect(second.reused).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(jobs).toHaveLength(1); // 只落一条
  });

  /**
   * ⭐ 回归测试：幂等键的作用范围是**单个用户**，不是全局
   *
   * 修前的行为：用户 B 用与 A 相同的键时，会命中 A 的作业并返回 reused=true ——
   * B 自己的请求被静默丢弃（不执行、不扣费），随后访问那个 jobId 还会 403。
   * 这类"提交被静默吞掉"的症状极难排查，所以必须用测试钉住。
   */
  it('⭐ 不同用户使用同一个幂等键：各自成作业，互不干扰', async () => {
    const { service, jobs } = makeService();

    const a = await service.create({ ...base, userId: 'u1', idempotencyKey: 'same-key' });
    const b = await service.create({ ...base, userId: 'u2', idempotencyKey: 'same-key' });

    expect(a.reused).toBe(false);
    expect(b.reused).toBe(false); // 关键：B 不能被判定为"重复提交"
    expect(b.job.id).not.toBe(a.job.id);
    expect(jobs).toHaveLength(2);

    // 各自的第二次调用仍然幂等
    const a2 = await service.create({ ...base, userId: 'u1', idempotencyKey: 'same-key' });
    expect(a2.reused).toBe(true);
    expect(a2.job.id).toBe(a.job.id);
  });

  it('并发撞复合唯一约束时读回的是**自己的**作业（不能返回别人的）', async () => {
    const { service } = makeService();
    const a = await service.create({ ...base, userId: 'u1', idempotencyKey: 'race' });
    // 直接走 create 再撞一次：模拟并发下先查到空、插入时被唯一约束挡下
    const again = await service.create({ ...base, userId: 'u1', idempotencyKey: 'race' });

    expect(again.reused).toBe(true);
    expect(again.job.id).toBe(a.job.id);
  });

  it('幂等键不属于当前用户时不会被冒领（读不到就如实新建）', async () => {
    const { service, jobs } = makeService();
    await service.create({ ...base, userId: 'u1', idempotencyKey: 'belongs-to-u1' });

    const other = await service.create({ ...base, userId: 'u2', idempotencyKey: 'belongs-to-u1' });

    expect(other.reused).toBe(false);
    expect(other.job.id).not.toBe(jobs[0].id);
  });

  it('正常流转：queued → running → succeeded，进度与产出落库', async () => {
    const { service, jobs } = makeService();
    const { job } = await service.create(base);

    await service.markRunning(job.id);
    await service.updateProgress(job.id, 55, '渲染中');
    await service.succeed(job.id, ['file-1']);

    expect(jobs[0].status).toBe(JobStatus.Succeeded);
    expect(jobs[0].progress).toBe(100);
    expect(jobs[0].outputFiles).toEqual(['file-1']);
    expect(jobs[0].finishedAt).toBeInstanceOf(Date);
  });

  it('非法流转被状态机挡下：succeeded 之后不能再置 running', async () => {
    const { service } = makeService();
    const { job } = await service.create(base);
    await service.markRunning(job.id);
    await service.succeed(job.id, []);

    await expect(service.markRunning(job.id)).rejects.toThrow();
  });

  it('queued 直接 succeed 也不允许（必须先 running）', async () => {
    const { service } = makeService();
    const { job } = await service.create(base);
    await expect(service.succeed(job.id, [])).rejects.toThrow();
  });

  it('已终态作业不能再取消（409 语义）', async () => {
    const { service } = makeService();
    const { job } = await service.create(base);
    await service.markRunning(job.id);
    await service.fail(job.id, '炸了');

    await expect(service.cancel('u1', job.id)).rejects.toMatchObject({ code: 40904 });
  });

  it('他人不能查看或取消我的作业（越权 40313）', async () => {
    const { service } = makeService();
    const { job } = await service.create(base);
    await expect(service.get('other-user', job.id)).rejects.toMatchObject({ code: 40313 });
    await expect(service.cancel('other-user', job.id)).rejects.toMatchObject({ code: 40313 });
  });

  describe('超时扫描（验收：超时任务自动置 failed）', () => {
    it('running 超过工具 timeoutSec 的作业被置为 failed 并写原因', async () => {
      const { service, jobs } = makeService({ timeoutSec: 60 });
      const { job } = await service.create(base);
      await service.markRunning(job.id);

      // 把开始时间拨到 61 秒前，模拟超时
      jobs[0].startedAt = new Date(Date.now() - 61_000);

      const expired = await service.sweepTimeouts();

      expect(expired).toEqual([job.id]);
      expect(jobs[0].status).toBe(JobStatus.Failed);
      expect(String(jobs[0].error)).toContain('执行超时');
    });

    it('未超时的 running 作业不被误伤', async () => {
      const { service, jobs } = makeService({ timeoutSec: 300 });
      const { job } = await service.create(base);
      await service.markRunning(job.id);

      const expired = await service.sweepTimeouts();

      expect(expired).toHaveLength(0);
      expect(jobs[0].status).toBe(JobStatus.Running);
    });

    it('queued 状态的作业不参与超时扫描（还没开始执行）', async () => {
      const { service, jobs } = makeService({ timeoutSec: 1 });
      await service.create(base);
      jobs[0].createdAt = new Date(Date.now() - 3600_000);

      const expired = await service.sweepTimeouts();
      expect(expired).toHaveLength(0);
      expect(jobs[0].status).toBe(JobStatus.Queued);
    });
  });

  /**
   * 状态流转的两个"必须挂上"的副作用（M1-05 推送 / M1-06 计费）。
   *
   * 它们都挂在 `transition()` 这个唯一出口上，所以这里断言的实际是
   * "唯一出口没被绕过"。这类接线一旦漏了，症状是"界面不动、积分不退"——
   * 都不会报错，只能靠测试钉住。
   */
  describe('状态流转的副作用（推送 + 计费）', () => {
    it('succeeded：推送终态事件，并按成功路径结清积分', async () => {
      const { service, progress, finished, terminal } = makeService();
      const { job } = await service.create(base);

      await service.markRunning(job.id);
      await service.succeed(job.id, ['file-1']);

      expect(progress.map((e) => e.status)).toEqual([JobStatus.Running]);
      expect(finished.map((e) => e.status)).toEqual([JobStatus.Succeeded]);
      expect(finished[0]).toMatchObject({ jobId: job.id, progress: 100 });
      expect(terminal).toEqual([{ jobId: job.id, status: JobStatus.Succeeded }]);
    });

    it('failed：推送终态事件，并按失败路径结清（退回）', async () => {
      const { service, finished, terminal } = makeService();
      const { job } = await service.create(base);

      await service.markRunning(job.id);
      await service.fail(job.id, '存储不可用');

      expect(finished.map((e) => e.status)).toEqual([JobStatus.Failed]);
      expect(terminal).toEqual([{ jobId: job.id, status: JobStatus.Failed }]);
    });

    it('canceled：同样走终态事件与退回', async () => {
      const { service, finished, terminal } = makeService();
      const { job } = await service.create(base);

      await service.cancel(base.userId, job.id);

      expect(finished.map((e) => e.status)).toEqual([JobStatus.Canceled]);
      expect(terminal).toEqual([{ jobId: job.id, status: JobStatus.Canceled }]);
    });

    it('queued（非终态）只推送进度，不触发计费结清', async () => {
      const { service, terminal } = makeService();
      const { job } = await service.create(base);

      await service.markRunning(job.id);
      expect(terminal).toEqual([]);
    });
  });
});

describe('JobRetryService（重试必须重新计费）', () => {
  it('重试 = 原参数新建作业，并**重新预扣**积分', async () => {
    const { service, retry, holds } = makeService({ toolPrice: 5 });
    const { job: origin } = await service.create(base);

    const job = await retry.retry(base.userId, origin.id);

    expect(job.id).not.toBe(origin.id);
    expect(job.toolName).toBe(base.toolName);
    expect(job.status).toBe(JobStatus.Queued);
    // 关键断言：旧实现直连 create()，这条 holds 是空的 —— 即无限免费重跑
    expect(holds).toEqual([{ userId: base.userId, jobId: job.id, cost: 5 }]);
  });

  it('按当前 tool.price 计费，而不是原作业的 cost（改价后按新价收）', async () => {
    const { service, retry, holds } = makeService({ toolPrice: 12 });
    const { job: origin } = await service.create({ ...base, cost: 5 });

    const job = await retry.retry(base.userId, origin.id);

    expect(job.cost).toBe(12);
    expect(holds.map((h) => h.cost)).toEqual([12]);
  });

  it('余额不足 → 抛 403 且新作业置 rejected（用户能看到"提交过但没跑"）', async () => {
    const { service, retry, jobs } = makeService({ toolPrice: 5, failHold: true });
    const { job: origin } = await service.create(base);

    await expect(retry.retry(base.userId, origin.id)).rejects.toMatchObject({
      code: ErrorCode.PointsNotEnough,
    });

    const retried = jobs.find((j) => j.id !== origin.id)!;
    expect(retried.status).toBe(JobStatus.Rejected);
  });

  it('已下线的工具不给重试：明确报错，而不是建一个排到队里也跑不起来的作业', async () => {
    const { service, retry, jobs } = makeService({ toolStatus: 'planned' });
    const { job: origin } = await service.create(base);
    const before = jobs.length;

    await expect(retry.retry(base.userId, origin.id)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
    expect(jobs.length).toBe(before);
  });

  it('非本人作业 → NoPermission（重试同样受归属校验）', async () => {
    const { service, retry } = makeService();
    const { job: origin } = await service.create(base);

    await expect(retry.retry('u-other', origin.id)).rejects.toMatchObject({
      code: ErrorCode.NoPermission,
    });
  });
});
