import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { ProviderController } from './provider.controller';
import { ProviderService } from './provider.service';

/**
 * 服务者入驻与认证模块（任务清单 M3-02）
 *
 * ## 依赖
 *
 * - `AuthModule` —— 控制器挂了 `JwtAuthGuard`（依赖 `TokenService`）+ `@Roles(Role.Admin)`。
 *   漏了会在启动时报 "Nest can't resolve dependencies of the JwtAuthGuard"。
 * - `ModerationModule` / `PrismaModule` 都是 `@Global`，无需显式 import。
 *
 * ## 与驿站的关系（两个方向都要有）
 *
 *   · 本模块把人**变成** provider（审核通过 → 授予角色 + 写入技能画像）；
 *   · `StationWriteService.assertIsProvider` 在报名时**校验** provider 角色。
 *
 * 少了任何一边都会出问题：只有前者 → 没认证也能接单；只有后者 → 认证了却接不了单。
 * 所以 `verify:provider` 与 `verify:station` 必须**一起**跑。
 */
@Module({
  imports: [AuthModule],
  controllers: [ProviderController],
  providers: [ProviderService],
  exports: [ProviderService],
})
export class ProviderModule {}
