import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { FileModule } from '../file/file.module';

import { DataToolRunner } from './data-tool-runner';
import { JobController } from './job.controller';
import { JobEventsService } from './job-events.service';
import { JobProgressGateway } from './job-progress.gateway';
import { ImageToolRunner } from './image-tool-runner';
import { JobService } from './job.service';
import { JobRetryService } from './job-retry.service';
import { JobRunnerService } from './job-runner.service';
import { LlmToolRunner } from './llm-tool-runner';
import { MediaAiToolRunner } from './media-ai-tool-runner';
import { MediaToolRunner } from './media-tool-runner';
import { PdfToolRunner } from './pdf-tool-runner';
import { RepoToolRunner } from './repo-tool-runner';
import { ToolExecutorService } from './tool-executor.service';

/**
 * 作业与执行模块（任务清单 M1-03 / M1-04 / M1-05 / M1-06）
 *
 * imports:
 *   AuthModule    —— JwtAuthGuard 依赖其 TokenService（所有需登录模块的固定写法）；
 *                    进度推送网关的握手鉴权也复用它
 *   FileModule    —— ToolExecutor 要把产出写回文件资产（saveGenerated / readObject）
 *   BillingModule —— 作业进入终态时结清积分（成功转正 / 失败退回）
 *
 * providers:
 *   JobService         作业 CRUD、状态机流转、进度落库（进度单调写入）
 *   JobRetryService    重试（新建 + 重新预扣；与提交链路同一套计费）
 *   JobEventsService   作业事件总线（按用户分发，M1-05）
 *   JobProgressGateway WebSocket 网关（M1-05；由 main.ts 挂到 HTTP 服务器上）
 *   JobRunnerService   队列消费与执行编排（M1-03 / M1-04）
 *   ToolExecutorService  工具名 → Provider 路由
 *
 * 导出 JobService / JobRunnerService / ToolExecutorService / JobEventsService /
 * JobProgressGateway，供 ToolModule 的调用入口（M1-02）、HealthModule 的可观测性
 * 以及后续模块复用。
 *
 * ⚠️ 需要某处注入这些 Provider 时，**必须确保它们出现在 exports 里** ——
 *    Nest 的 imports 不会把提供者"传递"出去，漏导出会在启动时报
 *    "Nest can't resolve dependencies of ... at index [n]"（本项目已踩过两次）。
 */
@Module({
  imports: [AuthModule, BillingModule, FileModule],
  controllers: [JobController],
  providers: [
    JobService,
    JobRetryService,
    JobEventsService,
    JobProgressGateway,
    DataToolRunner,
    ImageToolRunner,
    LlmToolRunner,
    MediaAiToolRunner,
    MediaToolRunner,
    PdfToolRunner,
    RepoToolRunner,
    ToolExecutorService,
    JobRunnerService,
  ],
  exports: [
    JobService,
    JobRetryService,
    JobEventsService,
    JobProgressGateway,
    JobRunnerService,
    ToolExecutorService,
  ],
})
export class JobModule {}
