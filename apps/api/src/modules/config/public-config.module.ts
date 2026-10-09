import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';

import { PublicConfigController } from './public-config.controller';

/**
 * 公开配置模块
 *
 * imports: BillingModule —— 只为读 `BillingService.enabled` 这一个开关。
 * 这样"是否扣费"与"客户端显示免费还是价格"来自**同一个真相**，
 * 不会出现接口说免费、后端实际在扣费的不一致。
 *
 * 与 `common/config` 的区别：那边是**服务端自己的环境配置**（不对外）；
 * 这边是**可以公开给所有用户的配置**（后续可扩展公告、强制更新等）。
 */
@Module({
  imports: [BillingModule],
  controllers: [PublicConfigController],
})
export class PublicConfigModule {}
