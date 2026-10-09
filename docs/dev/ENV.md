# 环境变量说明（.env）

> 对应文件：`.env.example`（模板，可入库）→ 复制为 `.env`（**严禁入库**）
> 生成方式：`node scripts/dev/setup-env.mjs`（会自动复制并同步到 `apps/api/.env`）

---

## 快速开始（最小可运行配置）

只想把项目跑起来看效果，**只改这 3 项**即可：

```bash
NODE_ENV=development
DATABASE_URL=mysql://qz:qz_dev_password@localhost:3306/qingzhi
SHADOW_DATABASE_URL=mysql://qz:qz_dev_password@localhost:3306/qingzhi_shadow
JWT_SECRET=随便填一个 32 位以上的随机字符串
```

其余保持默认时：
- `PROVIDER_MODE=hybrid` → 图片处理走真实 Sharp、PPT 走真实 PptxGenJS，其余走 Mock（会带 `X-Provider: mock`）
- 未填 `LLM_API_KEY` → LLM 自动降级为 Mock（**AI PPT 仍能产出真实 .pptx，只是内容为示例文案**）

---

## 1. 运行环境

| 变量 | 默认值 | 必填 | 说明 |
|---|---|---|---|
| `NODE_ENV` | `development` | 是 | `development` / `production` / `test`。生产环境会关闭 Swagger |
| `PORT` | `3000` | 是 | API 服务端口 |
| `API_PREFIX` | `/api/v1` | 是 | 全局路由前缀，默认与设计文档 9.1 一致 |
| `APP_VERSION` | `0.1.0` | 否 | 版本号，会在 `/health` 返回，用于确认部署版本 |

## 2. Provider 模式（红线 9 / 10，最关键的开关）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PROVIDER_MODE` | `hybrid` | `mock` / `real` / `hybrid` |

| 取值 | 行为 | 适用场景 |
|---|---|---|
| `mock` | 全部使用模拟实现，响应头带 `X-Provider: mock` | 无任何外部依赖时演示 UI |
| `real` | 全部使用真实实现（未配置的能力会报错） | 生产环境（需填好所有 Key） |
| **`hybrid`（推荐）** | 有真实实现就用（Sharp / PptxGenJS / FFmpeg），没有就退回 Mock | **开发默认**，也是参赛演示推荐值 |

> **怎么知道当前哪些能力是 Mock？**
> 请求 `GET /api/v1/health`，响应里的 `mockProviders` 数组会列出全部仍为 Mock 的 Provider；
> 所有响应头若带 `X-Provider: mock`，说明本次链路经过 Mock。

## 3. 数据库 MySQL

| 变量 | 默认值 | 必填 | 说明 |
|---|---|---|---|
| `DATABASE_URL` | `mysql://qz:qz_dev_password@localhost:3306/qingzhi` | **是** | 业务库连接串。用 `docker compose up -d` 时保持默认即可 |
| `SHADOW_DATABASE_URL` | `mysql://qz:qz_dev_password@localhost:3306/qingzhi_shadow` | **是** | 影子库，仅供 `prisma migrate dev` 做迁移预演。生产用 `migrate deploy` 时不会读取，但 `env()` 要求变量存在，故仍需填写 |
| `DB_POOL_MAX` | `10` | 否 | 连接池上限。会被拼成连接串的 `connection_limit` 参数（连接串里已写则以连接串为准） |

**填写要求**：
- 云数据库需按服务商格式填写，通常形如
  `mysql://用户名:密码@主机:3306/库名?sslaccept=strict`
- 密码含特殊字符（如 `@` `#` `:`）必须 URL 编码
- 字符集：Prisma 建表时已显式指定 `utf8mb4 / utf8mb4_unicode_ci`，无需在连接串里重复声明
- **本地无 Docker 时**：先执行一次 `mysql -u root -p < scripts/db/mysql-bootstrap.sql`
  （建 `qingzhi` / `qingzhi_shadow` 两库与 `qz` 账号）；或暂时不填，API 仍可启动
  （`/health` 会显示 `database: down`），但登录等数据功能不可用

### ⚠️ 本库不是 `migrate` 管的，**不要跑 `prisma migrate dev`**

现状是 `prisma db push` 建的库，**没有 `_prisma_migrations` 表**。因此 `prisma migrate dev`
（哪怕带 `--create-only`）会判定"迁移目录与库不一致"，然后**直接 reset 整个库** ——
提示只有一行 `All data will be lost`，夹在十几行日志中间，极易漏看。
实测后果：44 个工具 / 9 个服务分类 / 22,313 个单词**全部清零**。

判据：先跑 `SHOW TABLES LIKE '_prisma%'`。**空 → 永远不要跑 `migrate dev`**。

改列的正确做法：

```bash
# 1) 改 schema.prisma
# 2) 写一个临时 SQL（多条 ALTER 可整段执行）
npx prisma db execute --file scripts/db/_xxx.sql --schema apps/api/prisma/schema.prisma
# 3) 重新生成 Client
npm run db:generate
```

⚠️ `--file` **看不见 Git Bash 的 `/tmp/x.sql`**（两边路径解析不一致），临时 SQL 必须放仓库内，
用完删除。

> 若数据被 reset：`npm run db:seed`（约 10 秒）+ `npm run db:gen-words`（全量约 16 分钟）。

> **从 PostgreSQL 迁移而来**：字段与语义的对应关系（`String[]` → Json、`@db.Uuid` → `CHAR(36)`、
> pgvector 失效等）见 `docs/architecture/DB-MIGRATION-POSTGRES-TO-MYSQL.md`。

## 4. Redis

| 变量 | 默认值 | 说明 |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | 用于缓存、限流、分布式锁、延迟队列、**队列 Worker（M1-04）** |
| `QUEUE_DRIVER` | `redis-stream` | `redis-stream`（起步）/ `rabbitmq`（规模化后切换，当前未实现） |
| `QUEUE_WORKER_CONCURRENCY` | `2` | 单队列并发数。未答槽位的消息留在流里，不堆内存，天然背压 |
| `QUEUE_MAX_ATTEMPTS` | `3` | 同一消息最多投递次数，超过转入死信流 `qz:queue:tool.job:dead` |
| `QUEUE_CLAIM_IDLE_MS` | `60000` | 超过该时长未确认的消息视为消费者已失联，由其他 Worker 认领重投。**即"Worker 被强杀后任务多久重回队列"，不得小于任务典型耗时** |
| `QUEUE_ORPHAN_QUEUED_MS` | `60000` | 卡在 `queued` 超过该时长即视为"入队消息丢失"，重新投递 |

**填写要求**：生产环境请设置密码，形如 `redis://:密码@主机:6379/0`。

**Redis 不可用时的行为**（这是本项目的既定纪律，改代码前先读）：

| 能力 | 降级方式 | 判据 |
|---|---|---|
| 缓存 / 分布式锁 / 限流 | fail-open（放行 + warn） | 缓存丢了能重算；锁与限流松一点只是短暂失去保护 |
| 延迟队列（`DelayQueueService`） | fail-fast（抛错） | 定时任务丢了就是真丢了（订单永远不会自动关闭） |
| 队列 Worker（M1-04） | 回退**进程内执行** + `/health` 暴露 `queue.degraded` | 消息有数据库侧"queued 重投"兜底，功能不中断但分布式语义消失 |

> 队列的降级**必须可见**：`/health` 的 `queue` 字段会给出 `degraded`、各队列 `pending` 与
> `deadLettered` 计数。看到 `degraded: true` 说明当前是单机队列，不等于"正常"。

> ⚠️ **Redis 是生产环境必需组件，缺失时禁止上线。**
> 本地开发可以没有 Redis（降级路径实测能跑通作业），但这**不是**可上线的状态：
>
> | 降级后失去的能力 | 后果 |
> |---|---|
> | 跨进程并发控制 | `QUEUE_WORKER_CONCURRENCY` 只在单进程内生效，**多实例部署即失效**（同一作业可能被并发执行） |
> | 作业状态持久化 | 进程重启即丢队列里的待办，只能靠 `QUEUE_ORPHAN_QUEUED_MS` 重投兜底，期间作业"消失" |
> | `deadLettered` 统计 | 返回 `-1`（不可知），无法发现"消息卡进死信" |
> | PEL / 失败重投 | 没有"未确认消息重新认领"，Worker 被强杀后的在途消息只能等超时 |
>
> **探活口径**：`/health` 的顶层 `status` 为三态 —— `ok` / `degraded` / `down`。
> Redis 缺失或队列降级时 `status` 会变为 `degraded` 并在 `degradedReasons` 里给出原因，
> **告警应当监听 `status !== 'ok'`**，而不是只看 HTTP 状态码（本接口刻意恒返回 200，
> 它是"状态报告"而非"准入闸门"）。

## 5. 对象存储

| 变量 | 默认值 | 说明 |
|---|---|---|
| `STORAGE_DRIVER` | `minio` | `minio`（本地/自建）/ `oss`（阿里云）/ `cos`（腾讯云） |
| `STORAGE_ENDPOINT` | `http://localhost:9000` | 服务端点；OSS 填 `https://oss-cn-hangzhou.aliyuncs.com` |
| `STORAGE_REGION` | `cn-hangzhou` | 区域（MinIO 可随意填） |
| `STORAGE_BUCKET` | `qingzhi-dev` | 存储桶名，需与 `docker-compose.yml` 中创建的桶一致 |
| `STORAGE_ACCESS_KEY` | `minioadmin` | AccessKey **严禁入库** |
| `STORAGE_SECRET_KEY` | `minioadmin` | SecretKey **严禁入库** |
| `STORAGE_PRESIGN_EXPIRE` | `900` | 直传签名有效期（秒） |
| `STORAGE_PUBLIC_BASE_URL` | 空 | CDN 域名；留空时下载走后端代理 |

> ⚠️ **真机联调时必须填本机局域网 IP**（如 `http://192.168.31.33:3000/api/v1`），
> 否则回落到 `localhost`，而真机上 `localhost` 指向**手机自己** → 文件下载 / 图片预览全坏。
> 它和 `apps/mp/config/endpoints.ts` 的 `LOCAL_API_BASE` **是两处独立配置、却必须指向同一个 IP** ——
> 换 Wi-Fi 后只改了其中一处的话，会出现"接口全通、只有文件打不开"这种**只坏一半**的现象。
> 跑 `npm run check:api-base` 可一次比对全部（含 `apps/api/.env` 这个生成物），
> `--fix` 自动改。详见 `docs/dev/WECHAT-DEVTOOLS.md`「换 Wi-Fi 后先跑 check:api-base」。

## 6. JWT 鉴权

| 变量 | 默认值 | 必填 | 说明 |
|---|---|---|---|
| `JWT_SECRET` | — | **是** | 至少 16 位；**生产必须换成 64 位随机串** |
| `JWT_ACCESS_EXPIRE` | `2h` | 否 | accessToken 有效期 |
| `JWT_REFRESH_EXPIRE` | `30d` | 否 | refreshToken 有效期 |

生成随机密钥：
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## 7. 微信小程序

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WECHAT_APPID` | `wxd89a1e87830e5821` | 与仓库根 `project.config.json` 一致（`miniprogramRoot` 指向 `apps/mp/`）；改 appid 要**同时**改两处 |
| `WECHAT_SECRET` | 空 | 小程序 AppSecret，**严禁入库**。获取：微信公众平台 → 开发管理 → 开发设置 |
| `WECHAT_CODE2SESSION_URL` | 官方地址 | 一般无需修改 |
| `WECHAT_DEV_LOGIN` | `false` | 是否**强制**走开发模式的伪 openid（即使已配好 `WECHAT_SECRET`），见下方说明 |
| `WECHAT_SUBSCRIBE_TEMPLATE_*` | 空 | 订阅消息模板 ID；留空则只发站内信 |

**填写要求**：
- **未配置 `WECHAT_SECRET` 时会自动进入开发模式**：用 `dev_<哈希>` 作为伪 openid，
  保证本地能反复登录同一账号。此时 `/health` 会提示，且响应带 Mock 标记。
- 配置后即走真实 `code2Session`，重复登录不会产生重复用户（openid 唯一约束）。
- **本地请保持 `WECHAT_DEV_LOGIN=false`**：开着它等于"任何 code 都能登录"，
  小程序的登录会一起变成假的 —— 而登录恰恰是最不该假装的一条链路。

### 那 `verify:*` 脚本怎么取 token？（登录夹具通道）

这些脚本都要先拿一个 accessToken，做法是拿一个**假 code** 调 `POST /auth/login`。
早先靠 `WECHAT_DEV_LOGIN=true` 放行，代价是"脚本能跑"与"真实登录接通"只能二选一
（2026-09-19 实测：填了真 Secret 后脚本全停在 `❌ 登录（HTTP 401）`，因为请求真的打到微信）。

现在改用**前缀**认夹具：只有以 `qz-dev:` 开头、且服务端**非生产**的 code 才走伪 openid，
其余 code 一律真换。所以两个目标可以同时成立。

| | 走真实 `code2Session` | 走伪 openid | 算不算降级 |
|---|---|---|---|
| 小程序（真实 code，不含冒号） | ✅ | — | 否 |
| `verify:*` 脚本（`qz-dev:` 前缀） | — | ✅ | 否（真实登录仍在工作） |
| `WECHAT_DEV_LOGIN=true` | — | ✅ **任何 code** | **是**，进 `X-Degradations` |

- 脚本侧统一用 `scripts/dev/dev-login.mjs` 的 `devLoginCode(tag)` 生成 code，别手写字面量；
  `verify-l1-ppt.py` 是 Python，用文件内的 `DEV_LOGIN_PREFIX` 常量。
- 前缀在 TS 与脚本里各有一份字面量，由 `apps/api/src/modules/auth/__tests__/wechat.service.spec.ts`
  做漂移守卫（写歪的结果是脚本停在登录那一步，看起来像后端坏了）。
- `verify-auth.mjs` **刻意不用**夹具 code —— 它第 ② 步正是拿一个非法 code 去撞微信，
  收到 `40029` 才证明真实链路接通。

> ⚠️ `WECHAT_DEV_LOGIN` 与夹具通道在 `NODE_ENV=production` 时都**强制失效**（`buildWechat` 里判定）：
> 前者是因为伪 openid 是 code 的哈希、可预测，线上开等于给任何人开门；后者同理。
> 前者开启时 `/health` 仍会把它列为 `wechat-login` 降级、响应带 `X-Provider: mock` ——
> 因为它确实用的是伪身份，**不能假装没事**。

> ℹ️ 关掉 `WECHAT_DEV_LOGIN` 之后，小程序首页的「演示模式」角标**不会消失**：
> 那是按"整个装配里有没有任一 mock Provider"打的，本项目还有 `mock-pay` / `mock-sms` /
> `mock-moderation` 等 6 个。**登录是否真实**只看 `/health` 的 `degradations` 里还有没有
> `wechat-login`，别看角标。

## 8. 微信支付

| 变量 | 说明 |
|---|---|
| `WECHAT_PAY_MCHID` | 商户号 |
| `WECHAT_PAY_SERIAL_NO` | 证书序列号 |
| `WECHAT_PAY_PRIVATE_KEY_PATH` | 私钥文件路径（**不要放进仓库**） |
| `WECHAT_PAY_APIV3_KEY` | APIv3 密钥 |
| `WECHAT_PAY_NOTIFY_URL` | 支付回调地址，必须 HTTPS 且公网可达 |

> **未配置时自动降级为 MockPayProvider**（可跑通整个下单→支付→验收流程，带 Mock 标记）。
> 个人主体无法开通微信支付，此时应保持 Mock，等资质到位后仅替换 Provider 实现（见 ADR-04）。

## 9. 大模型

> 下表"当前值"列是 **`.env` 实配**（代码兜底默认值见 `apps/api/src/common/config/env.schema.ts`，
> 仅在变量缺失时生效）。

| 变量 | 当前值 | 说明 |
|---|---|---|
| `LLM_DRIVER` | `openai-compatible` | `openai-compatible` / `mock` |
| `LLM_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` | 任何兼容 OpenAI 协议的服务（**当前实配智谱**） |
| `LLM_API_KEY` | 已填（智谱） | **未填则自动降级为 MockLlmProvider** |
| `LLM_MODEL_INTENT` | `glm-4.5-air` | 意图识别（文档 6.10.2 分级）。走智谱资源包额度，见下方示例 |
| `LLM_MODEL_GENERATE` | `glm-4.5-air` | 内容生成 |
| `LLM_MODEL_PLAN` | `glm-4.5-air` | 复杂规划（活动编排） |
| `LLM_FALLBACK_MODELS` | `glm-4.7-flash` | **降级模型**（逗号分隔）。主模型重试耗尽后按顺序再试；只能在**同一服务商**内换模型名。⚠️ **时段性可用**：09-19 实测 10 次连打 **8/10 成功**（1.1~2.9s），另一批 2/2 全 429 —— **别用一两次 429 判定"这个模型不能用"** |
| `LLM_TIMEOUT_MS` | `12000` | 单次调用超时。⚠️ 必须 **≤ `LLM_TOTAL_BUDGET_MS`**，否则启动期报错 |
| `LLM_MAX_RETRY` | `3` | 重试次数（指数退避 1s/4s/16s） |
| `LLM_TOTAL_BUDGET_MS` | `25000` | **单次逻辑调用的总时间预算**，覆盖"所有模型 × 所有重试 × 所有退避"的总和。⚠️ 还必须 **≤ 25000**（客户端 30s 超时减 5s 回程余量），否则启动期报错 |
| `LLM_REASONING_EFFORT` | `low` | 推理深度。⚠️ 智谱只认 `low` / `high` / `max`；切回硅基流动 DeepSeek 时必须清空（泄漏 `</think>`）。⚠️ 效果**随任务复杂度递减**，复杂生成任务要靠 `LLM_DISABLE_THINKING` |
| `LLM_DISABLE_THINKING` | `true` | 是否**允许**发送 `thinking:{type:'disabled'}`（智谱关闭思考）。语义是"允不允许发参数"，关不关由调用方决定（目前只有 `generate_mindmap` 请求）。换不兼容端点设 `false` |

> ⚠️ **`LLM_TIMEOUT_MS` 必须 ≤ `LLM_TOTAL_BUDGET_MS`**
>（启动期由 `assertTimeoutWithinBudget` 断言，配错直接拒绝启动）。
>
> 原因：`TimeBudget.attemptTimeout()` 取「单次超时」与「剩余预算」的**较小值**。
> 于是单次超时大于总预算时，**第一次尝试就吃掉全部预算** ——
> 等它超时回来，`canAttempt()` 已经为 false，**既不重试也不降级**。
> 用户看到的是"AI 服务繁忙"，而真实原因只是一次**本可靠重试救回的连接挂起**。
>
> 实测指纹（2026-09-18）：作业耗时 **45.028s**（= 总预算）且日志里**没有任何降级记录**。
> ASR 侧一直是对的（`20000 ≤ 25000`），只有 LLM 侧漏了（`60000 > 45000`）。

> ⚠️ **`LLM_TOTAL_BUDGET_MS` 是硬上限，不是建议值。**
> 没有它时超时是**乘法放大**的：`模型数 × (重试次数 × LLM_TIMEOUT_MS + 退避)`。
> 按 2 个模型、3 次重试、30s 超时、退避 1s+4s 算：
>
> ```
> 2 × (3 × 30s + 5s) = 190 秒
> ```
>
> 而小程序侧 `request.ts` 的超时只有 **30 秒** —— 也就是说用户在 30 秒时已经看到
> "网络开小差了"，后端却还在继续打请求，把供应商额度烧到第 190 秒。
> **钱花了、用户什么也没得到、日志里还看不出异常。**
>
> 加了预算后，无论 `LLM_MAX_RETRY` / `LLM_FALLBACK_MODELS` 怎么配，
> 一次逻辑调用的墙钟时间都不会超过它。预算耗尽时**主动停下**而不是"再试最后一次"：
> 剩余时间不足一次典型请求时再发出去只会超时，却照样消耗额度。
>
> ⚠️ **还有一条跨端约束：服务端预算必须小于客户端超时。**
>
> 小程序 `rawRequest` 默认 30s 超时（`apps/mp/utils/request.ts`），
> 启动期由 `assertBudgetWithinClientTimeout` 断言 `LLM_TOTAL_BUDGET_MS` / `ASR_TOTAL_BUDGET_MS`
> 必须 **≤ 25000ms**（30s 减 5s 回程余量），配大了直接拒绝启动。
>
> 为什么必须拦：服务端预算比客户端超时大时，会出现**两端判定相反**的现象 ——
> 用户 30 秒后看到"请求超时"以为失败，而服务端仍在跑，45 秒时才跑完、
> **落库了产物还扣了费**。用户账上少了钱、文件里多了东西，两边谁都不知道对方怎么想。
>
> 修法二选一：调小预算（默认已按 25s 配好），或把该工具改为异步（`sync: false`）
> 由进度通道汇报 —— 而不是让一次 HTTP 请求挂着，也不是把客户端超时调大让用户白等更久。
>
> **取值口径**：`LLM_TIMEOUT_MS` 默认 `12000` —— 关掉思考后长输出实测 3.6~12s，
> 单次超时只需覆盖"正常慢请求"，更慢的交给总预算内的重试与降级。
> 
> plan 档约 21s，留出余量后仍能在"首次挂起"时剩下预算发起重试。
> `LLM_TOTAL_BUDGET_MS` 默认 `25000`（客户端超时允许的上限），是给"大纲生成"这类长任务留的余量；
> 意图识别这类交互式调用建议单独压到 8~12s。

> ⚠️ **`LLM_REASONING_EFFORT` 的取值是实测得出的，不是抄 OpenAI 规范**：
> 智谱 GLM flash 系列传 `medium` / `minimal` 会被直接 **400 拒绝**
>（`code 1210 该模型始终思考，不支持关闭思考；请使用 low、high 或 max`）。
> 所以 schema 里**刻意不含 `medium`**，让配置错误在启动时就暴露。
> 实测同一请求（"只回复两个字：可以"）：不传 → 112 完成 token / 3.5s；
> `low` → **3 token / 0.99s**（推荐）；`high` → 3 token / 2.2s；`max` → 135 token / 2.5s。
>
> ⚠️ **但别把这组数字当通用结论**：它是**极简任务**测出来的。`low` 的效果
> **随任务复杂度递减** —— 对话 / 大纲能压到 0 字推理，而思维导图这种
> "双产物 + 结构化语法"的任务**压不住**：实测 reasoning 仍占 token 的 60~75%、
> 耗时 **23.6~31.1s**，恰好在 30s 单次超时线上反复横跳（表现为"时通时不通"）。
> 这类场景要靠 `LLM_DISABLE_THINKING`（显式关思考），**不是**靠调档位。

> ⚠️ **为什么需要 `LLM_FALLBACK_MODELS`**：免费档的 flash 模型会过载，智谱返回
> `HTTP 429 + code 1305 该模型当前访问量过大`。实测 `glm-4.7-flash` 高峰期
> **5 次里 4 次 429**，唯一成功那次耗时 42 秒 —— 光靠重试（1s/4s/16s）等不来可用性，
> 只会让用户白等 20 秒再看到失败。配了降级后自动切到健康模型，用户几乎无感，
> 且会在服务端日志留下 `LLM 主模型 X 不可用（HTTP 429 …），降级到 Y` 的记录。
> 只在**可重试**失败（429/5xx/网络）上降级；确定性失败（400，模型名写错等）直接抛出，
> 因为换模型也一样会失败。

**各家示例**：
```bash
# 智谱 GLM（⭐ 本项目当前实配，2026-09-18 切回；文本走资源包额度，
#   降级位用同服务商的永久免费档。选型与实测见 docs/dev/AI-PROVIDER-CONFIG.md）
LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
LLM_API_KEY=<控制台生成>
LLM_MODEL_INTENT=glm-4.5-air
LLM_MODEL_GENERATE=glm-4.5-air
LLM_MODEL_PLAN=glm-4.5-air
LLM_FALLBACK_MODELS=glm-4.7-flash
LLM_REASONING_EFFORT=low            # ⚠️ 智谱只认 low/high/max，传 medium 会 400
LLM_DISABLE_THINKING=true           # 允许生成类工具显式关思考（复杂任务压不住 low 时用）

# 硅基流动（备用 A：智谱额度用尽/到期或智谱故障时切回；
#   与 OCR / 语音共用同一个 Key 和余额。实测质量同样合格：意图 5/5、不编造）
LLM_BASE_URL=https://api.siliconflow.cn/v1
LLM_API_KEY=<与 SILICONFLOW_API_KEY 同一个>
LLM_MODEL_INTENT=deepseek-ai/DeepSeek-V4-Flash    # 三档统一：最便宜且三档都胜任
LLM_MODEL_GENERATE=deepseek-ai/DeepSeek-V4-Flash
LLM_MODEL_PLAN=deepseek-ai/DeepSeek-V4-Flash
# ⚠️ 用硅基流动做主模型时降级链只能留空（想用的 glm-4-flash 硅基没有 = 假兜底），
#    且必须清空 LLM_REASONING_EFFORT（带该参数短输出会泄漏 </think>）。
#    来龙去脉见 docs/dev/AI-PROVIDER-CONFIG.md「降级链」一节
LLM_FALLBACK_MODELS=
# 选型实测表见 docs/dev/AI-PROVIDER-CONFIG.md（含被淘汰的候选及原因）

# DeepSeek（官方 API，非免费但极便宜：百万 token 几毛钱）
LLM_BASE_URL=https://api.deepseek.com/v1

# 通义千问（DashScope 兼容模式；新用户有 90 天额度）
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1

# 本地 Ollama（完全免费、数据不出门，需显卡）
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama                          # Ollama 不校验，但必须非空
LLM_MODEL_INTENT=qwen3.5:4b                 # 8GB 显存档；9B 需 Q4 且关掉占显存的程序
```

**⚠️ 接入时最容易踩的坑（一句话）**：**模型名必须在该服务商存在**。
`deepseek-reasoner` 搬到智谱/硅基流动上会报 "model not found" ——
而报错信息看起来像鉴权问题，很容易查错方向。三家分级的**模型名各不相同**，必须分别填。

**接入自检（强烈建议填完 Key 先跑这个）**：
```bash
npm run build -w @qz/api          # 脚本调用的是编译产物，与线上同一条代码路径
node scripts/dev/verify-llm.mjs   # 三个档位各打一次真实请求 + 结构化输出验证
```
它会逐个档位报告延迟与返回内容，并明确指出哪个模型名不存在；
未配置 Key 时给出配置引导并以退出码 0 结束（"还没配"不算失败）。
接上之后可用 `/health` 复核：`mockProviders` 里不再出现 `mock-llm`。

## 10. AI 媒体服务

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AI_SERVICE_URL` | `http://localhost:8000` | `services/ai`（OCR / ASR / 抠图 / 分离） |
| `MEDIA_SERVICE_URL` | `http://localhost:8001` | `services/media`（FFmpeg 音视频处理） |
| `MEDIA_TTS_BIN` | 空（未安装） | edge-tts 可执行文件（LGPLv3，须装在仓库外 venv）；留空则 `/media/tts` 返回 501 |
| `FFMPEG_BIN` | 空（走 PATH） | ffmpeg 可执行文件。⚠️ **必须 LGPL 构建**，见下方说明 |
| `FFPROBE_BIN` | 空（走 PATH） | ffprobe 可执行文件，同上 |
| `REMBG_MODEL` | `u2net` | **必须用白名单内模型**（文档 2.8.4，`isnet`/`birefnet` 等许可受限） |
| `VOCAL_SEPARATION_ENGINE` | `demucs` | `demucs`（注意原仓库已归档）/ `spleeter`（活跃备选） |
| `WHISPER_MODEL` | `small` | `tiny`/`base`/`small`/`medium`/`large-v3`，越大越准也越慢 |
| `GPU_CONCURRENCY` | `1` | GPU 任务并发上限（文档 6.2.4） |

> ⚠️ **FFmpeg 必须用 LGPL 构建**（红线，文档 2.7.2）。
>
> **判定口径（2026-09-19 修正）**：**`-buildconf` 里不出现 `--enable-gpl` 即为 LGPL** ——
> 这是 FFmpeg 的默认许可语义，**不要求显式写 `--enable-lgpl`**。
> 原先只认显式的 `--enable-lgpl`，于是把 BtbN 的 `win64-lgpl` 构建误判成"无法确认"，
> 合规构建反而要人工放行。
>
> 断言命令：`npm run check:ffmpeg`（自动从 `.env` 读 `FFMPEG_BIN`，不再依赖 PATH）。
> 本机实测（BtbN `win64-lgpl`，`ffmpeg version N-126636`）：配置含
> `--disable-libx264 / --disable-libx265 / --disable-libxavs2 / --disable-libxvid` ——
> GPL-only 组件被刻意排除 ✅

## 10b. 硅基流动 SiliconFlow（多模态 / OCR / 语音）

承担除文本 LLM 外的全部 AI 能力，**共用一个 API Key**。
控制台：<https://cloud.siliconflow.cn/me/account/ak>

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SILICONFLOW_BASE_URL` | `https://api.siliconflow.cn/v1` | 国内站；国际站为 `.com` |
| `SILICONFLOW_API_KEY` | 空 | **留空则 OCR 与语音转文字回退 Mock**（响应头 `X-Provider: mock`） |
| `VLM_MODEL` | `deepseek-ai/DeepSeek-OCR` | OCR / 图片理解 |
| `VLM_ENABLE_THINKING` | 空 | 是否发 `enable_thinking`。**留空=不发送**（最安全）；DeepSeek-OCR 收到会 400，仅 Qwen3.5/Qwen3-VL 等混合思考模型才设 `false` |
| `VLM_TIMEOUT_MS` | `90000` | 视觉请求超时（毫秒） |
| `VLM_MAX_RETRY` | `2` | 视觉请求重试次数（指数退避 1s / 4s） |
| `ASR_MODEL` | `Qwen/Qwen3-ASR-1.7B` | 语音转文字 |
| `ASR_TIMEOUT_MS` | `20000` | 单次请求超时（毫秒） |
| `ASR_MAX_RETRY` | `1` | **额外**重试次数（不含首次）→ 共 2 次尝试 |
| `ASR_TOTAL_BUDGET_MS` | `25000` | 单次逻辑调用的总预算，保证 `重试 × 超时` 不超出小程序请求超时 |

> ⚠️ **`ASR_TIMEOUT_MS` 曾经是 `120000`（2 分钟），这是个数量级错误。**
> 实测该端点**成功耗时只有 78~97ms**，2 分钟的等待比真实耗时大了三个数量级。
> 而供应商会**间歇性挂起**（实测约 **35%** 的调用报
> `The operation was aborted due to timeout`），于是用户要干等两分钟才看到失败，
> 而且每次超时都照样消耗额度。
>
> 现在 20s + 重试 1 次：
> - **20s 的依据**：60 秒语音的转录实测在 3~6 秒量级，20s 已有 3 倍余量；
>   超过 20s 还没返回的基本就是挂起，早失败早重试更划算。
> - **为什么要重试**：挂起是间歇性的 —— 同一次音频第一次超时、第二次 78ms 成功，
>   典型"重试即成功"。不重试等于把三成多的可用性直接丢掉。
> - **为什么还要总预算**：`2 × 20s = 40s` 已经超过小程序请求超时（30s），
>   没有预算上限时前端会先断开而后端还在打请求。
>
> ⚠️ **`ASR_MAX_RETRY` 的语义与 `LLM_MAX_RETRY` 不同**：前者是"**额外**次数"，
> 后者是"**总**尝试次数"。这是刻意的 —— ASR 是单次短操作，把"再试一次"
> 写成 `ASR_MAX_RETRY=1` 比写成 `ASR_MAX_ATTEMPTS=2` 更符合直觉。
| `EMBEDDING_MODEL` | `BAAI/bge-m3` | 向量化（语义检索 / RAG 用） |
| `EMBEDDING_DIMENSION` | `1024` | 向量维度。⚠️ **必须与模型真实维度一致**，填错不报错、只会静默算错 |
| `EMBEDDING_TIMEOUT_MS` | `60000` | 向量化超时（毫秒） |
| `EMBEDDING_MAX_RETRY` | `2` | 向量化重试次数 |

### 10c. 向量库 + RAG 检索（M4-06 校园知识库）

| 变量 | 默认 | 说明 |
|---|---|---|
| `VECTOR_DRIVER` | `mock` | 向量库实现：`mock` \| `qdrant` |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant 地址（自建默认端口 6333） |
| `QDRANT_API_KEY` | 空 | Qdrant Cloud 必须填；自建留空 |
| `QDRANT_COLLECTION` | `qz_knowledge` | 集合名 |
| `QDRANT_TIMEOUT_MS` | `15000` | 向量库请求超时 |

### 地图 / 位置服务（高德 Web 服务）

| 变量 | 默认 | 说明 |
|---|---|---|
| `MAP_DRIVER` | `mock` | `mock` = 演示实现（距离按「直线 × 1.4」估算、坐标是 `(0,0)`，亮"演示模式"角标）；`amap` = 真实路线 |
| `AMAP_WEB_KEY` | 空 | 高德 **Web 服务** key。⚠️ 不是「Web端(JS API)」也不是「微信小程序」的 key；**只在服务端**使用 |
| `AMAP_TIMEOUT_MS` | `8000` | 高德请求超时（毫秒） |

> ⚠️ `MAP_DRIVER=amap` **必须同时填 `AMAP_WEB_KEY`** —— 只改 driver 会静默回退 mock。
> 这是刻意的（见 `buildMap()`）：否则会得到一个"看起来已启用、但每次调用都失败"的 Provider，
> 把"配置缺失"伪装成"服务故障"，属于最难排查的一类问题。
>
> ⚠️ 高德对失败返回的是 **HTTP 200 + `status:"0"`**，key 类型选错、配额用尽、参数非法
> 全是 200。`AmapMapProvider` 因此做**业务层**校验，并把 `info` / `infocode` 打进服务端日志 ——
> 三种原因对用户都表现为"地图服务不可用"，只有日志能区分。
| `RAG_TOP_K` | `5` | 一次检索取回多少条切片 |
| `RAG_SCORE_THRESHOLD` | `0.35` | 相似度下限（Cosine 0~1） |
| `RAG_CHUNK_SIZE` | `500` | 单切片字符数 |
| `RAG_CHUNK_OVERLAP` | `80` | 相邻切片重叠字符数 |

> **为什么要独立的向量库**：本项目已拍板统一用 MySQL 8，而 MySQL 既没有向量类型、
> 也没有 ANN 索引。把 1024 维向量存进 Json 列，检索只能全表捞出来在应用层算余弦 ——
> 几百条还行，上万条就是一次接口几十秒。`KnowledgeDoc.embedding` 那个 Json 列是
> 初版 schema 的过渡设计，**已被本方案取代**（字段保留但不写入）。
> 决策记录见 `docs/architecture/DECISIONS.md`。

> ⚠️ **默认 `mock` 而不是 `qdrant`**：让**没部署向量库的机器也能启动**，
> 检索会走 `mock-vector` 并被打上 `X-Provider: mock`（红线 10）。
> 反过来（默认 qdrant）会让所有开发机一启动就报连不上。
> 要用真检索必须**显式**改成 `qdrant`。

> ⚠️ **`RAG_SCORE_THRESHOLD` 不是可有可无的调参**：它的作用是让
> "检索不到"成为一件**可以说出口的事**。没有阈值时，即使知识库完全没有相关内容，
> 也会硬塞 `RAG_TOP_K` 条最不相关的切片给模型，模型再据此编出一个听起来很合理的
> 答案 —— 而校园制度类信息答错，用户会按错误流程办事。有了阈值，
> 命中为空时接口返回 `grounded: false` + 一句如实的"没找到"，**不调用 LLM**。

> ⚠️ **换 Embedding 模型时必须同步两处**：`EMBEDDING_DIMENSION` 与
> `QDRANT_COLLECTION`。维度不同无法共用同一个集合，而 `QdrantVectorProvider`
> 会显式比对已存在集合的维度并抛错 —— 否则会静默写入成功、检索出一堆噪音。

**本机怎么跑 Qdrant（不需要 Docker）**：Qdrant 官方提供 Windows 二进制
`qdrant-x86_64-pc-windows-msvc.zip`（v1.19.1 实测可用），解压后直接运行 `qdrant.exe`，
默认监听 `6333`。本项目已放在 `~/.workbuddy-ai/binaries/qdrant/`。
验证：`curl http://localhost:6333/` 应返回版本号。

> ⚠️ **模型名必须带组织前缀**（HuggingFace 风格）：`Qwen/Qwen3.5-4B`、
> `PaddlePaddle/PaddleOCR-VL-1.5`、`deepseek-ai/DeepSeek-OCR`、`Qwen/Qwen3-ASR-1.7B`、
> `FunAudioLLM/SenseVoiceSmall`。**写成 `qwen3.5-4b` 会返回 404。**

> ⚠️ **ASR 的调用端点与文本模型不同**：必须调 `POST {BASE}/audio/transcriptions`
> （multipart 上传）。用 `/chat/completions` 传 `audio_url` 会返回
> `400 code 20012 Model does not exist`。

> ⚠️ **`enable_thinking` 不能无脑传**：`deepseek-ai/DeepSeek-OCR` 收到该参数直接
> `400 code 20015 does not support parameter enable_thinking`，所以默认留空不发送。
> 只有换成 `Qwen/Qwen3.5-4B` 这类混合思考模型时才设 `false`——实测同一张图
> completion token 从 209 降到 1、耗时从 5.2s 降到 0.5s。
> （`reasoning_effort` 对 Qwen 系几乎无效，别用它替代。）

> 实测耗时（同一张中文截图 / 1 秒音频）：
> `deepseek-ai/DeepSeek-OCR` 1.3s · `PaddlePaddle/PaddleOCR-VL-1.5` 2.1s（输出含版面坐标标记）
> · `Qwen/Qwen3-ASR-1.7B` 0.5s · `FunAudioLLM/SenseVoiceSmall` 明显更慢

### 10d. 自托管语音识别 / OCR（faster-whisper / PaddleOCR，可选）

把 ASR / OCR 从硅基流动云端切到本地 Python 侧车（`services/ai`），
模型在本机跑、不花云端额度。**两个开关相互独立、默认都是 `cloud`（零回归）**。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ASR_PROVIDER` | `cloud` | `cloud` = 硅基流动 transcription（默认）；`selfhost` = 调 `services/ai` 的 `/ai/asr`（faster-whisper，MIT）。前提：`AI_SERVICE_URL` 已配置、侧车在跑、whisper 模型已就位；前提不满足时**回落 Mock 并打 `X-Provider: mock`**（配了才真） |
| `OCR_PROVIDER` | `cloud` | `cloud` = 硅基流动 VLM（默认）；`selfhost` = 调 `services/ai` 的 `/ai/ocr`（PaddleOCR，Apache-2.0，固定中英混合）。回落规则同上 |

> ⚠️ **切 `selfhost` 前先调大超时预算**：云端 ASR 的 `ASR_TIMEOUT_MS=20000` 是按
> 78ms 实测调的；CPU 上 faster-whisper 转写耗时约「音频时长的 0.1~1 倍」，
> 切换后应把 `ASR_TIMEOUT_MS` / `ASR_TOTAL_BUDGET_MS` 同步调大
> （且 `ASR_TOTAL_BUDGET_MS` 仍受 `check:timeout-budget` 的「≤ 客户端超时 − 5s」断言约束，
> 超了会让**后端启动即失败**——长音频请走异步工具，别硬调预算）。
> 模型未装时侧车 `/health` 如实标 `asrReady` / `ocrReady=false`，调用返回 501 + 安装指引。

## 11. 文档转换隔离服务

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CONVERT_SERVICE_URL` | 空 | **留空则文档转换类工具不可用**（返回 50362） |
| `CONVERT_SERVICE_TIMEOUT_MS` | `120000` | 转换超时 |

> **为什么必须独立部署**（文档 2.5）：LibreOffice / Pandoc 为 GPL，ConvertX / PPTist 为 AGPL。
> 只有以「独立服务 + HTTP API」方式接入，才能避免源码开放义务。
> **绝不把这些组件打进主工程**。

## 11e. PDF 能力服务（`services/pdf`）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PDF_SERVICE_URL` | 空 | **留空则 PDF 合并/拆分/压缩/文档解析不可用**（明确报错，不返回假产物） |
| `PDF_SERVICE_TIMEOUT_MS` | `120000` | 后端等 PDF 服务的超时 |
| `PDF_HOST` / `PDF_PORT` | `0.0.0.0` / `8003` | PDF 侧车自己的监听地址 |
| `PYMUPDF_BIN` | 空 | **装了 PyMuPDF 的 Python 解释器**（侧车会追加 `-m pymupdf`）；留空则查 PATH 上的 `pymupdf` 命令 |
| `PDF_TIMEOUT_SEC` | `120` | 单次 PDF 操作的墙钟上限 |

> **为什么必须独立安装**：PyMuPDF 是 **AGPL-3.0**，按仓库红线（许可登记 B 级清单）
> 只能「独立进程 + 命令行调用」，不能 import 进 `services/` —— 所以
> `services/pdf/requirements.txt` 是空的，这是刻意的，不是遗漏。
>
> 安装：`pip install PyMuPDF`（装进任意一个独立解释器，建议独立 venv），
> 再把 `PYMUPDF_BIN` 指向它。侧车未启动 / 引擎未装时，
> `/health` 的 `services.pdf` 与 `/pdf/capabilities` 都会如实标注。
>
> ⚠️ **能力边界**：PyMuPDF 能做"不改排版"的四件事（合并/拆分/压缩/取文本）；
> **PDF → Word/PPT 属于 `convert_pdf` / `convert_file`**，需要 LibreOffice（`CONVERT_SERVICE_URL`），
> 不要把那两个工具也标成可用 —— PyMuPDF 产不出能编辑的 docx。

## 11f. 仓库解读服务（deepwiki-open，自托管）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DEEPWIKI_BASE_URL` | 空 | deepwiki-open 服务地址（如 `http://localhost:8005`）。**留空 = 不启用**：回落 `mock-repo`（产物通篇标注演示性质），seed 里 `explain_repository` 保持 `planned`；部署并配置后才把 seed 转 `active` |
| `DEEPWIKI_TIMEOUT_MS` | `120000` | 单次仓库解读请求超时（毫秒）。文档生成是分钟级任务，工具走异步作业（`sync: false`），不受小程序 30s 请求超时约束，不要把它压进 30s |
| `DEEPWIKI_API_KEY` | 空 | 可选 Bearer 凭证（自托管实例开启鉴权时才需要）；不配则不发 Authorization 头 |

> deepwiki-open 为 MIT 许可，只调其 REST 接口（`POST /api/wiki/ask`），
> 不引入 SDK；装配开关与 `convert` / `pdf` 同一套「配了才真」纪律。

## 11g. PDF 工具站（Stirling-PDF，自托管，可选）

PDF **操作类**能力（合并 / 拆分 / 压缩）的实现选择，与 `PDF_SERVICE_URL`（sidecar）、
`DOC_PARSER_PROVIDER`（解析类）是**三个互不影响的维度**。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PDF_PROVIDER` | `sidecar` | `sidecar` = `services/pdf`（PyMuPDF，默认）；`stirling` = 自托管 Stirling-PDF 的 REST（`STIRLING_SERVICE_URL` 为空时按 sidecar 处理——配了才真，不静默造能力） |
| `STIRLING_SERVICE_URL` | 空 | Stirling-PDF 地址（如 `http://localhost:8080`）。docker-compose 以 `--profile selfhost` 提供，探活 `/api/v1/info/status` |
| `STIRLING_API_KEY` | 空 | 实例开启鉴权时的 `X-API-KEY`；不配则不发该头 |
| `STIRLING_TIMEOUT_MS` | `120000` | 单次 PDF 操作超时（毫秒） |

> ⚠️ **许可边界（open-core）**：Stirling-PDF 主 LICENSE 为 MIT，但 `app/proprietary/`、
> `engine/`、`frontend/editor/src/{proprietary,saas,cloud,portal}/` 等目录是独立商业许可——
> 自托管镜像只用社区功能，**不得配置/调用专有目录的端点**（详见许可登记 A 级清单）。
> ⚠️ **ranges 语义差异**：sidecar 拆分允许"未覆盖页丢弃"，Stirling 永不丢页；
> 仅当 ranges 可证明等价（≥2 个连续分组、首组从页 1 起、末组 `x-N` 收尾）才映射，
> 否则显式报错并提示切回 `PDF_PROVIDER=sidecar`。

## 11h. 文档解析引擎（docling，可选）

`parse_document` / `convert_file` 背后的**解析类**引擎选择（读 PyMuPDF 是"取文本"，
docling 是"版面 + 表格 + 阅读顺序理解，输出 Markdown"）。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DOC_PARSER_PROVIDER` | `legacy` | `legacy` = `services/pdf` 的 PyMuPDF 取文本（默认）；`docling` = 同侧车的 `/pdf/parse-docling`（docling，MIT，输出 Markdown、`meta.mdPreview`） |
| `DOCLING_ARTIFACTS_PATH` | `./data/models/docling` | docling 模型产物目录（首次调用自动下载，数百 MB；建议挂卷持久化）。只进侧车环境，不进 `env.schema.ts`（与 `PYMUPDF_BIN` 同一约定） |

> docling 为 MIT 可进程内 import；PyMuPDF 仍是 AGPL 严格子进程隔离，两者共存于同一侧车。
> 依赖未装时 `/health` 如实标 `doclingReady=false`，调用返回 501 + 安装指引。

## 11i. 图表渲染（mermaid / markmap → PNG，services/media，可选）

给 `generate_mindmap` 的 Mermaid 文本补一张**服务端渲染的分享图**（增量产物：
渲染失败只 warn，绝不影响原有文本结果）。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `RENDER_PROVIDER` | `mock` | `mock`（默认）= 不渲染，思维导图只有文本产物；`playwright` = 调 `services/media` 的 `/media/render-diagram`（playwright + chromium 截图本地模板，JS 库全部本地化无 CDN 依赖） |

> 开启前提：`services/media` 已装 playwright 并执行
> `playwright install chromium --with-deps`（**中文字体包必须装**，否则导图出豆腐块），
> 且 `MEDIA_SERVICE_URL` 已配置。前提不满足时 mock 实现抛错并说明开启方式（红线 10）。

## 12. 限流与配额

| 变量 | 默认值 | 说明 |
|---|---|---|
| `THROTTLE_TTL` | `60` | 限流窗口（秒） |
| `THROTTLE_LIMIT` | `120` | 窗口内最大请求数 |
| `MAX_CONCURRENT_RUNS` | `2` | 单用户同时运行的编排数上限 |

## 13. 日志

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LOG_LEVEL` | `debug` | `debug`/`info`/`warn`/`error` |
| `LOG_FORMAT` | `pretty` | `pretty`（开发可读）/ `json`（生产采集） |
| `LOG_MASK_SENSITIVE` | `true` | **生产必须 true**：自动脱敏手机号 / 学号 / token |

## 14. 管理后台

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ADMIN_ORIGIN` | `http://localhost:5173` | 后台地址 |
| `CORS_ORIGINS` | `http://localhost:5173` | 允许跨域来源，多个用英文逗号分隔 |

## 15. 业务参数

| 变量 | 默认值 | 说明 |
|---|---|---|
| `BILLING_ENABLED` | `false` | **积分计费总开关**。`false`＝免费开放（前期默认）：不预扣/不结清/不退回，也不产生积分流水，全部功能免费使用；`true`＝按积分计费。切换只改这一个变量，**不需要改代码或改数据** —— 详见 `docs/dev/BILLING-MODES.md` |
| `PLATFORM_FEE_RATE` | `0.05` | 平台服务费比例（5%） |
| `PLATFORM_FEE_CAP_CENTS` | `2000` | 服务费封顶（分），2000 = 20 元 |
| `ORDER_PAY_TIMEOUT_MINUTES` | `30` | 未支付自动关单时长 |
| `ORDER_AUTO_ACCEPT_DAYS` | `7` | 未验收自动验收天数 |
| `UPLOAD_MAX_IMAGE_MB` | `20` | 图片上限 |
| `UPLOAD_MAX_VIDEO_MB` | `500` | 视频上限 |
| `UPLOAD_MAX_DOC_MB` | `100` | 文档上限 |
| `FILE_RETENTION_DAYS` | `30` | 产物保留天数，过期前 3 天提醒 |

> `BILLING_ENABLED` 的效果与影响面（含"哪些东西**不**随它变"）见 `docs/dev/BILLING-MODES.md`。
> 一句话：**它只在 `BillingService` 一个地方生效**，其它模块一行都不用改。

---

## 11b. 内容安全（M4-05）

| 变量 | 默认 | 说明 |
|---|---|---|
| `MODERATION_DRIVER` | `mock` | `wechat` = 调官方 `msgSecCheck` / `mediaCheckAsync`；`mock` = 只跑本地词库 |
| `MODERATION_SCENE` | `3` | 官方场景值：1 资料 / 2 评论 / 3 论坛 / 4 社交日志 |
| `MODERATION_TIMEOUT_MS` | `10000` | 单次审核请求超时 |
| `MODERATION_TOKEN_REFRESH_AHEAD_SEC` | `300` | `access_token` 提前刷新窗口（token 有效期 7200s） |
| `MODERATION_EXTRA_WORDS` | 空 | 自建补充词库，逗号分隔 |

**⚠️ 生产必须是 `wechat`。** `mock` 只跑 `@qz/core` 的内置词库
（`CAMPUS_LEXICON`，覆盖代考/刷单/校园贷等**字面固定**的校园灰色交易），
它拦不住变体与图片 —— 那是**合规缺口**，不是"降级优化"。
`/health` 的 `mockProviders` 里出现 `mock-moderation` 就是提醒。

**判定顺序**：本地词库（不花配额）→ 官方接口（唯一主判据）。
本地词库排在前面只是省配额，覆盖面一点没少。

**接口不可用时是 fail-closed**：抛 `50364 ModerationUnavailable`，**不放行内容**。
这一点与队列/缓存/限流的 fail-open 相反 —— 放行一条违规内容的代价是合规事故，
而拦住的代价只是用户重试一次。

**图片审核是异步的**：`mediaCheckAsync` 只收公网 URL、返回一个 `trace_id`，
结论要等微信推送到开发者服务器。所以 `checkImage` 返回
`pass:false + action:'review'`（结果到达前不放行），而不是 `pass:true`。

## 11c. 搜索（M4-07）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SEARCH_DRIVER` | `mock` | `mysql` = MySQL FULLTEXT；`mock` = 内存子串匹配 |
| `SEARCH_TIMEOUT_MS` | `5000` | 单次检索超时（防 FULLTEXT 退化成全表扫描后一直占连接） |

**选型结论：先用 MySQL FULLTEXT（零新组件）。** ADR-13 改用 MySQL 时已定了这条路。
Meilisearch / ES 留作后续替换 —— `SearchProvider` 接口不变，只换 driver。

**⚠️ 切 `mysql` 前必须先跑迁移 `20260919120000_add_search_index`**，
否则查询会报 `Table 'search_index' doesn't exist`（Provider 会把它翻译成
"请先执行数据库迁移"，但迁移本身不会自动跑）。

**⚠️ 中文必须带 `WITH PARSER ngram`**（迁移里已带）。MySQL 默认分词器按空格切词，
中文正文会被当成一个整词 —— 检索"摄影"匹配不到"校园摄影服务"，
而且**不报错、永远返回空**，表现为"搜索上线了但搜不出东西"。

## 11d. 短信（服务商尚未选型）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SMS_DRIVER` | `mock` | `http` = 走可配置网关；`mock` = 打日志不真发 |
| `SMS_GATEWAY_URL` | 空 | 网关地址 |
| `SMS_GATEWAY_TOKEN` | 空 | 网关 Bearer Token（留空表示不校验） |
| `SMS_GATEWAY_{PHONE,TEMPLATE,PARAMS}_FIELD` | `phone` / `templateCode` / `params` | 请求体字段名映射 |
| `SMS_TIMEOUT_MS` | `8000` | 单次发送超时 |

**为什么是"可配置网关"而不是直接对接阿里云/腾讯云**：服务商**尚未选型**，
而带签名的实现（阿里云 RPC HMAC-SHA1、腾讯云 TC3-HMAC-SHA256）
没有真实凭证就只能靠猜，签错了的表现是"接口返回签名错误"，排查成本很高。
选型定了之后新增一个实现同一个 `SmsProvider` 接口的 Provider 即可，业务代码零改动。

## 侧车（services/ai、services/media、services/convert）

| 变量 | 默认 | 说明 |
|---|---|---|
| `AI_SERVICE_URL` | `http://localhost:8000` | AI 侧车（抠图 / 人声分离），空则这两项明确不可用 |
| `MEDIA_SERVICE_URL` | `http://localhost:8001` | 媒体侧车（FFmpeg） |
| `MEDIA_TTS_BIN` | 空（未安装） | edge-tts 可执行文件（LGPLv3，须装在仓库外 venv）；留空则 `/media/tts` 返回 501 |
| `AI_SERVICE_TIMEOUT_MS` | `120000` | 抠图等**秒级**能力；⚠️ 与下面两个**不要合并**，量级不同 |
| `AI_SEPARATION_TIMEOUT_MS` | `900000` | 人声分离**单独**的超时：Demucs 在 CPU 上要跑"音频时长的 1~3 倍"，用 120s 会把正常且会成功的请求判成超时 |
| `MEDIA_SERVICE_TIMEOUT_MS` | `600000` | 转码是分钟级，用 120s 会误判超时 |
| `FFMPEG_TIMEOUT_SEC` | `600` | 侧车内单次 ffmpeg 调用的墙钟上限 |
| `SIDECAR_MAX_BODY_MB` | `512` | 侧车单次请求体上限（侧车入参是整段音视频） |
| `SERVICE_STAGE` | `skeleton` | `skeleton`/`beta`/`live`，进 `X-Service-Stage` 与 `/health` |
| `SOFFICE_BIN` / `PANDOC_BIN` | 空（查 PATH） | 转换引擎可执行文件；**不得装进仓库**（GPL，ADR-05） |
| `CONVERT_TIMEOUT_SEC` | `120` | 单次转换墙钟上限（LibreOffice 冷启动 5~15 秒） |

**⚠️ `SERVICE_STAGE` 做完能力后必须改掉**：它是"这个服务到底做没做完"的唯一对外信号，
留在 `skeleton` 会让监控把已完成的服务当成骨架，也会让排查的人误判。

**启动三个侧车**：
```bash
npm run dev:ai        # services/ai   → :8000
npm run dev:media     # services/media → :8001
python -m services.convert  # → :8002（需自装 LibreOffice / Pandoc）
```
`services/media` 与 `services/convert` **零 Python 依赖即可启动**，
真正的依赖是系统级二进制（ffmpeg / soffice / pandoc）。

**抠图权重**：首次调用 `/ai/matting` 会下载 u2net 权重（约 176MB）到
`~/.u2net/`。网络不通时可手动放置 `u2net.onnx`，或用 `U2NET_HOME` 指定目录。
⚠️ 从第三方镜像取的权重**必须核对来源**后再用于生产 —— 白名单纪律管的是"用了哪个模型"，
不是"从哪儿拿的权重"。

## 安全纪律（务必遵守）

1. `.env` **严禁提交到仓库**（`.gitignore` 已忽略，仅 `.env.example` 可入库）
2. 所有 Secret / API Key / 私钥**不要写进代码**，也不要贴在聊天记录里
3. 生产环境的 `JWT_SECRET` 必须是随机长串，不要复用开发值
4. 上线前检查 `LOG_MASK_SENSITIVE=true`
5. 变更第三方 Key 后需重启 API 生效
