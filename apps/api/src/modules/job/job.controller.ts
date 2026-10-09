import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BizException, ErrorCode, JobListQuerySchema, type JobListQueryDto } from '@qz/core';

import { CurrentUser, type AuthUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { JobService, type JobItem } from './job.service';
import { JobRetryService } from './job-retry.service';
import { JobRunnerService } from './job-runner.service';

/**
 * 作业查询与操作（任务清单 M1-03 / 文档 9.2.3）
 *
 * 执行进度由小程序轮询 `GET /jobs/:id`（M1-05 会补 WebSocket 推送，轮询作为兜底）。
 */
@ApiTags('job')
@ApiBearerAuth()
@Controller('jobs')
@UseGuards(JwtAuthGuard)
export class JobController {
  constructor(
    private readonly jobs: JobService,
    private readonly retryService: JobRetryService,
    private readonly runner: JobRunnerService,
  ) {}

  @Get()
  @ApiOperation({ summary: '我的执行记录' })
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(JobListQuerySchema)) query: JobListQueryDto,
  ): Promise<JobItem[]> {
    return this.jobs.list(user.id, query.status);
  }

  @Get(':id')
  @ApiOperation({ summary: '查询执行状态与进度' })
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<JobItem> {
    return this.jobs.get(user.id, id);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: '取消任务' })
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<JobItem> {
    return this.jobs.cancel(user.id, id);
  }

  @Post(':id/retry')
  @ApiOperation({ summary: '重试任务（以相同参数新建一个作业）' })
  async retry(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<JobItem> {
    // 建作业 + 预扣积分都在 JobRetryService 里完成：
    // 这里若自己 jobs.create()，新作业就没有预扣行，等于无限次免费重跑。
    const job = await this.retryService.retry(user.id, id);
    try {
      await this.runner.enqueue(job.id);
    } catch (e) {
      // 队列不可用：置 failed 并明确报"队列繁忙"，否则作业会永远停在 queued（无人再捡）
      await this.jobs.fail(job.id, `任务入队失败：${(e as Error).message}`).catch(() => undefined);
      throw new BizException(ErrorCode.QueueBusy, undefined, '任务队列繁忙，请稍后重试');
    }
    return this.jobs.get(user.id, job.id);
  }
}
