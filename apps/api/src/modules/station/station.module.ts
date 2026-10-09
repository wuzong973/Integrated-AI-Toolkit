import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { OrderModule } from '../order/order.module';

import { StationController } from './station.controller';
import { StationMatchService } from './station-match.service';
import { StationParseService } from './station-parse.service';
import { StationService } from './station.service';
import { StationWriteService } from './station-write.service';

/**
 * 驿站模块（任务清单 M3-01 / M3-06 / M3-07 / M3-08 / M3-09 / M3-10）
 *
 * ## 依赖
 *
 * - `AuthModule` —— 控制器挂了 `JwtAuthGuard`，它依赖 `TokenService`。
 *   漏了会在启动时报 "Nest can't resolve dependencies of the JwtAuthGuard"
 *   （本项目的固定坑，与 FileModule / OrderModule 同理）。
 * - `OrderModule` —— "选定服务者"要在**同一事务**里生成担保订单（M3-11），
 *   复用 `OrderService.createInTx` 而不是自己再写一份下单逻辑。
 * - `ModerationModule` / `ProvidersModule` / `PrismaModule` / `LoggerModule` 都是 `@Global`，无需显式 import。
 *
 * ## 为什么不再叫"只读切片"
 *
 * 之前这里只有读，写路径刻意不注册占位路由 —— 让前端拿到 404，
 * 一眼能看出"还没做"，而不是一个假装成功的空响应。
 * 现在四条写路径都实现了，所以不存在占位路由问题；
 * 未实现的是**服务商品 CRUD（M3-04）与服务者入驻认证（M3-02）**，
 * 它们仍不注册路由，保持 404。
 */
@Module({
  imports: [AuthModule, OrderModule],
  controllers: [StationController],
  providers: [StationService, StationWriteService, StationParseService, StationMatchService],
  // StationParseService 也导出：助手（OsModule 的 CampusTool）要复用同一条
  // "AI 极速发布"解析链路，否则助手给的草稿与发布页点 AI 填表的会不一致。
  exports: [StationService, StationMatchService, StationWriteService, StationParseService],
})
export class StationModule {}
