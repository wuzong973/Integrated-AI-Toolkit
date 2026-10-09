import { Injectable } from '@nestjs/common';
import { BizException, ErrorCode, ToolStatus } from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { BillingService } from '../billing/billing.service';

import { JobService, type JobItem } from './job.service';

/**
 * 作业重试 —— "重试 = 重新提交一次"（M1-03）。
 *
 * 单独成文件的原因：`JobService` 已顶到单文件 300 行红线（skipComments 也救不了），
 * 而重试要复用 `getRaw` / `create` / `reject`，放同模块拆出来比硬塞回去干净。
 *
 * ⚠️ 预扣（`billing.hold`）只发生在提交链路上，所以调用方**不要**自己
 * `JobService.create()`：直连建出的作业没有 precharge 行，`onJobTerminal()`
 * 查不到预扣就直接返回，等于"重试多少次都不扣分"。
 *
 * 计费按**当前** `tool.price`（改价后重试按新价收）；余额不足则把新作业置 `rejected`，
 * 与提交链路同语义：用户能看到"我提交过、因为积分不够没跑"，而不是点了没反应。
 */
@Injectable()
export class JobRetryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobService,
    private readonly billing: BillingService,
  ) {}

  async retry(userId: string, jobId: string): Promise<JobItem> {
    const source = await this.jobs.getRaw(userId, jobId);
    const tool = await this.prisma.tool.findUnique({ where: { name: source.toolName } });
    if (!tool) {
      throw new BizException(ErrorCode.NotFound, undefined, `工具不存在：${source.toolName}`);
    }
    // 已下线的工具不给重试：否则会建出一个排到队里也跑不起来的作业
    if (tool.status !== ToolStatus.Active) {
      throw new BizException(
        ErrorCode.NotFound,
        { status: tool.status },
        `「${tool.displayName}」正在建设中，敬请期待`,
      );
    }

    const { job } = await this.jobs.create({
      userId,
      toolName: source.toolName,
      params: source.params,
      inputFiles: source.inputFiles,
      cost: tool.price,
    });

    try {
      await this.billing.hold(userId, job.id, tool.price, `「${tool.displayName}」预扣`);
    } catch (e) {
      const reason = e instanceof BizException ? e.message : '积分不足，未开始执行';
      await this.jobs.reject(job.id, reason).catch(() => undefined);
      throw e;
    }

    return job;
  }
}
