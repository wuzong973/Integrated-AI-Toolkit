import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { VocabAnswerService } from './vocab-answer.service';
import { VocabAudioService } from './vocab-audio.service';
import { VocabBookService } from './vocab-book.service';
import { VocabController } from './vocab.controller';
import { VocabPlanService } from './vocab-plan.service';
import { VocabQuizService } from './vocab-quiz';
import { VocabStatsService } from './vocab-stats.service';

/**
 * 记单词 / 四六级词汇训练（任务清单 M4-15）
 *
 * ## 依赖
 *
 * - `AuthModule` —— 控制器挂了 `JwtAuthGuard`，它依赖 `TokenService`。
 *   漏了会在启动时报 "Nest can't resolve dependencies of the JwtAuthGuard"
 *   （本项目已知坑，FileModule / OrderModule / StationModule 同理）。
 * - `PrismaModule` / `LoggerModule` / `ProvidersModule` / `RedisModule` 都是 `@Global`，
 *   无需显式 import（`VocabAudioService` 用到的 `RedisService` 与 `PROVIDERS` 因此可直接注入）。
 *
 * ## 不导出任何服务
 *
 * 本期没有第二个模块要复用这里的逻辑（助手接入词汇能力是后续任务）。
 * 提前 export 只会留下"看起来接了其实没人调"的死接口。
 */
@Module({
  imports: [AuthModule],
  controllers: [VocabController],
  providers: [
    VocabBookService,
    VocabPlanService,
    VocabQuizService,
    VocabAnswerService,
    VocabStatsService,
    VocabAudioService,
  ],
})
export class VocabModule {}