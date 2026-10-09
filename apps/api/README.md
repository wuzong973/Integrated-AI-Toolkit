# apps/api —— 后端主服务（NestJS）

**整个项目唯一的业务后端。** 对外提供 `/api/v1/*`，对内编排 Provider 能力与侧车服务。
技术栈：NestJS 10 + Prisma 6（MySQL 8）+ Redis + zod + Swagger。

## 目录

```
apps/api/
├── src/
│   ├── main.ts                 # 进程入口：前缀/版本、CORS、全局管道·拦截器·过滤器、Swagger、优雅关闭
│   ├── app.module.ts           # 根模块：common → infra → modules 的装配顺序
│   ├── common/                 # HTTP 横切能力（换一个 HTTP 框架就要改它）
│   │   ├── config/             #   env.schema.ts（白名单+校验）、configuration.ts（分组装配）、api-prefix.ts
│   │   ├── decorators/         #   @Public @CurrentUser @Roles @IdempotencyKey
│   │   ├── filters/            #   global-exception.filter.ts（BizException / 状态机 / Http / 未知）
│   │   ├── interceptors/       #   logging（traceId） + transform（统一响应体）
│   │   ├── logger/             #   AppLogger（JSON/pretty + 脱敏） + trace.context
│   │   ├── middleware/         #   mock-marker.middleware.ts（红线 10 的 X-Provider 头）
│   │   └── pipes/              #   zod-validation.pipe.ts（复用 @qz/core 的 schema）
│   ├── infra/                  # 外部系统适配器（换一个外部服务就要改它）
│   │   ├── prisma/             #   PrismaService（连接重试 + 健康探针）
│   │   └── providers/          #   image/ llm/ ppt/ + real-provider.factory + providers.module
│   └── modules/                # 业务模块（一个领域一个目录）
│       ├── auth/               #   微信登录、JWT 签发与刷新、Guard
│       ├── user/               #   资料、多身份切换、信用、积分、钱包
│       └── health/             #   /health（版本、Provider 模式、依赖探活）
├── prisma/
│   ├── schema.prisma           # 数据模型（MySQL 8）
│   ├── migrations/             # 迁移（提交后不再编辑）
│   └── seed.ts                 # 演示数据
├── nest-cli.json  tsconfig.json  package.json
└── .env                        # 由 npm run setup:env 从仓库根 .env 复制（已 gitignore）
```

## 新增一个业务模块

照抄 `modules/user` 的三件套：

```
modules/<领域>/<领域>.module.ts        声明 controllers / providers
              <领域>.controller.ts     路由 + 装饰器（@UseGuards / @ApiTags / ZodValidationPipe）
              <领域>.service.ts        业务编排；状态变更走 @qz/core 的 transition()
              <领域>.service.spec.ts   单测
```

然后在 `src/app.module.ts` 的"业务模块"分组里注册。
外部能力**不要**在 service 里 `new`，注入 `PROVIDERS` 取（红线 9）。

## 本地跑

```bash
npm run setup:env     # 生成 .env 并同步到本目录（Prisma 只认 schema 同级目录）
npm run db:up         # MySQL / Redis / MinIO
npm run db:migrate    # 建表
npm run db:seed       # 演示数据
npm run dev:api       # http://localhost:3000/api/v1，Swagger 在 /docs
```

## 检查

```bash
npm run typecheck -w @qz/api
npm run smoke
curl http://localhost:3000/api/v1/health
```

## 约定与坑

- 业务代码禁止直接读 `process.env`，一律 `ConfigService.get<AppConfig>('app')`；
- 新增环境变量：`.env.example` → `common/config/env.schema.ts` → `docs/dev/ENV.md` 三处一起改；
- 布尔变量用 `envBoolean()`，**不要**用 `z.coerce.boolean()`（`Boolean('false') === true`）；
- 依赖 `@qz/core` 的 `dist`：改过 `packages/core` 后先 `npm run clean && npm run build`；
- 侧车地址由 `AI_SERVICE_URL` / `MEDIA_SERVICE_URL` 给出，见 `../../services/README.md`。
