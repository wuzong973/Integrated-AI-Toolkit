import { Global, Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { ConversationController } from './conversation.controller';
import { ConversationService } from './conversation.service';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

/**
 * 站内消息模块（任务清单 M3-19）
 *
 * 一个模块管两件事：**站内信**（`/notifications`）与**交易会话**（`/conversations`）。
 * 合在一起不是为了省文件 —— 发消息这个动作必须同时产出"对方的未读通知"，
 * 拆开成两个模块就得跨模块调写方法，事务边界反而说不清（见 `ConversationService.send()`）。
 *
 * ## 为什么是 `@Global`
 *
 * 订单交付 / 验收 / 退款、驿站报名 / 选定 / 关闭这 7 个业务动作**都要**扇出通知。
 * 做成普通模块就得在 `OrderModule`、`StationModule` 各加一行 `imports` ——
 * 而漏掉的那一行不会报错，只会让那个动作"做完了但没人收到通知"，
 * 正是本项目反复出现的"看起来能用、其实断路"（与 `ModerationModule` 同一条理由）。
 * 扇出点因此只依赖注入 `NotificationService`，`notify()` 又强制传 `tx`，
 * 于是"通知与业务同事务"这件事既不需要 import 记账、也不靠人记住。
 *
 * ⚠️ 一处不得不留的口子：订单/驿站那几个 service 的构造函数里，这个依赖在 **TS 上标了 `?`**、
 * 扇出处写成 `this.notifications?.notify(...)`。原因很具体 ——
 * `modules/order/__tests__` 里的既有用例是**手工 new** 出来的旧签名，而不归本次改动范围。
 * Nest 侧不受影响：`design:paramtypes` 仍记录这个类型，装配不上就是启动失败，
 * 所以"线上没接通知"这条路依然不存在（兜底的是 DI，不是那个 `?.`）。
 *
 * ## 依赖
 *
 * `AuthModule` —— 两个控制器挂 `JwtAuthGuard`，它依赖 `TokenService`，
 *   漏了会在启动时报 "Nest can't resolve dependencies of the JwtAuthGuard"（全项目固定坑）。
 *   ⚠️ 本模块被 `OrderModule` / `StationModule` 依赖的是**全局 provider**，
 *   不存在模块环：`NotificationService` 不 import 它们，会话里的订单字段是直接查表的。
 * `PrismaModule` / `ModerationModule` / `ProvidersModule` / `LoggerModule` 都是 `@Global`，无需显式 import。
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [NotificationController, ConversationController],
  providers: [NotificationService, ConversationService],
  exports: [NotificationService, ConversationService],
})
export class NotificationModule {}
