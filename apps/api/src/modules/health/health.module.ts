import { Module } from '@nestjs/common';

import { JobModule } from '../job/job.module';

import { HealthController } from './health.controller';

/**
 * 健康检查模块
 *
 * imports: JobModule —— 仅为了读取进度推送网关的连接数（/health 的 realtime 字段）。
 * 健康检查本来就是"如实反映各依赖状态"的地方，把实时通道的可观测性放进来是合理的；
 * 方向也不会成环（JobModule 不依赖 HealthModule）。
 */
@Module({
  imports: [JobModule],
  controllers: [HealthController],
})
export class HealthModule {}
