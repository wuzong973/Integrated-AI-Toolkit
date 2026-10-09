import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { MapController } from './map.controller';

/**
 * 地图 / 位置服务模块。
 *
 * ## 为什么必须 `imports: [AuthModule]`
 *
 * `JwtAuthGuard` 依赖 `AuthModule` 里的 `TokenService`，不导入会在**启动时**
 * 直接报 `Nest can't resolve dependencies of the JwtAuthGuard`
 * —— 这是本项目所有需要登录的模块的固定写法（见 `FileModule` / `UserModule`）。
 *
 * ## 为什么不注册任何 provider
 *
 * 地图能力由全局的 `ProvidersModule` 提供（`PROVIDERS` 令牌），
 * 这里只负责把 HTTP 入口挂上去。多注册一层 Service 只会多一层转发。
 */
@Module({
  imports: [AuthModule],
  controllers: [MapController],
})
export class MapModule {}
