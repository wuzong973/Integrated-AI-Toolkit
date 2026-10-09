import 'reflect-metadata';

import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, urlencoded } from 'express';

import type { AppConfig } from './common/config/configuration';
import { splitApiPrefix } from './common/config/api-prefix';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { AppLogger } from './common/logger/logger.service';
import { AppModule } from './app.module';
import { JobProgressGateway } from './modules/job/job-progress.gateway';

/**
 * 应用启动入口（任务清单 M0-15）
 * - 全局前缀 /api/v1
 * - 统一响应体与异常处理
 * - 优雅关闭
 * - Swagger（非生产环境）
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  const config = app.get(ConfigService);
  const appCfg = config.get<AppConfig>('app')!;
  const logger = app.get(AppLogger);

  // 日志
  AppLogger.configure(appCfg.log);
  app.useLogger(logger);

  // 请求体（保留原始 body 供支付回调验签，文档 6.12.1）
  app.use(
    json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );
  app.use(urlencoded({ extended: true, limit: '2mb' }));

  // 全局前缀与版本：API_PREFIX="/api/v1" -> 前缀 "/api" + URI 版本 "1"（见 common/config/api-prefix.ts）
  const { prefix, version } = splitApiPrefix(appCfg.apiPrefix);
  app.setGlobalPrefix(prefix);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: version });

  // CORS（管理后台）
  app.enableCors({
    origin: appCfg.corsOrigins.length ? appCfg.corsOrigins : [appCfg.adminOrigin],
    credentials: true,
  });

  // 全局管道 / 拦截器 / 过滤器
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalInterceptors(new LoggingInterceptor(logger), new TransformInterceptor());
  app.useGlobalFilters(new GlobalExceptionFilter(logger));

  // Swagger（仅非生产）
  if (appCfg.env !== 'production') {
    const doc = new DocumentBuilder()
      .setTitle('青智校园 API')
      .setDescription('AI 驱动的高校智能服务与青年生产力协同平台 · 接口文档')
      .setVersion(appCfg.version)
      .addBearerAuth()
      .build();
    const factory = SwaggerModule.createDocument(app, doc);
    SwaggerModule.setup('docs', app, factory);
  }

  // 优雅关闭
  app.enableShutdownHooks();

  // 进度推送网关：挂在同一个 HTTP 服务器上（/ws?token=...），
  // 复用端口与证书，部署时不需要为 WebSocket 单开入口
  app.get(JobProgressGateway).attach(app.getHttpServer());

  await app.listen(appCfg.port, '0.0.0.0');
  logger.log(
    `青智校园 API 已启动：http://localhost:${appCfg.port}${appCfg.apiPrefix}`,
    'Bootstrap',
    {
      env: appCfg.env,
      providerMode: appCfg.providerMode,
      docs: appCfg.env !== 'production' ? `http://localhost:${appCfg.port}/docs` : undefined,
    },
  );
}

bootstrap().catch((err) => {
  // 启动失败必须立刻可见（尤其是环境变量缺失）
  process.stderr.write(`启动失败：${(err as Error).message}\n`);
  process.exit(1);
});
