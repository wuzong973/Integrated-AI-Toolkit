# 青智校园 · QingZhi Campus

> **AI 驱动的高校智能服务与青年生产力协同平台**
> Slogan：让 AI 理解需求，让青年创造价值

「青智校园」把「AI 能干的活」和「只有人能干的活」放进同一个任务流里统一编排：

```
用户提出目标 → AI 理解需求 → 拆解任务
  ├─ 能由 AI 完成的 → 调用 AI 工具（真实产出 pptx / docx / pdf / 图片 …）
  └─ 必须真人完成的 → 发布到青智驿站，匹配同学接单
→ 结果验收 → 评价 → 更新技能画像与信用 → 反哺下一次匹配
```

**三条首版主链路**

| 编号 | 链路 | 验收标准 |
|---|---|---|
| **L1** | 一句话 → 真实文件 | 60s 内产出**可下载、可打开、可再编辑**的 `.pptx`，页数误差 ≤ ±2 |
| **L2** | AI 编排 + 人力协同 | 输入复杂需求 → 生成 ≥8 节点计划，AI 自动完成 ≥5 项，≥3 个人力节点可一键发布到驿站 |
| **L3** | 服务交易闭环 | 发布 → 担保支付 → 交付 → 验收 → 评价，资金验收后放款 |

---

## 一、代码在哪里（先看这张表）

| 我要找… | 去这里 |
|---|---|
| **后端主服务（业务 API / BFF）** | **`apps/api/`** —— NestJS 应用，源码 `apps/api/src/`，数据库 Schema `apps/api/prisma/` |
| 后端里的 AI / 图片 / PPT 能力实现 | `apps/api/src/infra/providers/` |
| 后端侧车服务（Python：OCR / ASR / 抠图 / 音视频） | `services/ai/`、`services/media/` |
| 小程序前端 | `apps/mp/` |
| 管理后台 | `apps/admin/`（预留，任务清单 M0-23） |
| 前后端共用的业务逻辑（枚举 / 状态机 / 错误码 / 校验 / 金额工具） | `packages/core/` |
| 跨端 API SDK（H5 / 后台用） | `packages/sdk/` |
| 产品需求、设计文档、任务清单 | `docs/product/` |
| 架构与决策（ADR） | `docs/architecture/` |
| 编码规范与十条红线 | `docs/rules/`（`AGENTS.md` 是它的 AI 协作者入口） |

> **后端只有一个主服务**：`apps/api`（NestJS）。
> `services/` 下的两个 Python 程序是它的**侧车**（AI / 媒体能力），不对外提供业务接口，
> 只被 `apps/api` 通过 `AI_SERVICE_URL` / `MEDIA_SERVICE_URL` 以 HTTP 调用。

---

## 二、目录结构

```
qingzhi-campus/
├── apps/                         # 可独立运行的应用（每个子目录一个 package.json）
│   ├── api/                      # ★ 后端主服务 · NestJS + Prisma
│   │   ├── src/
│   │   │   ├── common/           #   横切能力：config / logger / decorators /
│   │   │   │                     #   filters / interceptors / pipes / middleware
│   │   │   ├── infra/            #   外部系统适配器：prisma / providers(image,llm,ppt)
│   │   │   ├── modules/          #   业务模块：auth / user / health（controller+service+module）
│   │   │   ├── app.module.ts     #   根模块（分层装配顺序见文件头注释）
│   │   │   └── main.ts           #   启动入口（前缀/版本/CORS/Swagger/优雅关闭）
│   │   ├── prisma/               #   schema.prisma + migrations/ + seed.ts
│   │   └── nest-cli.json
│   ├── mp/                       # 微信小程序（原生 + TypeScript）
│   │   ├── app.ts / app.json / app.scss
│   │   ├── pages/                #   主包页面（5 个 TabBar 页 + common 辅助页）
│   │   ├── pkg-toolbox/          #   分包：工具执行 / 结果 / 我的文件
│   │   ├── pkg-station/          #   分包：驿站、任务、发布、订单、服务者
│   │   ├── pkg-os/               #   分包：编排看板 / 交付结果
│   │   ├── pkg-mine/             #   分包：钱包 / 信用 / 认证 / 设置
│   │   ├── styles/               #   Design Token（tokens.scss / theme-dark.scss）
│   │   ├── utils/                #   请求层 SDK（token/刷新/幂等/Mock 标记）
│   │   ├── typings/              #   全局类型（miniprogram-api-typings + IAppOption）
│   │   └── assets/icons/         #   TabBar 图标
│   └── admin/                    # 管理后台（React + Vite，M0-23 落地；当前为占位说明）
│
├── packages/                     # 跨端共享库（纯 TS，不含任何端侧 API）
│   ├── core/                     # ★ 业务核心：enums / errors / state-machine /
│   │                             #   validators / utils / providers(接口 + Mock)
│   └── sdk/                      # 跨端 API SDK（H5、管理后台用）
│
├── services/                     # Python 侧车服务
│   ├── shared/                   #   公共配置 / 结构化日志 / HTTP 骨架（两个服务共用）
│   ├── ai/                       #   OCR / ASR / 抠图 / 人声分离（M0-21 骨架）
│   └── media/                    #   FFmpeg 音视频处理（M0-21 骨架）
│
├── docs/
│   ├── product/                  # 需求与设计（详细设计 V2、任务清单、仓库清单…）
│   │   ├── archive/              #   已废弃版本（只读留档）
│   │   └── export/               #   由 npm run docs:docx 生成的二进制
│   ├── architecture/             # 架构总览、ADR 索引、PG→MySQL 迁移记录
│   ├── api/                      # 接口契约（统一响应体、版本、幂等、鉴权）
│   ├── db/                       # 数据模型与迁移约定
│   ├── dev/                      # 环境变量、错误码、开发者工具导入指引
│   ├── rules/                    # ★ 编码规范与十条红线（唯一权威版本）
│   └── compliance/               # 开源许可台账
│
├── scripts/
│   ├── db/                       # init-db.sql（Docker 首次初始化）、mysql-bootstrap.sql
│   ├── dev/                      # setup-env.mjs、smoke.mjs、run-python.mjs、clean.mjs
│   ├── docs/                     # md2docx.py（文档导出）
│   └── license/                  # license_audit.py、check-ffmpeg-license.sh
│
├── .github/                      # CI 工作流 + PR 模板
├── .husky/                       # Git 钩子（pre-commit → lint-staged，commit-msg → commitlint）
├── logs/                         # 本地运行日志（已 gitignore）
│
├── project.config.json           # ★ 微信开发者工具入口：miniprogramRoot 指向 apps/mp/
├── docker-compose.yml            # MySQL 8 + Redis 7 + MinIO
├── tsconfig.base.json            # TS 编译基线（各 app / package 继承它）
├── vitest.config.ts              # 全仓单测入口
├── .eslintrc.cjs                 # 规范红线（≤300 行 / ≤50 行 / 禁 any）
├── .env.example                  # 唯一环境变量模板
└── AGENTS.md                     # AI 协作者入口（指向 docs/rules/）
```

### 分层规则（新增代码时按这个顺序判断落点）

1. **能被两端复用的业务规则** → `packages/core`（纯 TS，禁止 import 任何端侧 API）
2. **只有后端需要的能力** → `apps/api/src/modules/<领域>`（业务）/ `infra/`（外部系统适配）/ `common/`（HTTP 横切）
3. **只有小程序需要的东西** → `apps/mp/`
4. **需要 Python 生态的能力（模型、音视频）** → `services/<服务>`
5. **仓库级工具（不随应用部署）** → `scripts/<类别>`
6. **说明"为什么这么做"的文字** → `docs/`

---

## 三、环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20（实测 24.19 可用） | 后端与工具链 |
| npm | ≥ 10（实测 11.17 可用） | 使用 npm workspaces |
| Python | ≥ 3.11（实测 3.12 / 3.13 可用） | 侧车服务与合规脚本；Windows 上 `py` 启动器亦可 |
| MySQL | 8.0+（Docker 用 8.4） | 主数据库（原 PostgreSQL 16，见 `docs/architecture/DB-MIGRATION-POSTGRES-TO-MYSQL.md`） |
| Redis | 7 | 缓存 / 限流 / 队列 |
| MinIO 或云 OSS | — | 对象存储 |
| 微信开发者工具 | 最新稳定版 | **打开仓库根目录**，详见 `docs/dev/WECHAT-DEVTOOLS.md` |

> **Docker 说明**：`docker-compose.yml` 用于一键启动 MySQL / Redis / MinIO。
> 本机若未安装 Docker，请自行安装 MySQL 8.0+ + Redis 7，先执行一次
> `mysql -u root -p < scripts/db/mysql-bootstrap.sql` 建库建账号，
> 再相应修改 `.env` 的 `DATABASE_URL` / `SHADOW_DATABASE_URL` / `REDIS_URL`。

---

## 四、快速开始（5 步）

```bash
# ① 安装依赖（同时安装 Git 钩子）
npm install

# ② 生成环境文件（从 .env.example 复制，并同步一份给 Prisma）
npm run setup:env
#    然后按需填写：JWT_SECRET（必填）、WECHAT_SECRET、LLM_API_KEY 等
#    逐项说明见 docs/dev/ENV.md

# ③ 启动基础设施（MySQL / Redis / MinIO）
npm run db:up

# ④ 建表 + 灌入演示数据
npm run db:migrate       # 应用 prisma/migrations 下的初始迁移
npm run db:seed          # 1 管理员 + 3 演示用户 + 45 个工具条目（可见 37 + Agent 内部 8）

# ⑤ 启动后端
npm run dev:api          # http://localhost:3000/api/v1
```

验证后端：

```bash
curl http://localhost:3000/api/v1/health
npm run smoke            # 期望输出"结果：通过"（退出码 0）
```

启动侧车服务（可选，骨架阶段只提供 /health）：

```bash
npm run dev:ai           # http://127.0.0.1:8000/health
npm run dev:media        # http://127.0.0.1:8001/health
```

### 打开小程序

**用微信开发者工具导入仓库根目录**（不是 `apps/mp`）——
根目录 `project.config.json` 的 `miniprogramRoot` 已指向 `apps/mp/`。
完整步骤与常见报错见 `docs/dev/WECHAT-DEVTOOLS.md`。

编译后应看到：首页 5 个 TabBar 页可切换；首页「后端已连接 · v0.1.0 · DB up」状态条
—— **这就是前后端真实联通的证据**。

---

## 五、常用命令

| 命令 | 作用 |
|---|---|
| `npm run lint` | 代码规范（含单文件 ≤300 行、禁 `any`；覆盖 .ts/.tsx/.mjs） |
| `npm run typecheck` | 全量类型检查（core → sdk → api → 小程序） |
| `npm test` | 单元测试（状态机 / 金额 / 脱敏 / ID / 环境变量 / 校验管道） |
| `npm run build` | 构建 core → sdk → api |
| `npm run clean` | 清掉所有 dist 与 tsbuildinfo（改过 `packages/` 之后建议先跑一次） |
| `npm run dev:api` | 启动后端（watch 模式） |
| `npm run dev:ai` / `dev:media` | 启动 Python 侧车服务 |
| `npm run db:up` / `db:down` | 启停 MySQL / Redis / MinIO |
| `npm run db:migrate` / `db:deploy` | 开发期迁移 / 生产部署迁移 |
| `npm run db:seed` / `db:studio` | 灌演示数据 / 可视化看库 |
| `npm run smoke` | 冒烟测试（断言 `/health`） |
| `npm run setup:env` | 生成并同步 `.env` |
| `npm run license:audit` | 核查依赖 License |
| `npm run check:ffmpeg` | 断言 FFmpeg 为 LGPL 构建（需 bash） |
| `npm run docs:docx` | 把 Markdown 设计文档导出为 .docx |

---

## 六、当前完成度（对照任务清单）

| 里程碑 | 范围 | 状态 |
|---|---|---|
| **M0 底座** | 仓库骨架、TS 基线、规范、CI、配置/日志/错误/Provider、数据库 Schema、微信登录、小程序骨架、Design Token、请求层 SDK | ✅ **已完成**（含冒烟通过） |
| M1 工具箱 | 工具元数据、Job 体系、AI PPT / 文档 / 图片 / OCR、文件资产、结果页 | 🟡 **框架与关键链路已就绪**（PPT 真实产出、Sharp 真实处理已可用；队列 Worker 与对象存储直传待接） |
| M2 编排 | 会话、意图、规划、6 个 Agent、Tool Registry、看板、HITL | 🟡 **小程序侧看板与 HITL 已就绪**（后端编排引擎待实现） |
| M3 驿站闭环 | 服务市场、任务、订单、担保支付、评价、信用 | 🟡 **页面与状态机已就绪**（订单/任务/支付服务待实现） |
| M4 / M5 | 音视频、AI 学习、消息、监控、上线 | ⬜ 未开始 |

**已可端到端演示的部分**

- ✅ 微信登录 → 用户态落库 → 冷启动免登录恢复
- ✅ 首页读取真实 `/health` 与工具列表
- ✅ **AI PPT 生成真实产出 .pptx**（含原生可编辑图表与演讲备注）
- ✅ 图片压缩 / 格式转换（Sharp 真实处理）
- ✅ 青智 OS 会话：意图识别 → 计划卡 → 一键发布到驿站（HITL 交互）
- ✅ 任务看板：阶段分组 / 状态筛选 / 人力节点发布
- ✅ 发布需求：AI 极速解析 + 一句话预填表单
- ✅ 状态机：订单 / 任务 / Job / 计划，72 个单测覆盖非法迁移与边界

---

## 七、关键工程约定

**唯一权威版本在 `docs/rules/DEVELOPMENT-STANDARDS.md`**（十条红线 + 分层约束 + 命名规范 + 提交规范）。
新同学请先读它；AI 协作者由 `AGENTS.md` 自动引导到同一份内容，避免两处漂移。

---

## 八、相关文档

| 文档 | 内容 |
|---|---|
| `docs/README.md` | 全部文档索引（从这里找） |
| `docs/product/青智校园_小程序详细设计文档_V2.md` | 详细设计（12 章 + 附录 A~F） |
| `docs/product/青智校园_开发任务清单.md` | M0~M5 共 105 个可派工任务 |
| `docs/product/青智校园_GitHub仓库清单.md` | 开源选型与许可证分级 |
| `docs/architecture/OVERVIEW.md` | 系统架构与代码分层 |
| `docs/architecture/DECISIONS.md` | ADR-01 ~ ADR-13 决策索引 |
| `docs/rules/DEVELOPMENT-STANDARDS.md` | 十条红线与编码规范 |
| `docs/dev/ENV.md` | **环境变量逐项说明与填写要求** |
| `docs/dev/ERROR_CODES.md` | 错误码表 |
| `docs/dev/WECHAT-DEVTOOLS.md` | 小程序导入与联调指引 |
| `docs/api/README.md` | 接口契约（响应体 / 版本 / 幂等 / 鉴权） |
| `docs/db/README.md` | 数据模型与迁移约定 |
| `docs/compliance/OPEN_SOURCE_LICENSES.md` | 开源合规台账 |

---

## 九、许可与合规

- 本项目**使用了多个开源组件**，全部登记在 `docs/compliance/OPEN_SOURCE_LICENSES.md`
- **AGPL / GPL 组件一律独立服务化**，只通过 HTTP API 调用，不链接、不修改、不分发源码
- **FFmpeg 必须使用 LGPL 构建**，CI 会执行 `scripts/license/check-ffmpeg-license.sh` 断言
- 涉版权功能（图片/视频修复）**仅限用户自有版权或已获授权的内容**，服务端强制校验并审计
