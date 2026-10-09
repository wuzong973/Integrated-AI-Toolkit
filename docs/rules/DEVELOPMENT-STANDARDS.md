# 开发规范（唯一权威版本）

> 本文件是工程约束的**单一事实来源**。`AGENTS.md`、`.cursor/rules/project-conventions.mdc`、
> `README.md` 第七章都只做指针，改规范只改这里。
> 需求与设计见 `../product/青智校园_小程序详细设计文档_V2.md`，任务拆分见 `../product/青智校园_开发任务清单.md`。

---

## 一、十条开发红线（任何改动都必须满足）

| # | 红线 | 怎么验证 |
|---|---|---|
| 1 | 核心流程**真正可运行** —— 首版只做 3 条主链路，但必须端到端跑通 | `npm run smoke` + 手工走一遍 L1/L2/L3 |
| 2 | **UI 现代完整** —— 样式一律走 Design Token，禁止硬编码色值 | `tokens.scss` 之外不出现 `#RRGGBB` |
| 3 | **前后端真实联通** —— 禁止本地假数据 | 首页状态条显示「后端已连接 · v… · DB up」 |
| 4 | **数据库真实工作** —— 所有状态落库，禁止内存态模拟 | `npm run db:studio` 能看到写入 |
| 5 | **AI 功能真实调用** —— 必须产出真实文件 | 下载得到的 .pptx 能打开且页数正确 |
| 6 | **Demo 可完整演示** | 见 `../product/青智校园_开发任务清单.md` 的 Demo 脚本 |
| 7 | **可部署上线** —— 全容器化、配置外置、无本地绝对路径 | 代码里不出现 `D:\\` / `C:\\` 之类字面量 |
| 8 | **代码结构清晰** —— 单文件 ≤ 300 行、函数 ≤ 50 行、禁 `any` | `npm run lint`（ESLint 强制） |
| 9 | **模块可独立替换** —— 所有外部依赖走 Provider 抽象层 | 业务代码不 `new` 第三方 SDK |
| 10 | **禁止假数据冒充功能** —— Mock 必须显式可辨 | 响应头 `X-Provider: mock` + 界面"演示模式"角标 |

红线 8 由 `.eslintrc.cjs` 机器强制；红线 10 由 `apps/api/src/common/middleware/mock-marker.middleware.ts`
与 `apps/mp/utils/request.ts`（`markDemoMode`）共同保证。

---

## 二、架构约束

- 业务规则写在 `packages/core`（纯 TS，**不得 import 任何端侧 API**），小程序 / H5 / 后端共用；
- 后端只依赖 `@qz/core` 暴露的接口，外部能力一律经 `ProviderFactory` 装配；
- 状态变更必须走 `packages/core/src/state-machine` 的 `transition()`，禁止直接赋值状态字段；
- 金额一律用「分」的整数（`packages/core/src/utils/money.ts`），禁止浮点；
- 时间对外输出 ISO8601；
- 校验规则前后端共用 `packages/core/src/validators` 的 zod schema，后端用 `ZodValidationPipe` 执行；
- 错误码只在 `packages/core/src/errors/codes.ts` 定义，新增必须同步 `docs/dev/ERROR_CODES.md`。

### 接口与 HTTP 状态码约定

> **起因**：小程序请求层曾写死 `statusCode === 200`，而 NestJS 对 `@Post()` 默认返回 **201 Created**，
> 于是所有 POST（含登录）的成功响应都被前端判为失败，错误文案还取自成功响应里的 `message`（即字符串 `"ok"`），
> 用户看到一个写着 "ok" 的报错、排查时极具误导性。详见 `docs/dev/ERROR-TRIAGE.md` 第 1.5 节。

| 项 | 约定 |
|---|---|
| 响应体 | 一律 `{ code, message, data, traceId }`（文档 9.1）；**`code === 0` 才代表业务成功** |
| 成功 | **任意 2xx**。`GET`/`PUT`/`DELETE` 为 200，`POST` 默认 201，都合法 |
| 业务错误 | 4xx + 业务码（`code` 为 `4xxxx`） |
| 系统错误 | 5xx。**数据库不可用应返回 503 + 明确错误码，不得笼统返回 500** |
| 客户端判定 | **必须用 `statusCode >= 200 && statusCode < 300`，禁止 `=== 200`** |

- 小程序侧统一走 `apps/mp/utils/request.ts` 的 `isHttpSuccess()`，**不要在各页面自己判断状态码**；
- 后端**不要**为了迁就前端而给所有 `@Post()` 加 `@HttpCode(200)` —— 201 符合 HTTP 语义，
  正确的做法是让客户端接受整个 2xx 区间；
- `/health` 豁免限流（`@SkipThrottle()`）：它是监控与探针的基础设施流量，被限流会造成
  "服务不健康"的误报，且它是只读接口没有刷的必要。

---

## 三、目录与命名规范

### 3.1 顶层分层

| 目录 | 装什么 | 判据 |
|---|---|---|
| `apps/` | 可独立运行的应用 | 有自己的 `package.json`，能被启动或上传 |
| `packages/` | 跨端共享库 | 不启动、不部署，只被 import |
| `services/` | Python 侧车服务 | 需要 Python 生态（模型 / 音视频） |
| `scripts/` | 仓库级工具 | 不随应用部署，只在开发 / CI 里跑 |
| `docs/` | 说明性文档 | 解释"做什么 / 为什么"，不含可执行逻辑 |
| `logs/` | 本地运行日志 | 已 gitignore，任何日志都别写进仓库根 |

**仓库根只允许放工程入口文件**：`package.json`、`package-lock.json`、`tsconfig.base.json`、
`vitest.config.ts`、`.eslintrc.cjs`、`.prettierrc`、`.prettierignore`、`.editorconfig`、`.gitignore`、
`commitlint.config.cjs`、`docker-compose.yml`、`project.config.json`、`.env.example`、`README.md`、`AGENTS.md`。
新增别的文件，请先归类到上面的目录里。

### 3.2 通用命名

- 目录与文件名一律**小写短横线**（`state-machine`、`jwt-auth.guard.ts`）；
  例外：`README.md` 等约定俗成的大写文件名、`docs/` 下的大写主题文档、产品侧中文文档；
- 不使用拼音缩写、不使用 `.bak` / 「副本」/ `_final2` 这类后缀 —— 历史交给 git；
- 空目录不留占位。要建目录，就连同第一个文件一起建。

### 3.3 后端（`apps/api/src`）

| 层 | 内容 | 命名 |
|---|---|---|
| `common/` | HTTP 横切：config / logger / decorators / filters / interceptors / pipes / middleware | 文件用 `<主题>.<角色>.ts`，如 `global-exception.filter.ts` |
| `infra/` | 外部系统适配器：`prisma/`、`providers/<能力>/` | Provider 实现叫 `<技术>-<能力>.provider.ts` |
| `modules/<领域>/` | 业务模块 | `<领域>.module.ts` / `.controller.ts` / `.service.ts`；一个领域一个目录 |
| 测试 | 与被测代码同目录 | `<文件名>.spec.ts` |

判据：**换一个外部服务就要改它** → `infra/`；**换一个 HTTP 框架就要改它** → `common/`；
**换一个业务规则不用改它** → `modules/`。

### 3.4 小程序（`apps/mp`）

- 一个页面一个目录，目录内固定四件套：`index.ts` / `index.wxml` / `index.scss` / `index.json`；
- 主包页面放 `pages/<模块>/`；辅助页（登录、H5 容器）放 `pages/common/<用途>.*`；
- 分包目录统一 `pkg-<模块>/`，且必须在 `app.json` 的 `subpackages` 与 `preloadRule` 里登记；
- 路由以 `app.json` 为唯一来源，页面跳转写 `/pages/<模块>/index`，不要自己拼前缀；
- 请求一律走 `utils/request.ts`，禁止在页面里直接 `wx.request`；
- 新增共享组件时才建 `components/<组件名>/`（不要提前建空目录）；
- **测试文件禁止放在 `apps/mp/` 内** —— `miniprogramRoot` 就是 `apps/mp/`，
  它**就是发布包**。包内任何没被引用到的文件都会被开发者工具的「过滤无依赖文件」分析点名
  （控制台报「xxx 目录下的所有文件将会被忽略」），并有被误打包的风险。
  → 小程序的测试放 `tests/mp/`（`vitest.config.ts` 已覆盖该目录）。
- **异步回调式的 `wx.*` API 必须传 `fail` 回调**（传感器、支付、授权、设备类都是）。
  不传 `fail` 时 SDK 会把失败当成**未捕获异常**打印成红色 `appServiceSDKError` + 堆栈
  （例如 `startDeviceMotionListening` 在开发者工具里必然失败），
  噪音会淹没真正的报错、看起来像代码崩了。可选能力（动效、震动等）在 `fail` 里**静默降级**，
  但业务能力（支付、授权）必须在 `fail` 里给出可执行的下一步。

### 3.5 Python 侧车（`services`）

- 公共代码进 `services/shared/`，**禁止在两个服务里各抄一份**；
- 服务包固定结构：`__main__.py`（入口）+ `settings.py`（配置）+ `routes.py`（端点表）+ `requirements.txt`；
- 一律用 `python -m services.<name>` 启动（`npm run dev:ai` 已封装解释器探测）；
- 遵循 PEP8、4 空格缩进（`.editorconfig` 已声明，prettier 不管 Python）。

### 3.6 文档（`docs`）

- 每个目录一个 `README.md` 做索引；主题文档用大写短横线英文名；
- 一个文档只讲一个主题，超过约 400 行拆分；
- 路径引用一律用仓库相对路径（`scripts/db/init-db.sql`），不写绝对路径。

---

## 四、代码风格

- TypeScript `strict` 全开（`tsconfig.base.json`），禁止 `any`，未知类型用 `unknown` + 收窄；
- Prettier：单引号、分号、100 列、尾逗号、2 空格、LF（`.prettierrc`）；
- 优先 `const`，禁止 `==`，未用参数以 `_` 前缀；
- 导入顺序：内置 → 外部 → 内部包（`@qz/*`）→ 父级 → 同级 → index，组间空一行；
- 每个模块文件头部写一句"职责 + 对应任务编号"，复杂取舍必须写明**为什么**
  （参考 `apps/api/src/main.ts`、`packages/core/src/errors/index.ts`）；
- 注释与提交信息用中文，标识符用英文。

---

## 五、配置与环境变量

- `.env.example` 是**唯一模板**，位于仓库根；`apps/api/.env` 由 `npm run setup:env` 生成（已 gitignore）；
- 新增环境变量必须同时改三处：`.env.example` → `apps/api/src/common/config/env.schema.ts`
  → `docs/dev/ENV.md`；Python 侧再改 `services/shared/config.py`；
- 业务代码禁止直接读 `process.env`，统一走 `ConfigService` + `AppConfig` 分组；
- 布尔型变量不要用 `z.coerce.boolean()`（`Boolean('false') === true`），用 `envBoolean()`；
- 密钥、私钥、Token 一律不入库、不贴聊天记录；生产必须 `LOG_MASK_SENSITIVE=true`。

**限流的部署前提**：`THROTTLE_TTL` / `THROTTLE_LIMIT` 由 `ThrottlerModule` + 全局 `ThrottlerGuard` 生效
（只 import 模块不注册守卫等于没开）。它按客户端 IP 计数，因此**部署在 nginx / 网关之后时
必须开启 Express 的 `trust proxy`**，否则所有请求都会被识别为同一个代理 IP，
限流会误伤全体用户（表现为上线后大面积 429）。开启前请确认代理会覆写 `X-Forwarded-For`，
避免客户端伪造 IP 绕过限流。

---

## 六、测试

- 框架 vitest，测试文件与被测代码同目录，命名 `*.spec.ts`；
  **唯一例外是小程序**：它的测试放 `tests/mp/`（原因见 3.4 的最后两条）；
- 覆盖率重点：`packages/core`（状态机、金额、脱敏、ID）与 `apps/api/src/common`；
- **改了状态机 / 计费 / 校验规则必须补用例**，用例要覆盖非法迁移与边界；
- **同一份逻辑存在两份实现时（例如小程序侧的镜像），必须有"漂移守卫"测试**：
  把两份实现在同一组输入上跑并逐条比对结论。靠"记得同步改"是靠不住的；
- 假对象只能验证"对协议/回复形状的假设"。**协议层的正确性要靠真实协议实现**
  （如 `apps/api/src/infra/providers/queue/__tests__/fake-redis-stream-server.ts` 讲真实 RESP、
  经真实 ioredis 连接）或真机服务；假 Prisma 只识别语句形状，原生 SQL 必须另配真实数据库脚本
  （`scripts/dev/verify-*.mjs`）；
- 不测框架本身（Nest / Express 的行为交给集成冒烟 `npm run smoke`）。

---

## 七、Git 与提交

- Conventional Commits：`feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `build` / `ci` / `chore` / `revert`；
- 标题带任务编号：`feat(api): 订单担保支付回调验签 (M3-04)`；
- 分支用 `codex/` 或 `feature/` 前缀；一个 PR 只做一件事；
- 钩子由 husky 安装（`.husky/`）：`pre-commit` 跑 lint-staged，`commit-msg` 跑 commitlint；
- PR 按 `.github/PULL_REQUEST_TEMPLATE.md` 填写，第一题就是"服务哪条主链路"——
  **不服务 L1/L2/L3 的任务不进首版**。

---

## 八、合规

- 引入任何新依赖（npm / pip / 模型权重 / 字体 / 图标）前，先在
  `docs/compliance/OPEN_SOURCE_LICENSES.md` 登记名称、许可证、用途、结论；
- AGPL / GPL 组件只能独立部署、经 HTTP 调用（ADR-05），绝不链接进 `apps/` 或 `services/`；
- FFmpeg 必须 LGPL 构建：`npm run check:ffmpeg`；
- 模型权重注意"代码许可 ≠ 权重许可"（ADR-12，因此不用 UVR）。
