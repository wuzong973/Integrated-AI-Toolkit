import { Global, Module } from '@nestjs/common';

import { ModerationService } from './moderation.service';

/**
 * 内容安全模块（任务清单 M4-05，红线）。
 *
 * ## 为什么是 @Global 而不是让各模块自己 import
 *
 * 它是**合规义务**，不是某个业务模块的可选依赖。如果做成普通模块，
 * 每加一个 UGC 写入口就要多一次 `imports: [ModerationModule]` ——
 * 而漏掉的那一次**不会有任何报错**（除非那个模块恰好一行都没注入），
 * 结果是那个入口悄悄裸奔。全局注册把"记得接线"这件事从人的记忆里拿掉。
 *
 * ## 依赖
 *
 * 依赖全局的 `ProvidersModule`（内容安全 Provider）、`PrismaModule`（查 openid）、
 * `LoggerModule`（违规留痕），三者都无需显式 import。
 */
@Global()
@Module({
  providers: [ModerationService],
  exports: [ModerationService],
})
export class ModerationModule {}
