import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { FileController } from './file.controller';
import { FileService } from './file.service';
import { LocalStorageController } from './local-storage.controller';

/**
 * 文件资产模块（任务清单 M0-12）
 *
 * imports: AuthModule —— JwtAuthGuard 依赖 AuthModule 里的 TokenService，
 *   不 import 会在启动时报 "Nest can't resolve dependencies of the JwtAuthGuard"。
 *   这是本项目所有需要登录的模块的固定写法（见 UserModule）。
 * 另依赖全局的 ProvidersModule（对象存储 Provider）与 PrismaModule。
 *
 * controllers:
 *   FileController          —— 业务接口（全部需登录）
 *   LocalStorageController  —— local 驱动的直传端点（令牌鉴权，非 local 驱动时 404）
 */
@Module({
  imports: [AuthModule],
  controllers: [FileController, LocalStorageController],
  providers: [FileService],
  exports: [FileService],
})
export class FileModule {}
