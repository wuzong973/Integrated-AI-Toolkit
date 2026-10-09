import { Module } from '@nestjs/common';

import { ProvidersModule } from '../../infra/providers/providers.module';
import { AuthModule } from '../auth/auth.module';

import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';

/**
 * 校园知识库模块（M4-06 校园知识库 RAG）
 *
 * imports 的两项都**不能省**（子模块的 imports 不会传递）：
 *   · AuthModule —— 控制器上挂了 `JwtAuthGuard`，而它依赖 AuthModule 的 TokenService。
 *     漏了会在启动时报 "Nest can't resolve dependencies of the JwtAuthGuard"。
 *   · ProvidersModule —— 通过 `PROVIDERS` 注入 `embedding` / `vector` / `llm`。
 *     与工具执行器走的是**同一批 Provider 实例**（同一份配置、同一个降级链），
 *     否则会出现"检索用的向量模型和灌库用的不一样"这种极难排查的不一致。
 *
 * PrismaService 来自全局模块，无需显式 import。
 *
 * ⚠️ `KnowledgeService` 被 export：后续 `search_knowledge` 工具（Agent 内部工具，
 * seed 里 `visible: false`）要复用它。目前该工具仍是 `planned` ——
 * 它的消费方是 Agent 运行循环（M2-10~M2-12），那部分尚未开工，
 * 所以这里先把服务暴露出来，但**不去 seed 里把它改成 active**
 *（一个没有调用方的"可用"工具就是假功能，红线 9）。
 */
@Module({
  imports: [AuthModule, ProvidersModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
