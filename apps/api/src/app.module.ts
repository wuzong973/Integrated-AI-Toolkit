import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule, seconds } from '@nestjs/throttler';

import { buildConfig, type AppConfig } from './common/config/configuration';
import { ENV_FILE_PATHS } from './common/config/paths';
import { getValidatedEnv, validateEnv } from './common/config/env.schema';
import { LoggerModule } from './common/logger/logger.module';
import { MockMarkerMiddleware } from './common/middleware/mock-marker.middleware';
import { ProvidersModule } from './infra/providers/providers.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { AdminModule } from './modules/admin/admin.module';
import { BillingModule } from './modules/billing/billing.module';
import { FileModule } from './modules/file/file.module';
import { JobModule } from './modules/job/job.module';
import { HealthModule } from './modules/health/health.module';
import { KnowledgeModule } from './modules/knowledge/knowledge.module';
import { MapModule } from './modules/map/map.module';
import { ModerationModule } from './modules/moderation/moderation.module';
import { NotificationModule } from './modules/notification/notification.module';
import { OrderModule } from './modules/order/order.module';
import { OsModule } from './modules/os/os.module';
import { ProviderModule } from './modules/provider/provider.module';
import { PublicConfigModule } from './modules/config/public-config.module';
import { ServiceModule } from './modules/service/service.module';
import { StationModule } from './modules/station/station.module';
import { ToolModule } from './modules/tool/tool.module';
import { UserModule } from './modules/user/user.module';
import { PracticeModule } from './modules/practice/practice.module';
import { VocabModule } from './modules/vocab/vocab.module';

/**
 * 根模块（任务清单 M0-15）
 * 模块划分与文档 3.3 / 3.5 一致；后续里程碑按模块继续追加。
 *
 * src 分层约定（详见 docs/architecture/overview.md）：
 *   common/  跨模块的 HTTP 横切能力：配置、日志、装饰器、过滤器、拦截器、管道、中间件
 *   infra/   外部系统适配器：Prisma、对象存储，以及 LLM / 图片 / PPT 等 Provider
 *   modules/ 业务模块：每个模块 = controller + service + module
 */
@Module({
  imports: [
    // 配置：启动期强校验，任一分组缺失即拒绝启动；业务侧统一用 ConfigService 读取
    // ⚠️ envFilePath 必须是**锚定过的绝对路径**：相对路径按 process.cwd() 解析，
    //    会让「cd apps/api 启动」与「仓库根启动」读到两份不同的 .env（详见 configuration.ts）。
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ENV_FILE_PATHS,
      validate: validateEnv,
      load: [() => ({ app: buildConfig(getValidatedEnv()) })],
    }),

    // 限流（配置项 THROTTLE_TTL 秒 / THROTTLE_LIMIT 次）
    // ⚠️ 只 import 本模块不会生效，必须同时把 ThrottlerGuard 注册为全局守卫（见下方 providers）。
    //    这条曾经漏掉，导致 THROTTLE_* 配置项形同虚设。
    // ⚠️ 生产部署在 nginx 之后时必须开启 Express 的 trust proxy，
    //    否则所有请求都会被识别为同一个代理 IP，限流将误伤全体用户。
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const app = config.get<AppConfig>('app')!;
        // v5+ 的 ttl 单位是毫秒，用 seconds() 换算，避免把 60 当成 60 毫秒
        return [{ ttl: seconds(app.throttle.ttl), limit: app.throttle.limit }];
      },
    }),

    LoggerModule,
    PrismaModule,
    RedisModule,
    ProvidersModule,
    // 内容安全关卡（M4-05，红线）：@Global，所有 UGC 写入口注入 ModerationService 即可用。
    // ⚠️ 注册模块本身**不会**审核任何内容 —— 它只提供关卡，接线在各业务 service 里。
    ModerationModule,

    // 业务模块
    HealthModule,
    AuthModule,
    UserModule,
    ToolModule,
    FileModule,
    JobModule,
    // 驿站：任务大厅 + 详情 + 写路径（发布 / 报名 / 选定 / 关闭 / 匹配）
    StationModule,
    // 服务者入驻认证（M3-02）：把普通用户变成 provider —— 与 StationModule 的
    // `assertIsProvider` 是**成对的**，少了任何一边都会出问题（见 ProviderModule 注释）
    ProviderModule,
    // 订单与担保支付（M3-11/12/14/15）：状态机 + Mock 支付链路已跑通，接真实支付只换 Provider
    OrderModule,
    // 站内消息与会话（M3-19）：@Global —— 订单与驿站共 7 个业务动作要扇出通知
    // （搜 `notifications.notify(tx` 即是全部接线点）。少接一处不会报错，
    // 只会"做完了没人收到通知"，所以不让业务模块各自 import 它。
    NotificationModule,
    // 服务商品（M3-04）：驿站「服务市场」Tab 的数据源。上架权限与 M3-02 的
    // `user_role(provider)` 成对 —— 认证通过却上不了架，与"没认证却能上架"是同一类断裂
    ServiceModule,
    // 账务（M1-06 积分计费 + M3-13 钱包提现）。
    // Tool/Job/PublicConfig 也 import 了它，"顺带"就会把 WalletController 注册上 ——
    // 但**对外 HTTP 面**不该靠兄弟模块的传递引用来成立：哪天谁去掉一行 imports，
    // /wallet/withdrawals 就静默 404。所以在此显式登记（与 Station/Order 等同一层）。
    BillingModule,
    OsModule,
    // 校园知识库 RAG（M4-06）：向量化的真实调用点
    KnowledgeModule,
    MapModule,
    // 公开配置（含积分计费开关的对外呈现）
    PublicConfigModule,
    // 管理后台（M0-23）：账号密码登录 + RBAC 权限点 + 用户/审核/工具作业/订单/看板。
    // 单向依赖业务模块（AdminModule → Job/Order/Provider），业务模块不得反向依赖它。
    AdminModule,
    // 记单词 / 四六级词汇训练（M4-15）：词书 + SM-2 复习调度 + 打卡日历 + 单词发音。
    // 词条由离线脚本生成（`npm run db:gen-words`），不在接口里调 LLM ——
    // 背单词时"每次点开都等模型返回"是不可用的
    VocabModule,
    // 练习中心（M4-16）：句子练习 / 口语跟读 / 作文练习三模块。
    // 与 VocabModule 并列而不是合并：词汇的题目来源是"词书里的词"，
    // 练习中心的题目来源是"语料库里的句子与人工题库"，两者的进度表、
    // 统计口径、入口都不同（详见 `practice.module.ts` 与 `practice.dto.ts` 的说明）。
    // 跟读的判分走服务端 ASR + 词级对齐（纯逻辑在 `@qz/core`），
    // 作文批改走 LLM 单次结构化调用（失败降级，不阻断提交）
    PracticeModule,
  ],
  providers: [
    // 全局限流守卫（顺序敏感：必须在所有业务守卫之前，越权校验之前先挡掉刷接口）
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  /** 红线 10：所有响应都标注 Provider 模式（mock / real） */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(MockMarkerMiddleware).forRoutes('*');
  }
}
