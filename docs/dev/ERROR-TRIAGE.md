# 报错排查与修复计划

> 排查时间：2026-09-17 17:23
> 排查方式：**不照搬截图**。截图拍于 17:10，而数据库是 17:15 才建好的，部分报错已失效。
> 因此把小程序端声明的全部 40 个接口逐一实跑，以**当前实际返回**为准重新归因。
> 配套文档：功能与页面缺口清单见 `../product/青智校园_交付可用性排查报告.md` 附录 A

---

## 0. 结论摘要

截图里那一屏红字，**没有一条是"代码写错了"导致的**，它们分属 5 个完全不同的层次。
其中 **2 类是可以直接忽略的工具链噪音**，**2 类已经消失或属于环境配置**，
**只有 1 类（31 条 404）是真实的功能缺口**。

但排查过程中**额外发现了一个截图里看不到的 P0 缺陷**——见第 1.5 节，它会让小程序**永远登不进去**。

| 类别 | 条数 | 性质 | 现状 | 处置 |
|---|---|---|---|---|
| **A 工具链噪音** | 4 | 微信开发者工具/基础库自身输出，与项目代码无关 | 持续出现 | **忽略**（其中 1 条基础库版本已切稳定版） |
| **B 后端未启动** | 3 | 运维/环境 | **已消除**（API 已重启） | 建立"起服务再调试"的习惯 |
| **C 接口未实现（404）** | 31 | **真实功能缺口** | 持续 | 按里程碑补齐，见第 2、3 节 |
| **D 服务端 500** | 1 | 数据库不可达 | **已消除**（DB 已建好） | 无需处理；但暴露一个错误码设计问题 |
| **E 前端缺陷（截图里没有）** | 1 | **P0 代码缺陷** | **✅ 已修复**（见第 1.5 节） | 已修 + 已写入开发规范防复发 |

**当前实测状态**：小程序端 40 个调用点 → **8 个可用 / 31 个 404 / 1 个 400（正常） / 0 个 5xx**。

> ### 📌 修复记录（2026-09-17 17:40）
>
> 第 3 节「第 0 步」的 5 项已全部处理完毕，验证方式与结果见文末**第 4.1 节**。
> 其中 A1（基础库版本）由使用者在 17:28 自行切换为稳定版 `3.16.3`，
> 经查 `WeappVendor/cfg.json`，该版本 `status=1`（稳定），**灰度警告应已消失**。

---

## 1. 逐条分析

### 1.1 A 类：工具链噪音（4 条，建议全部忽略）

#### A1 ⚠️ `[基础库] 正在使用灰度中的基础库 3.17.3 进行调试`

| 项 | 内容 |
|---|---|
| **类型** | 警告（非错误） |
| **触发场景** | 开发者工具启动、每次编译时 |
| **可能原因** | `project.private.config.json` 里写死了 `"libVersion": "3.17.3"`，而该版本发布于 2026-09-16，**仍在灰度中** |
| **影响** | 灰度版行为可能与稳定版不一致，**会掩盖真实问题**（例如某些 API 行为变化），调试结论不可信 |
| **处置** | **建议改**。详情 → 本地设置 → 调试基础库，选一个稳定版；或直接删掉 `project.private.config.json` 里的 `libVersion` 字段让它跟随工具默认。这是 4 条里唯一建议动的一条 |

#### A2 ⚠️ `配置中未找到合法域名。web-view（业务域名）、TLS 版本以及 HTTPS 证书检查` + `工具未校验合法域名`

| 项 | 内容 |
|---|---|
| **类型** | 警告（非错误） |
| **触发场景** | 编译时 |
| **可能原因** | `project.private.config.json` 里 `"urlCheck": false`。这是**开发期必需的**——后端跑在 `http://127.0.0.1:3000`，不勾选"不校验合法域名"所有请求都会被拦 |
| **影响** | 无。这是预期状态 |
| **处置** | **不处理**。但要在 M5-06（小程序审核材料）时记得：上线前必须在小程序后台登记 request 合法域名（HTTPS），并把 `apps/mp/utils/env.ts` 的 `ENV` 改成 `release`。`docs/dev/WECHAT-DEVTOOLS.md` 已记录该事项 |

#### A3 ℹ️ `The resource .../WAServiceMainContext.js was preloaded using link preload but not used within a few seconds`（出现 2 次）

| 项 | 内容 |
|---|---|
| **类型** | 信息（非错误） |
| **触发场景** | 开发者工具渲染层加载时 |
| **可能原因** | 微信基础库自身的资源预加载策略提示，**与项目代码完全无关** |
| **处置** | **忽略**。这条在几乎所有小程序项目里都会出现，搜不到也不需要修 |

#### A4 ℹ️ `[worker] reportRealtimeAction:fail not support`

| 项 | 内容 |
|---|---|
| **类型** | 信息（非错误） |
| **触发场景** | 开发者工具 Worker 线程上报实时调试动作 |
| **可能原因** | 该 API 在非真机环境下不支持，属工具内部噪音 |
| **处置** | **忽略** |

> 另外截图里的 `preloadSubpackages: toolbox` / `success` 与 `[system] No. of subpackages: 4` 是**正常日志不是错误**——
> 说明分包预下载配置生效了。不要被绿色/白色输出混在红字里误导。

---

### 1.2 B 类：后端未启动（3 条，已消除）

#### B1 `GET .../tools/categories net::ERR_CONNECTION_REFUSED`

| 项 | 内容 |
|---|---|
| **类型** | 网络错误 |
| **触发场景** | 工具箱页 / 首页 onLoad 发请求时，**后端进程不在** |
| **可能原因** | 截图里同一批请求先返回 **404**（后端在跑），随后同一路径变成 **ERR_CONNECTION_REFUSED**（后端没了）——说明**后端在调试过程中崩了**。实际原因是：执行 `prisma migrate dev` 时会重新 `prisma generate`，而 `nest start --watch` 恰好在客户端文件被替换的瞬间重启，报 `MODULE_NOT_FOUND: @prisma/client/default.js` 后退出 |
| **影响** | 所有请求失败，页面显示"网络开小差了，请检查网络后重试" |
| **处置** | **已消除**（API 已重启，当前 `/health` = `database: up`）。预防：跑 `db:migrate` / `db:generate` 前先停掉 dev server |

#### B2/B3 `GET .../tools net::ERR_CONNECTION_REFUSED`、`GET .../station/tasks?status=published net::ERR_CONNECTION_REFUSED`

同上，是 B1 的连带。

#### B 类第二次复现（2026-09-18 11:52）—— 附"怎么一眼判定"的判别法

> 截图时间 11:51:54，控制台里 6 条 `ERR_CONNECTION_REFUSED`（`/auth/me`、`/config/public`、
> `/health`、`/tools`、`/station/tasks`、`POST /auth/login`）+ 1 条 `POST /os/sessions 401`。
> **又是 B 类，不是代码问题** —— 后端进程起于 **11:50:14**，红字是它起来之前打出来的。

**判别法（两条，10 秒内出结论）：**

1. ⭐ **看同一批请求里有没有"不是 connection refused 的响应"。**
   本例里最后那条 `POST /os/sessions → 401` 是**真实 HTTP 响应** ——
   说明服务此刻已经活了，前面那些红字是**旧 scrollback**（控制台不清屏，历史报错会一直挂着）。
   *全是 refused → 服务真没起；出现 401/404/500 → 服务是活的，红字已过期。*
2. **一行确认服务在不在**：
   ```bash
   curl -s -o /dev/null -w "health:%{http_code}\n" http://127.0.0.1:3000/api/v1/health   # 期望 200
   ```
   要核对"什么时候起的"，用 PowerShell 拿 PID 与启动时间，再与截图时间比：
   ```powershell
   Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object {
     $p = Get-Process -Id $_.OwningProcess
     "$($p.Id) 启动于 $($p.StartTime)"
   }
   ```

**那条 401 是连带，不是独立问题**：`app.ts` 的静默登录（`POST /auth/login`）失败 →
本地没有 token → 后续 `POST /os/sessions` 必然 401。
**修好"服务没起"这一条，401 自己就没了**，不要单独去查它。

⚠️ **别拿小程序的错误文案当线索**：`utils/request.ts` 的 `fail` 分支把所有网络失败
统一成 `网络开小差了，请检查网络后重试`，**看不出到底是"后端没起"还是"网线断了"**。
要区分只能看控制台的原始 `net::ERR_*`。

> **当前后端的启动方式（本机）**：`node --enable-source-maps apps/api/dist/main`
> —— 是**一次性进程，不是 watch**。改了 `apps/api/src` 下的代码必须
> `npm run build -w @qz/api` 后重启，否则服务跑的还是旧产物（改了没生效，很容易误判成"代码没写对"）。

---

### 1.3 C 类：接口未实现（31 条 404，**真实缺口**）

#### C1 `GET /api/v1/tools 404 (Not Found)`

| 项 | 内容 |
|---|---|
| **类型** | 业务错误（HTTP 404） |
| **触发场景** | 首页「热门工具」区块、工具箱页列表加载 |
| **可能原因** | **接口根本不存在**。后端只有 `auth` / `health` / `user` 三个模块；`tool` 表结构已建、seed 已灌 32 条数据，但没有任何 Controller 把它暴露出来 |
| **影响** | 首页「热门工具」永远为空；工具箱页有 `FALLBACK_CATEGORIES` 兜底所以不白屏，但**工具列表永远为空** |
| **处置** | 实现 M1-01（工具目录接口）。⚠️ 注意先解决工具目录本身缺 9 项、缺 2 个分类的问题，见配套文档第 7.1 节 |

#### C2 `GET /api/v1/tools/categories 404`

同 C1，对应 M1-01 的分类接口。工具箱页靠 `FALLBACK_CATEGORIES` 硬编码兜底，所以**界面看起来正常，实际数据没来**——这类"降级掩盖缺口"的情况要注意，容易误判为已完成。

#### C3 `GET /api/v1/station/tasks?status=published 404`

| 项 | 内容 |
|---|---|
| **类型** | 业务错误（HTTP 404） |
| **触发场景** | 驿站页任务大厅加载、首页「热门服务」区块 |
| **可能原因** | `station` 模块不存在（M3-08 未开工）。`task` 表已建但无接口 |
| **影响** | 任务大厅永远为空并显示错误态 |
| **处置** | 实现 M3-08；但按依赖链，它排在 M1/M2 之后 |

**其余 28 条 404 的完整清单**（实测，按命名空间分组）：

| 命名空间 | 404 数量 | 涉及端点 |
|---|---|---|
| `toolboxApi` | 6 | `/tools/categories`、`/tools`、`/tools/{name}`、`POST /tools/{name}/invoke`、`/jobs`、`/jobs/{id}` |
| `fileApi` | 2 | `GET /files`、`DELETE /files/{id}` |
| `stationApi` | 7 | `/station/categories`、`/station/tasks`、`/station/tasks/{id}`、`POST /station/tasks`、`POST /station/parse`、`POST /station/tasks/{id}/apply`、`/station/match` |
| `orderApi` | 7 | `/orders`、`/orders/{id}`、`POST /orders`、`/pay`、`/deliver`、`/accept`、`/refund` |
| `osApi` | 8 | `/os/sessions`（GET/POST）、`/os/sessions/{id}/messages`（GET/POST）、`/os/intent`、`/os/runs/{id}`、`/confirm`、`/nodes/{nodeId}/publish` |
| `messageApi` | 1 | `/notifications` |

> 注：`GET /auth/me`、`/user/*` 共 8 个可用；`POST /auth/refresh` 传非法 token 返回 400 属**正常**的参数校验行为，不是缺陷。

---

### 1.4 D 类：服务端 500（1 条，已消除）

#### D1 `POST /api/v1/auth/login 500 (Internal Server Error)` → `[app] 登录失败: 服务器开小差了，请稍后重试`

| 项 | 内容 |
|---|---|
| **类型** | 服务端异常 |
| **触发场景** | 小程序冷启动时的静默登录（`app.ts`） |
| **可能原因** | **数据库不可达**。截图时间为 17:10，而 `qingzhi` 库与 `qz` 账号是 17:15 才创建的；此前 Prisma 报 `Authentication failed against database server, the provided database credentials for 'qz' are not valid`。该异常在 `GlobalExceptionFilter` 里落到兜底分支 → `ErrorCode.InternalError` → HTTP 500 |
| **影响** | 登录不可用。但因 `app.ts` 是**静默登录**（失败不阻塞浏览态），所以小程序仍能打开，只是"我的"等需要登录的页面不可用 |
| **处置** | **已消除**。当前 `/health` 返回 `database: up`，登录返回 201 且能正常签发 token |

> **顺带暴露一个设计问题**：数据库不可用时返回笼统的 `500 + 服务器开小差了`，
> 前端无法区分"服务崩了"和"数据库挂了"，排查全靠翻后端日志。
> 建议在 `GlobalExceptionFilter` 里识别 Prisma 连接类异常，返回 **503 + 明确错误码**，
> 让小程序能提示"服务维护中"而不是"服务器开小差了"。

---

### 1.5 E 类：前端代码缺陷（**P0，截图里看不出来，但会让登录永远失败**）

#### E1 `apps/mp/utils/request.ts` 只接受 HTTP 200，导致所有 POST 被误判为失败

| 项 | 内容 |
|---|---|
| **类型** | **代码缺陷（P0）** |
| **位置** | `apps/mp/utils/request.ts:180` |
| **现状代码** | `if (res.statusCode === 200 && body && body.code === 0) { resolve(body.data); return; }` |
| **触发场景** | **任何 POST 请求**。当前唯一的 POST 是 `POST /auth/login`，即**小程序登录** |
| **可能原因** | NestJS 对 `@Post()` 默认返回 **201 Created**，而这里写死了 `=== 200`；项目里**没有任何 `@HttpCode(200)` 改写**，`TransformInterceptor` 也不改状态码 |
| **实测证据** | ① `curl -X POST /api/v1/auth/login` → **HTTP 201**（响应体 `code: 0`）；② 同一个项目里 `packages/sdk/src/client.ts:100` 用的是 `result.ok`（200–299 全接受）——**写法正确**，只有小程序这一层写死了 200 |
| **影响** | **所有 POST 即使后端成功也会被前端当失败抛出**。而且抛出的错误文案是 `body.message`，即字符串 **`'ok'`** —— 用户会看到一个写着"ok"的报错 toast，几乎无法排查 |
| **修复** | 一行：`if (res.statusCode >= 200 && res.statusCode < 300 && body && body.code === 0)` |
| **为什么截图里没暴露** | 截图那一刻登录返回的是 500（DB down），走的是错误分支，恰好绕过了这个判断。**DB 修好之后，这个 bug 才会浮出来** |

> **这是本次排查最值钱的发现**：修好数据库之后，"登录失败"并不会消失，只会从"服务器开小差了"变成"ok"。
> 如果只盯着截图里的红字去修，会在这里卡很久。

---

## 2. 尚未实现的功能与页面清单

完整清单（逐项含名称 / 所在位置 / 未完成的具体内容）见
**`../product/青智校园_交付可用性排查报告.md` 附录 A**（原《未完成功能与页面排查》已并入该附录），此处只给摘要：

| 维度 | 设计 | 已实现 | 完成度 |
|---|---|---|---|
| 后端接口 | 104 个 | **10 个** | **9.6%** |
| 后端业务模块 | 12 类 | **3 个**（auth / health / user） | 25% |
| 小程序页面 | 26 个 | 26 个文件齐全，**只有 4 个能真正读到后端数据** | 15% |
| 管理后台 `apps/admin` | 1 个应用 | **只有 1 个占位 README，0 行代码** | 0% |
| Python 服务 | 12 个端点 | 0 个（已登记，统一返回 501） | 仅 `/health` |
| M0 底座 | 23 项 | 20 项 | 87% |
| M1~M5 | 82 项 | **0 项** | 0% |

**页面侧**：✅ 5 个 / 🟡 2 个（降级空内容）/ 🟠 10 个（已写逻辑但接口不存在）/ ⬜ 9 个（显式占位骨架）。

---

## 3. 处理建议与执行顺序

### 第 0 步：立即做 —— ✅ 已全部完成

| 顺序 | 事项 | 位置 | 状态 | 改动内容 |
|---|---|---|---|---|
| 0.1 | **修 POST 201 判断**（E1） | `apps/mp/utils/request.ts` | **✅ 已修** | 抽出 `isHttpSuccess()`，判定改为接受整个 2xx 区间；原 `=== 200` 会把登录等所有 POST 的成功响应判成失败 |
| 0.2 | 调基础库到稳定版（A1） | `project.private.config.json` | **✅ 已完成** | 由使用者切为 `3.16.3`（经 `WeappVendor/cfg.json` 核对 `status=1`，确为稳定版） |
| 0.3 | 确认 API 常驻 | `npm run dev:api` | **✅ 已确认** | 当前 `/health` = `database: up`。预防措施：跑 `db:migrate` / `db:generate` 前先停 dev server |
| 0.4 | 注册 `ThrottlerModule` | `apps/api/src/app.module.ts` | **✅ 已修** | 注册模块 **+ 关键补充**：把 `ThrottlerGuard` 注册为全局 `APP_GUARD`（只 import 模块不会生效）；`/health` 加 `@SkipThrottle()` 豁免 |
| 0.5 | 绑定 Prisma 日志监听 | `apps/api/src/infra/prisma/prisma.service.ts` | **✅ 已修** | 绑定 `$on('warn')` / `$on('error')`；同时给类显式声明日志事件泛型，否则 `$on` 参数被推断为 `never` 而编译失败 |

> 0.1~0.3 完成后，小程序即可正常登录，「我的 / 钱包 / 信用」4 个页面立即可用。
> 详细验证证据见第 4.1 节。

**顺带落地的一条防复发措施**：把 HTTP 状态码约定写进了
`docs/rules/DEVELOPMENT-STANDARDS.md`（「二、架构约束 → 接口与 HTTP 状态码约定」）。
E1 的根因不是写错一行代码，而是**"成功 = 200"这条隐含假设从来没被写下来** ——
后端按框架默认返回 201，前端按直觉写死 200，两边都没错，但拼在一起就是错的。

### 第 1 步：把 404 从 31 降到 0 的路径（按依赖链，不要按页面顺序）

> **进度（2026-09-17 19:20）**：**① 解锁前置全部完成**；
> **② 跑通 L1 已完成 M1-01 ✅ / M1-02 ✅ / M1-03 ✅，且「一句话 → .pptx」验收线已实测通过**。
> ③④ 待做。**这一步整体约 112 人天（M1 32 + M2 33 + M3 47）**，需按顺序分批推进。
>
> **存储选型已定**（2026-09-17）：**开发用 `local` 本地文件系统驱动，后期切腾讯云 COS**。
> `STORAGE_DRIVER=local` 已成为开发默认，不再依赖任何外部对象存储
> —— 这也顺带解除了 MinIO 停止分发的隐患（见第 4.3 节）。

```
① 解锁前置（不做这两项，后面全卡）        ✅ 已完成
   M0-11 Redis 封装          apps/api/src/infra/redis/
   M0-12 对象存储 Provider   apps/api/src/infra/providers/storage/ + apps/api/src/modules/file/
   → 没有它们，文件上传与异步任务都做不了

② 跑通 L1（清掉 toolboxApi 6 个 + fileApi 2 个 404）  🔄 进行中（约 32 人天）
   M1-01 工具目录接口        apps/api/src/modules/tool/           ✅ 已完成
   M0-12 文件资产接口        apps/api/src/modules/file/           ✅ 已完成
   M1-02 工具调用入口        apps/api/src/modules/tool/tool-invoke.service.ts   ✅ 已完成
   M1-03 Job 异步执行体系    apps/api/src/modules/job/            ✅ 已完成
        └─ 执行器已接入 5 个工具：compress_image / convert_image /
           remove_background / enhance_image / generate_ppt
   【验收线】一句话 → 60s 内下载到可编辑 .pptx   ✅ **已实测通过（实际约 1 秒）**
        产出：`校园二手交易平台商业计划书.pptx`，113886 字节，
        zip 内含 10 张 slide + [Content_Types].xml，可被 zipfile 正常解析
   → M1-04 队列 Worker（Redis Stream）→ M1-05 进度推送 → M1-06 计费 → M1-07~M1-12 各工具

③ 跑通 OS（清掉 osApi 8 个 404）
   M2-01 会话 → M2-04 意图 → M2-05 planner → M2-06 状态机
   → M2-08 Registry → M2-09 Executor → M2-10/11 Agent → M2-13 HITL → M2-16 交付包
   【验收线】复合需求 → ≥8 节点计划并可执行

④ 跑通驿站（清掉 stationApi 7 个 + orderApi 7 个 + messageApi 1 个 404）
   M3-01 分类 → M3-02 认证 → M3-04 服务 → M3-06/07 发布 → M3-08 大厅 → M3-09 匹配
   → M3-10 报名 → M3-11 订单状态机 → M3-12 支付 → M3-13 钱包 → M3-14 交付验收
   → M3-15 退款 → M3-16 评价 → M3-17 工作台 → M3-18 页面 → M3-19 消息 → M3-21/22 闭环
   【验收线】发布 → 接单 → 支付 → 交付 → 验收 → 评价全通

⑤ 可运营
   M0-23 + M3-20 管理后台（不阻塞前面，但 M3 结束前必须有）
```

### 第 2 步：结构性改进（防止同类问题复发）

| 事项 | 理由 | 状态 |
|---|---|---|
| **统一 HTTP 状态码约定并写进 `docs/rules/DEVELOPMENT-STANDARDS.md`** | 这次是"前端写死 200 / 后端默认 201"，根因是**约定没写下来**。已明确采用"成功 = 任意 2xx，客户端禁止写死 200" | **✅ 已完成** |
| **给 `GlobalExceptionFilter` 加数据库异常识别** → 返回 503 + 明确错误码 | 本次 D1 就是被兜成 500，前端无法区分"服务崩了"与"数据库挂了" | 待做 |
| **CI 加数据库 job**（`services: mysql:8.4` 跑 `db:deploy` + `db:seed`） | 当前 CI 不启数据库、不跑迁移，迁移 SQL 的正确性没有自动守护 | 待做 |
| **给 mp 请求层补单测** | `request.ts` 是全局唯一出口，一个状态码判断错误就影响所有接口，却没有任何测试覆盖。注意 `vitest.config.ts` 的 `include` **不包含 `apps/mp`**，需先扩展配置 | 配置已扩展（见第 5 节），`request.ts` 的单测待补 |
| **生产部署前确认 `trust proxy`** | 限流按客户端 IP 计数，部署在 nginx 之后若不开启 `trust proxy`，所有请求会被识别为同一代理 IP，**上线后大面积 429** | 待做（已写入规范第五节） |

---

## 4. 修复验证记录

### 4.1 验证方式与结果（2026-09-17 17:40）

所有验证都在**独立端口 3100 的实例**上做，不影响正在使用的 3000 端口。

#### ① E1（P0）：真实请求 + 真实模块，对比修复前后

不是"看代码觉得对了"，而是加载小程序**真实的** `apps/mp/utils/request.ts`，
向**真实的**后端发一次登录请求，把同一个响应用两种判定逻辑各跑一遍：

```
真实请求：POST /auth/login
  HTTP 状态码 : 201
  业务码 code : 0
  message     : ok
  拿到 token  : 是

套用小程序请求层的判定逻辑：
  修复前 (statusCode === 200)      → 失败 ❌
     └─ 抛出的错误文案会是: "ok"   ← 用户会看到一个写着 ok 的报错
  修复后 (isHttpSuccess(statusCode)) → 成功 ✅

结论：修复生效 —— 同一个真实响应，修复前判失败、修复后判成功
```

这一条同时**印证了第 1.5 节对症状的预测**：错误文案确实会是 `"ok"`。

判定函数本身的边界用例（11/11 通过）：

| 状态码 | 期望 | 说明 |
|---|---|---|
| 200 / 201 / 202 / 204 | 成功 | 201 是本次修复的核心目标 |
| 301 | 失败 | 重定向不应视为成功 |
| 400 / 401 / 403 / 404 / 429 / 500 | 失败 | 错误状态不能被当成成功 |

#### ② 0.4 限流：实测触发点

对受保护接口连打 125 次（配置为 120 次 / 60 秒）：

```
125 次结果分布: {401: 120, 429: 5}
第 121 次请求首次出现 429 —— 限流已触发 ✅
```

**这个结果同时证明了 TTL 单位换算是正确的**：`@nestjs/throttler` v5+ 的 `ttl` 单位是**毫秒**，
若直接把配置里的 `60` 当毫秒用，窗口会变成 60ms，限流永远不会触发。

`/health` 豁免验证：连打 130 次 → `{200: 130}`，**全程未被限流** ✅

#### ③ 0.5 Prisma 日志：制造真实事件

查询一张不存在的表，确认监听器确实收到了事件：

```
✅ 收到 1 条事件：
   [error] Invalid `prisma.$queryRawUnsafe()` invocation: Raw query failed.
           Code: `1146`. Message: `Table 'qingzhi.__table_does_not_exist__' doesn't exist`

正常查询产生的新事件数: 0（预期 0）
```

说明监听器既能收到事件、也不会给正常查询带来噪音。

#### ④ 回归检查

| 检查 | 结果 |
|---|---|
| `npm run typecheck`（全量，含 `typecheck:mp`） | ✅ 无错误 |
| `npm run build -w @qz/api` | ✅ 通过 |
| `npm test` | ✅ 通过 |
| `npm run smoke` | ✅ 通过 |

### 4.2 复现命令

```bash
# 起后端
npm run dev:api

# 确认数据库与版本（应为 database: up）
curl -s http://127.0.0.1:3000/api/v1/health

# 确认 POST 返回的是 201（E1 的根因）
curl -s -o /dev/null -w "POST /auth/login -> HTTP %{http_code}\n" \
  -X POST http://127.0.0.1:3000/api/v1/auth/login \
  -H "Content-Type: application/json" -d '{"code":"probe"}'

# 确认限流生效（连打 125 次，第 121 次应出现 429）
for i in $(seq 1 125); do
  curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/api/v1/user/me
done | sort | uniq -c

# 确认工具接口确实不存在（C1/C2）
curl -s -o /dev/null -w "GET /tools -> HTTP %{http_code}\n" http://127.0.0.1:3000/api/v1/tools

# 冒烟
npm run smoke
```

### 4.3 ⚠️ 选型风险：MinIO 开源版已归档、官方不再分发

做 M0-12 时想下载 MinIO 单文件二进制来做真实的直传验证，结果拿到的是 **HTTP 410 Gone**：

```
The open-source MinIO Server, MinIO Client (mc) and MinIO KES projects are
archived and no longer maintained. MinIO does not provide product support,
security updates, or security advisories for them, and does not accept or
process vulnerability reports concerning them.
These files are no longer served from this site. This applies to all
community releases and to all hotfix builds for them.
```

**已验证的事实**：MinIO Server / Client(mc) / KES 的开源版已归档，`dl.min.io` 不再提供任何社区版与 hotfix 构建。
**未能确认的**：Docker Hub 上的 `minio/minio` 镜像是否仍可拉取（查询接口在本环境无响应）。

**对本项目的影响**：

| 项 | 现状 | 风险 |
|---|---|---|
| `STORAGE_DRIVER` 默认值 | `minio` | 默认指向一个已停止维护的组件 |
| `docker-compose.yml` | 本地对象存储用 MinIO 镜像 | 镜像即便还能拉，也已冻结、无安全更新 |
| ADR-04 存储选型 | 未把"上游停维护"纳入评估 | 需要补充决策记录 |

**✅ 已决策（2026-09-17）：开发用 `local`，后期切腾讯云 COS**

| 环境 | 驱动 | 说明 |
|---|---|---|
| 开发 / 自测 | **`local`** | 本地文件系统，**不依赖任何外部服务**。已设为 `STORAGE_DRIVER` 的默认值 |
| 生产 | `cos`（腾讯云） | **尚未实现**：需接官方 SDK 并实测。S3 兼容层在分片与签名细节上有差异，未实测前不装配 |
| 兼容性验证 | `minio` | 保留实现（S3 协议），但因上游停止分发，仅作"想验证 S3 协议"时的可选依赖 |
| — | `oss` | 同样未实现，同 `cos` 的处理方式 |

**`local` 驱动的实现要点**：

- 落盘目录 `LOCAL_STORAGE_DIR`（默认 `./data/uploads`，已 gitignore）；
- 直传端点 `PUT /files/local/:token`、下载端点 `GET /files/local/:token`，
  用 **HMAC-SHA256 签名的短时效令牌**鉴权（与 S3 presign 语义一致：不可伪造、会过期），
  不是开放的上传地址；
- 路径穿越 fail-closed：对象键越出存储根目录直接抛错，不做"静默清洗"；
- 上传走**流式落盘**（`putObjectStream`），不把整个文件读进内存
  （视频上限 500MB，全量 buffer 会 OOM）。

> **与 ADR-04 的关系（必须知道）**：ADR-04 要求"后端只签发、不中转二进制"，那是针对**生产**。
> `local` 驱动下后端**就是**存储本身，二进制必然经后端 —— 这是该驱动固有的取舍，**仅限开发环境**。
> 切到 COS 后 presign 会返回对象存储的真实直传地址，回到 ADR-04 的正轨。


---

## 5. 本轮新增（2026-09-17 晚）：M0-12 收尾 + M1-04 / M1-05 / M1-06

### 5.1 已交付并**实测通过**的三条验收线

三个脚本都在 `scripts/dev/`，都是"真实后端 + 真实数据库"，没有 mock：

| 脚本 | 覆盖 | 关键结论 |
|---|---|---|
| `verify-l1-ppt.py` | L1 主链路：一句话 → 真实 .pptx → 可下载 | 产出 **113,886 字节** pptx，魔数 `PK` + 含 `[Content_Types].xml` + `ppt/` |
| `verify-realtime.mjs` | M1-05 进度推送 | 握手鉴权拒绝 4401；订阅即下发快照（断线补齐）；实测进度序列 `0→0→20→55→90→100` **单调不减** |
| `verify-billing.mjs` | M1-06 积分计费 | 三条路径 + 幂等 + **对账相符**（流水净额 = 余额变化，余额从未为负）。**要求计费已开启**，模式不符会直接提示退出 |
| `verify-billing-modes.mjs` | 计费开关一致性（免费态 / 计费态**都能跑**） | 读 `/config/public` 声称的模式，再用**一笔真实作业**证明后端确实照做：免费态积分一分不动、零余额也不报 403；计费态恰好扣一个单价且流水可对账。切换开关的设计见 `docs/dev/BILLING-MODES.md` |

### 5.2 ✅ 已修复：幂等键未按用户分区（缺陷 → 已加迁移）

**原缺陷**：`tool_job.idempotency_key` 是**全局唯一**，且 `JobService` 的回读只按 key 查、
不带 userId。后果：用户 B 使用与用户 A 相同的 `Idempotency-Key` 时，会拿到 A 的 jobId，
且 B 自己的请求被静默丢弃（`reused=true`，不执行、不扣费），随后访问该 jobId 会得到 403。

- **实测证据**：`verify-l1-ppt.py` 原先用固定 key `e2e-idem-ppt-1`，新用户直接命中了旧用户的作业。
- **修复（三处必须同时改，漏一处就等于没改）**：
  1. `schema.prisma`：`idempotencyKey String? @unique` → `@@unique([userId, idempotencyKey])`
     （幂等的语义本来就是"同一用户、同一请求只执行一次"，全局唯一等于让所有用户共享键空间）；
  2. 迁移 `20260917120600_scope_idempotency_by_user`：删旧唯一索引、建复合唯一索引
     （执行前已确认 0 条重复，建索引不会失败；MySQL 唯一索引允许多个 NULL，未带键的作业不受影响）；
  3. `JobService`：`findByIdempotencyKey(key)` → `findByUserAndKey(userId, key)`，
     用 `findFirst` 而非 `findUnique`（语义等价、命中同一个唯一索引，
     且不需要重新 `prisma generate` 才能通过类型检查）。
- **验证**：`verify-l1-ppt.py` 新增第 ⑦ 步 —— 两个用户用同一个 key，
  实测得到**两个不同的 jobId**、用户 B 的 `reused` 不为 true；单测补 3 条回归用例
  （跨用户互不干扰 / 并发撞约束时读回的是自己的 / 别人的键不会被冒领）。

> ⚠️ 仍待办：`prisma generate` 尚未重跑（当前 `migrate deploy` 不触发它，也不需要它）。
> 客户端里关于 `idempotency_key` 的唯一性描述因此**仍是旧的**（DMMF 层面）。
> 影响：如果有人写出 `findUnique({ where: { idempotencyKey } })`，类型检查会放过它，
> 而运行时会退回"跨用户命中"的旧行为。**建议停掉 dev server 后执行一次 `npm run db:generate`**，
> 让客户端与 schema 对齐（历史坑：generate 会被运行中的服务占用查询引擎 DLL 而 EPERM）。

### 5.3 工程缺口：`apps/mp` 无法引用 `packages/core`（**已决定暂不修**）

`apps/mp` 没有 `package.json`、不参与 npm workspaces，微信开发者工具里
`require('@qz/core')` 解析不到。因此 M1-05 的进度合并规则在 `apps/mp/utils/progress.ts`
里是 core 的**镜像实现**，靠 `tests/mp/progress.spec.ts` 的**漂移守卫**
（7 状态 × 4 进度 × 2 阶段的笛卡尔积逐条比对两份实现）防走偏。

**为什么现在不做**：打通它需要给 `apps/mp` 加 `package.json` + 依赖 `@qz/core` +
开发者工具执行「构建 npm」。而当前小程序**只用到 core 的一个函数**（`mergeProgress`），
为它引入一条 npm 构建链属于过度工程；更关键的是「构建 npm」只能在开发者工具里手动点，
在没验证过的前提下改动模块解析方式，风险是把一个**现在能正常跑**的小程序改坏。
→ 结论：**等小程序真正需要复用多个 core 模块时再做**，届时一次把镜像删掉。
在那之前，防漂移由单测保证（这是可执行的保证，不是"记得同步改"）。

### 5.4 本轮新增：驿站只读切片（消除首页 404）

现象：首页与驿站 Tab 加载时都会请求 `GET /station/tasks?status=published`，
该接口未实现 → 控制台持续红字 404，把真正的错误淹掉。

修法：实现**只读**那一段（写路径仍留 404，属 M3）——

| 接口 | 说明 |
|---|---|
| `GET /station/tasks` | 任务大厅。公开只读，支持 `categoryId` / `keyword` / `status` / `page` / `size` |
| `GET /station/tasks/:id` | 任务详情，公开只读，浏览量 +1（尽力而为，失败不影响返回） |

两个设计点：
1. **不传 `status` 时默认只看已发布** —— 任务大厅的语义就是"可接的活"，
   draft / reviewing 出现在大厅是产品事故（用户会看到别人没写完的草稿）；
2. **关键词用 LIKE 而非全文索引** —— 当前数据量（校园内几百条）够用，
   引入 MySQL 全文索引要额外迁移与分词策略，只为不存在的规模付复杂度成本不划算。

seed 补 4 条**演示任务**（`taskNo` 幂等 upsert），否则页面只能显示空态、
无法验证列表渲染/筛选/分页/详情的真实效果。这是开发演示数据，
落在真实表、走真实查询路径、与真实用户外键关联 —— 不是"用假数据冒充功能"。

### 5.5 两条前端修复（截图里的另外两个红字）

**① `utils/__tests__` 目录被点名**：`project.config.json` 的 `miniprogramRoot` 就是
`apps/mp/`，即**发布包本身**。包内任何没被引用到的文件都会被开发者工具的
「过滤无依赖文件」分析点名（`ignoreUploadUnusedFiles: true`）。
→ 小程序测试一律移到 `tests/mp/`（`vitest.config.ts` 的 include 已覆盖），
并在 `packOptions.ignore` 加了 `__tests__ / *.spec.*` 兜底。

**② `startDeviceMotionListening:fail 开发者工具暂时不支持此 API`**：
`fx.ts` 的 `fxEnableTilt` 调 `wx.startDeviceMotionListening` 时**没传 `fail` 回调**，
异步失败被 SDK 当成未捕获异常打印成红色 `appServiceSDKError` + 堆栈。
→ 补 `fail`（静默降级：倾斜视差只是装饰增强，不支持时触摸视差照常工作）；
顺带修了两处相关问题：监听器改为**全局只绑一次**（原先每次 onShow 都可能重复注册），
`fxDisableTilt` 真正调用 `stopDeviceMotionListening`（原注释写"停止接收传感器数据"，
实际只是把宿主置空，传感器一直开着耗电）。

### 5.6 测试覆盖的两条经验

1. **`vitest.config.ts` 的 `include` 已扩展到 `apps/mp`**：小程序的纯逻辑（进度合并等）
   不依赖 wx API，可以在 Node 里验证。此前没有覆盖，这类逻辑只能靠开发者工具里手点 ——
   而"点了没反应"恰恰是最难回溯的一类问题。
2. **假对象替代不了协议**：Redis Stream 队列的单测起了一个**讲真实 RESP 的 TCP 替身**
   （`apps/api/src/infra/providers/queue/__tests__/`），让真实 ioredis 连上去。
   理由是假对象只能验证"我对回复形状的假设"，验证不了命令拼接是否正确
   （参数顺序错、少一个 `COUNT` 关键字，假对象照样通过）。
   它也确实抓出了一个真问题：**阻塞式 `XREADGROUP BLOCK` 会独占整条连接**，
   与缓存/锁/限流共用会把它们一起拖慢（不报错、只变慢）—— 已改为 `client.duplicate()` 专用连接。
   仍需真机验证的部分：`BUSYGROUP` 文案形态、XAUTOCLAIM 在 6.2/7.x 的回复差异、大流量 BLOCK 行为。

---

## 6. 本轮新增（2026-09-21）：练习中心显示问题（繁体 / 自造令牌 / mode 泄漏）

> 触发：用户截图报「部分功能与图标不可见、文字位置错乱、**混入繁体字**」。

### 6.1 四类问题各自的根因（**没有一类是"代码写错"**）

| # | 现象 | 真实根因 | 为什么一路绿灯 |
|---|---|---|---|
| ① | 页面白屏 | `api.ts` 声明 `GET /practice/modules` 返回**数组**，后端实际返回 `{ modules: [...] }`；`list.map` 崩 | TS 泛型是**断言的**，不校验运行时形状；接口 200、字段齐、无报错 |
| ② | 文字颜色与主题不搭、位置看着别扭 | `pkg-practice` 三个页面 SCSS 写了 `var(--color-text-primary, #212121)` 这类**自造令牌**（项目里根本没有 `--color-text-*`）。带兜底值让它**永远取到兜底灰**，装扮成"优雅降级" | 编译 / tsc / lint / 全部守卫**都不看 CSS 变量是否定义** |
| ③ | 顶部进度条右侧露出英文单词 | 服务端 `mode` 字段是枚举（`chunks`/`recall`），WXML 直接 `{{mode}}` 渲染 | 有值、类型对、渲染成功 —— 只是那个值不该给人看 |
| ④ | 中译/选项里冒出繁体 | **两个独立来源**：语料（Tatoeba）与代码文案。语料侧 `fetch-sentences` 有过过滤但**词书侧完全没有** | 数据里多几个字，没有任何检查项会为它报警 |

> ②的纵深原因：全仓 46 个 SCSS 里，**唯独这三个没有 `@import '../../styles/tokens.scss'`**。
> 页面作者拿不到 `$text-1` 这类 SCSS 变量，就顺手写了看起来更"标准"的 CSS 变量 —— 一个能自洽的错。

### 6.2 处置

- ① 新增 `PracticeModulesResult` 类型；调用处取 `listRes.modules`；`toView` 加 `Array.isArray` 兜底。
- ② 三个 SCSS 补 `@import` + 17 处令牌换回 `$text-1/-2/-3`。
- ③ 新增 `modeText`（`practice-view.ts` 的 `modeTitle()` 本来就在，只是没接上；WXML 改用它）。
- ④ **一处字表，三处消费**：`scripts/db/traditional-chars.mjs`（724 字）←
  `fetch-sentences.mjs`（筛语料）/ `gen-words.mjs`（导词书）/ `audit-mp-bindings.mjs`（查界面文案）。

### 6.3 ⭐⭐ 语料过滤 ≠ 库里干净（本轮最贵的一课）

`sentences.jsonl` 重新过滤干净（0 条繁体）之后，**界面照样满屏繁体**，因为：

1. `gen-sentences.mjs` 对已存在的句子**只更新语块、不更新中译** —— 重跑导入**不会**清掉旧繁体；
2. 库里的 21,039 条是**过滤前**灌进去的，其中 **3,210 条**含繁体；
3. 词库侧同样：完整重灌后仍剩 3 条（`真核細胞` / `悠閒的日光浴` / `結合蛋白`）。

**症状极具迷惑性：文件干净、守卫全绿、脚本打印成功、界面还是错的。**

→ 两个导入脚本各加 `--prune-traditional`（独立模式，只清库不导入；幂等；支持 `--dry-run`）。
实测：句子侧删 3,210 → 余 17,829；词库侧按**字段**剔除 3 条（不删词条，避免连带删 `WordBookWord` 与用户进度）。
清理后**全库 0 条繁体**，8 个相关接口逐一实测无繁体。

### 6.4 一条既有缺陷（顺手修掉）

`.gitignore` 写的是 `data/` 而不是 `/data/`，**连 `scripts/db/data/` 一起忽略了** ——
`git ls-files scripts/db/data/` 为 **0 条**，27 本词书语料 + 句子语料**全部没入库**。
表面上一切正常，只有换台机器 clone 下来才会发现 `db:gen-words` 跑不了。
→ 改为 `/data/`；同时把 `_*` / `*.orig` / `*.bak` 纳入兜底忽略，`tmp-corpus/` 登记为临时下载目录。

### 6.5 防复发：本类问题一共缺四把尺子，已各补一把

| 尺子 | 落点 | 拦的是 |
|---|---|---|
| 自造 CSS 令牌 | `audit:mp` 第 ⑭ 条 | 扫全部页面 SCSS 的 `var(--xxx)`，凡不在 `themes.scss` 声明集、也不是 JS 注入的 → 报错（下限 30 处） |
| 界面文案繁体 | `audit:mp` 第 ⑮ 条 | WXML 文本节点 + 字符串字面量 + TS 字面量（注释先剥离），下限 200 段 |
| 字表自证 | `check:trad`（新增） | 用**真实语料**验三条：认得出来 / 不误杀简体 / 不误报词条；每条都带样本下限，样本不足即失败 |
| 判定单测 | `tests/traditional-chars.spec.ts`（新增，8 例） | 生僻简体字（`铂`/`鲱`）不是繁体、繁体专有字必须认出、混排只报繁体字 |

⚠️ **字表判据本身翻车过两次**（详见 `traditional-chars.mjs` 文件头）：
第一版随手凑 124 字 → **漏 1180 条且误杀简体**；第二版改"在简体正文里零出现"
→ 把**生僻简体字**（`铂`/`鲱`/`蟑`）当繁体，查词书报 35 条**全是误报**。
现在用的唯一站得住的判据是：**它有没有一个不同的简体写法**
（`細→细` 有 ⇒ 繁体；`铂→铂` 无 ⇒ 简体，绝不收）。

⚠️ **自证样本必须取自真实语料**。第一版自证写「這是繁體字」，但 `這`/`們`/`為`
在上游语料里**一条都没有** → 字表里也不会有 → 自证**恒判红**，一个自己把自己判红的假警报。
