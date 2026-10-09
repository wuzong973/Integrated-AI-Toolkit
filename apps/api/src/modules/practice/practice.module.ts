import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { EssayGraderService } from './essay-grader.service';
import { PracticeAudioService } from './practice-audio.service';
import { PracticeController } from './practice.controller';
import { PracticePersistService } from './practice-persist.service';
import { PracticeQueueService } from './practice-queue.service';
import { PracticeStatsService } from './practice-stats.service';
import { PracticeSubmitService } from './practice-submit.service';

/**
 * 练习中心：句子 / 口语 / 作文（任务清单 M4-16）
 *
 * ## 依赖
 *
 * - `AuthModule` —— 控制器挂了 `JwtAuthGuard`，它依赖 `TokenService`。
 *   漏了会在**启动时**报 "Nest can't resolve dependencies of the JwtAuthGuard"。
 *   ⚠️ 这是本项目最高频的接线失误之一，且**漏挂守卫本身不报错**（接口照常 200）——
 *   所以 import `AuthModule` 与 `@UseGuards` 必须同时有，缺一个都是缺陷。
 * - `PrismaModule` / `LoggerModule` / `ProvidersModule` / `RedisModule` 都是 `@Global`，
 *   无需显式 import（`PracticeSubmitService` 用到的 `PROVIDERS`、
 *   `PracticeAudioService` 用到的 `RedisService` 因此可直接注入）。
 *
 * ## 不导出任何服务
 *
 * 与 `VocabModule` 同一条纪律：本期没有第二个模块要复用这里的逻辑。
 * 提前 export 只会留下"看起来接了其实没人调"的死接口
 * （本项目在 M4-05 与 `search_knowledge` 上踩过两次）。
 */
@Module({
  imports: [AuthModule],
  controllers: [PracticeController],
  providers: [
    PracticeQueueService,
    PracticeSubmitService,
    // 落库单独一个服务：句子 / 口语 / 作文三条路径共用同一份"写三张表"的逻辑，
    // 它也是**唯一**写 `practice_*` 四张表的地方（见该文件头）
    PracticePersistService,
    PracticeStatsService,
    PracticeAudioService,
    EssayGraderService,
  ],
})
export class PracticeModule {}
