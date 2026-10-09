import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { ServiceController } from './service.controller';
import { ServiceWriteService } from './service-write.service';
import { ServiceService } from './service.service';

/**
 * 服务商品模块（任务清单 M3-04）
 *
 * 驿站「服务市场」Tab 的数据源：服务者预先上架的标准商品（区别于 M3-06 的需求发布）。
 * 与驿站分模块而不是塞进 `station/`：这里管的是**商品**（`service` 表），
 * 驿站管的是**需求**（`task` 表）；两者的权限模型、状态机、下游（下单 vs 报名）都不同。
 *
 * ## 依赖
 *
 * - `AuthModule` —— 控制器挂了 `JwtAuthGuard`，它依赖 `TokenService`。
 *   漏了会在启动时报 "Nest can't resolve dependencies of the JwtAuthGuard"
 *   （本项目已知坑，FileModule / OrderModule / StationModule 同理）。
 * - `ModerationModule` / `PrismaModule` / `LoggerModule` / `ProvidersModule` 都是 `@Global`，
 *   无需显式 import。
 *
 * ## 不导出给谁
 *
 * `ServiceService` 现在**导出**了：助手（OsModule 的 CampusTool）要复用同一条检索，
 * 让"助手推荐的服务"与"服务市场页显示的服务"是同一份数据、同一套在架过滤。真有需求（如下单时校验商品在架）时再导出，
 * 顺手在 `OrderService` 那边接 —— 本期不预留（避免"看起来接了其实没人调"）。
 */
@Module({
  imports: [AuthModule],
  controllers: [ServiceController],
  providers: [ServiceService, ServiceWriteService],
  exports: [ServiceService],
})
export class ServiceModule {}
