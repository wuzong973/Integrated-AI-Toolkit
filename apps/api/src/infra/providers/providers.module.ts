import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createProviders, type Providers } from '@qz/core';

import type { AppConfig } from '../../common/config/configuration';

import { RealProviderFactory } from './real-provider.factory';

/** 注入令牌 */
export const PROVIDERS = Symbol('PROVIDERS');

/**
 * Provider 模块（任务清单 M0-08，红线 9）
 * 根据 PROVIDER_MODE 组装 Provider 集合并全局注入。
 */
@Global()
@Module({
  providers: [
    {
      provide: PROVIDERS,
      inject: [ConfigService, RealProviderFactory],
      useFactory: (config: ConfigService, realFactory: RealProviderFactory): Providers => {
        const app = config.get<AppConfig>('app')!;
        return createProviders(app.providerMode, realFactory.build(app));
      },
    },
    RealProviderFactory,
  ],
  exports: [PROVIDERS],
})
export class ProvidersModule {}
