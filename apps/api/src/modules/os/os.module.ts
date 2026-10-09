import { Module } from '@nestjs/common';

import { ProvidersModule } from '../../infra/providers/providers.module';
import { AuthModule } from '../auth/auth.module';
import { JobModule } from '../job/job.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ServiceModule } from '../service/service.module';
import { StationModule } from '../station/station.module';
import { ToolModule } from '../tool/tool.module';

import { AiDispatchService } from './ai-dispatch.service';
import { OsCapabilityRegistry } from './os-capability.registry';
import { OsController } from './os.controller';
import { CampusTool } from './os-campus-tool';
import { KnowledgeTool } from './os-knowledge-tool';
import { OsRunService } from './os-run.service';
import { OsService } from './os.service';
import { OsToolRegistry } from './os-tools';

/**
 * 青智 OS（AI 助手）模块
 *
 * imports:
 *   AuthModule —— 本模块的接口全部需要登录（JwtAuthGuard），
 *     而 JwtAuthGuard 依赖 AuthModule 的 TokenService。
 *     ⚠️ 子模块的 imports **不会传递**，必须自己 import 一次，
 *     否则启动报 "Nest can't resolve dependencies of the JwtAuthGuard"。
 *     这是本项目的固定坑（见 ToolModule 的注释）。
 *   ProvidersModule —— 通过 `PROVIDERS` 注入 `llm`，
 *     与工具执行器走的是**同一个 Provider 实例**（同一份配置、同一个降级链）。
 *     若这里另建一个 LLM 客户端，就会出现"工具用的模型和助手用的模型不一样"
 *     这种极难排查的不一致。
 *   KnowledgeModule —— `KnowledgeTool` 复用 `KnowledgeService` 做 `search_knowledge`。
 *     **必须显式 import**：子模块的 exports 不会传递，漏了会在启动时报
 *     "Nest can't resolve dependencies of KnowledgeTool"。
 *     复用而不是新写一份检索，是为了让助手与知识库页面走**完全同一条检索链路**
 *     （同一个向量库、同一套阈值），否则会出现"助手查得到、页面查不到"这类怪事。
 *   ToolModule —— `AiDispatchService` 调用 `ToolInvokeService`（M1-02 的统一调用入口）。
 *     复用它的意义不是省代码，而是让助手**继承**配额 / 幂等 / 预扣 / 计费开关 /
 *     执行器白名单这一整套纪律；另起一条路径等于把这些纪律在助手里全部绕开。
 *   JobModule —— `OsCapabilityRegistry` 注入 `ToolExecutorService` 判断"这个能力到底
 *     能不能跑"（M2-08 的"未注册工具无法调用"就落在这里）。
 *     注意 ToolModule 虽然也 import 了 JobModule，但传递不过去，必须再 import 一次。
 *   StationModule —— M2-06"人力节点一键发布到驿站"复用 `StationWriteService`
 *     （分类校验 + 送审 + taskNo + 直接 published 的唯一发布入口）。
 *     它已进 `StationModule.exports`，这里 import 即可，**不要**再自行 provide
 *     同一个类（曾有过的权宜之计，见 git 历史）。
 *
 * PrismaService 来自全局模块，无需显式 import。
 */
@Module({
  imports: [
    AuthModule,
    ProvidersModule,
    KnowledgeModule,
    ToolModule,
    JobModule,
    StationModule,
    ServiceModule,
  ],
  controllers: [OsController],
  providers: [
    OsService,
    OsToolRegistry,
    OsCapabilityRegistry,
    AiDispatchService,
    KnowledgeTool,
    // 校园能力：只读 / 解析类（写操作刻意不接，理由见 os-campus-tool.ts）
    CampusTool,
    OsRunService,
  ],
})
export class OsModule {}
