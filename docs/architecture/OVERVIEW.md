# 系统架构与代码分层

> 面向"新同学 / 第一次接手的人"。规范见 `../rules/DEVELOPMENT-STANDARDS.md`，
> 决策理由见 `DECISIONS.md`，完整设计见 `../product/青智校园_小程序详细设计文档_V2.md`。

## 一、后端在哪里

**后端主服务只有一个：`apps/api/`（NestJS）。**

| 位置 | 是什么 |
|---|---|
| `apps/api/src/main.ts` | 进程入口：全局前缀 + URI 版本、CORS、统一响应/异常、Swagger、优雅关闭 |
| `apps/api/src/app.module.ts` | 根模块：按 `common → infra → modules` 顺序装配 |
| `apps/api/src/common/` | HTTP 横切能力（配置、日志、装饰器、过滤器、拦截器、管道、中间件） |
| `apps/api/src/infra/` | 外部系统适配器（Prisma 数据库、Provider 能力集合） |
| `apps/api/src/modules/` | 业务模块（`auth` / `user` / `health`，后续按里程碑追加 `tool`、`job`、`file`、`os`、`station`、`order` …） |
| `apps/api/prisma/` | 数据模型 `schema.prisma` + `migrations/` + `seed.ts` |

`services/` 下的 `ai` 与 `media` 是**侧车服务**（Python），不是主后端：
它们不对外提供业务接口、不直连业务库，只被 `apps/api` 通过
`AI_SERVICE_URL`（默认 :8000）/ `MEDIA_SERVICE_URL`（默认 :8001）以 HTTP 调用。
之所以独立：Whisper / Demucs / PaddleOCR / rembg 只在 Python 生态成熟（ADR-08）。

## 二、运行时拓扑

```
                ┌────────────────────────────────────┐
                │  微信小程序  apps/mp               │  原生 + TS，Design Token
                │  （用仓库根 project.config.json 打开）│
                └─────────────────┬──────────────────┘
                                  │ HTTPS  /api/v1/*
        ┌─────────────────────────▼──────────────────────────┐
        │        后端主服务  apps/api   (NestJS)             │
        │   common/   配置 · 日志 · 过滤器 · 拦截器 · 管道    │
        │   infra/    Prisma + Provider 装配                 │
        │   modules/  auth · user · health · …               │
        └───────┬───────────────┬───────────────────┬────────┘
                │               │                   │ HTTP
   ┌────────────▼───┐   ┌───────▼────────┐   ┌──────▼─────────────────┐
   │ MySQL 8        │   │ Redis 7        │   │ services/ai   (:8000)  │
   │ 业务库 + 影子库 │   │ 缓存/限流/队列  │   │ services/media(:8001)  │
   └────────────────┘   └────────────────   └──────┬─────────────────┘
                                                    │
                ┌───────────────────────────────────▼──────┐
                │  MinIO / 云 OSS —— 对象存储（前端直传）  │
                └──────────────────────────────────────────┘

   共享库：packages/core（枚举·状态机·错误码·校验·Provider 接口·工具）
           packages/sdk （H5 / 管理后台用的跨端 API SDK）
   管理后台：apps/admin  （React + Vite，端口 5173，已完成）
```

## 三、代码归属判据

| 层 | 目录 | 允许依赖 | 禁止 |
|---|---|---|---|
| 共享业务核心 | `packages/core` | 仅 zod 与自身 | 端侧 API（`wx.*`、`req/res`、Prisma、Nest 装饰器） |
| 跨端 SDK | `packages/sdk` | `@qz/core` + fetch | 框架耦合（不依赖 React / Nest） |
| 后端 | `apps/api` | `@qz/core` + Nest + Prisma | 直接 `new` 第三方客户端（走 Provider） |
| 侧车 | `services/*` | `services/shared` + 标准库 | 把 shared 的代码复制进自己包内 |
| 前端 | `apps/mp` | `@qz/core` 的类型与规则 | 页面里直接 `wx.request` |
| 管理后台 | `apps/admin` | `@qz/core`（权限矩阵·校验）+ `@qz/sdk` + React | 自己推导"角色能做什么"（权限以后端返回为准） |

**为什么业务规则放 `packages/core` 而不是各端各写一份**：状态机、金额、错误码、校验规则
一旦两端不一致，就会出现"前端允许、后端拒绝"的死循环 bug。

## 四、Provider 抽象（红线 9 / 10 的落点）

```
packages/core/src/providers/types.ts                   接口定义（LlmProvider / ImageProvider / PptProvider …）
packages/core/src/providers/mock/                      纯内存 Mock 实现（name 以 mock- 开头）
apps/api/src/infra/providers/                          真实实现（sharp / openai-compatible / pptxgenjs）
apps/api/src/infra/providers/real-provider.factory.ts  按配置决定哪些能力已就绪
apps/api/src/infra/providers/providers.module.ts       createProviders(mode, real) → 全局注入
```

关键机制：**未就绪的能力自动回退 Mock**，所以系统在任何第三方 Key 缺失时都能完整启动；
但响应头一定带 `X-Provider: mock`，前端据此显示"演示模式"角标 ——
这就是"能跑"与"骗人"的分界线。

## 五、请求生命周期（后端）

```
Express 中间件（body 限额 + 保留 rawBody 供支付回调验签）
  → MockMarkerMiddleware      决定 X-Provider / X-Mock-Providers 响应头
  → JwtAuthGuard              @Public() 装饰的接口跳过
  → ZodValidationPipe         用 @qz/core 的 schema 校验入参
  → Controller → Service      业务编排，状态变更走 transition()
  → PrismaService / Provider  落库或调用外部能力
  → LoggingInterceptor        生成并写入 X-Trace-Id
  → TransformInterceptor      包装 { code: 0, message, data, traceId }
  → GlobalExceptionFilter     BizException / 状态机异常 / HttpException / 未知异常
```

契约细节见 `../api/README.md`；数据模型见 `../db/README.md`。

## 六、里程碑与模块的对应关系

| 里程碑 | 会新增的后端模块 | 对应前端 |
|---|---|---|
| M1 工具箱 | `modules/tool`、`modules/job`、`modules/file` | `pkg-toolbox/*`（已建） |
| M2 编排 | `modules/os`（会话、意图、规划、编排引擎） | `pages/os`、`pkg-os/*`（已建） |
| M3 驿站 | `modules/station`、`modules/order`、`modules/pay` | `pkg-station/*`（已建） |
| M4 音视频 | `modules/media` + `services/*` 真实实现 | 工具箱新增能力卡 |
| M4 词汇训练 | `modules/vocab`（词书 / SM-2 复习调度 / 判卷 / 统计 / 发音，M4-15） | `pkg-vocab/*`（已建） |
| M5 上线 | `modules/admin`（已建）、监控与限流加固 | `apps/admin`（已建） |

新增模块时照抄 `modules/user` 的三件套结构（module / controller / service），
并在 `app.module.ts` 的"业务模块"分组里注册。
