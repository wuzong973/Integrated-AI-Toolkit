import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { buildBillingPublicConfig, type PublicConfig } from '@qz/core';

import type { AppConfig } from '../../common/config/configuration';
import { Public } from '../../common/decorators';
import { BillingService } from '../billing/billing.service';

/**
 * 公开配置（`GET /config/public`）
 *
 * 客户端在**未登录**时也要能知道平台当前处于什么模式，因此这个接口是公开的。
 * 之所以不做成"把价格直接返回 0"，是因为那会丢掉工具标价：
 *   · 工具标价 `tool.price` 是**恢复计费后的依据**，必须原样保留；
 *   · 免费期仍照常记录 `tool_job.cost`，便于事后统计让利额度。
 * 于是"该不该显示价格"变成客户端的展示决策，依据就是本接口。
 *
 * ⚠️ 开关的**唯一真相**取自 `BillingService.enabled`，而不是这里再读一次环境变量。
 *    同一份配置在两处各读一次，迟早会出现"接口说免费、实际在扣费"这种最坏的不一致。
 */
@ApiTags('config')
@Controller('config')
export class PublicConfigController {
  constructor(
    private readonly config: ConfigService,
    private readonly billing: BillingService,
  ) {}

  @Public()
  @Get('public')
  @ApiOperation({ summary: '公开配置（当前含计费模式；未登录可访问）' })
  publicConfig(): PublicConfig {
    const app = this.config.get<AppConfig>('app')!;
    return {
      version: app.version,
      billing: buildBillingPublicConfig(this.billing.enabled),
    };
  }
}
