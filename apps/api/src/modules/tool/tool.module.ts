import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { JobModule } from '../job/job.module';

import { ToolController } from './tool.controller';
import { ToolInvokeService } from './tool-invoke.service';
import { ToolService } from './tool.service';

/**
 * 工具箱模块（任务清单 M1-01 目录 / M1-02 调用入口 / M1-06 预扣）
 *
 * imports:
 *   AuthModule —— 调用入口用了 JwtAuthGuard，它依赖 AuthModule 的 TokenService。
 *     ⚠️ 子模块的 imports **不会传递**：JobModule 虽然也 import 了 AuthModule，
 *     但 ToolModule 仍必须自己 import 一次，否则启动报
 *     "Nest can't resolve dependencies of the JwtAuthGuard (?, Reflector)"。
 *   JobModule —— 建作业 / 执行 / 入队 / 能力判断。
 *   BillingModule —— 调用前的积分预扣（作业终态的结清由 JobModule 负责）。
 */
@Module({
  imports: [AuthModule, BillingModule, JobModule],
  controllers: [ToolController],
  providers: [ToolService, ToolInvokeService],
  // ToolInvokeService 要导出：青智 OS 的 AI 能力调度（`AiDispatchService`）
  // 复用同一个调用入口，这样配额、幂等、预扣、计费开关对助手**同样生效**。
  // 若助手另起一条执行路径，"前期免费"的开关就会在助手里失效（红线）。
  exports: [ToolService, ToolInvokeService],
})
export class ToolModule {}
