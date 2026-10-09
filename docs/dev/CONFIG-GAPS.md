# 配置缺口清单（哪些能力还没真配好）

> 用途：一眼看清"哪些能力还悬空、卡在谁那里"。
> 每补齐一项就把它挪进「一、已完成」，别让这份清单腐化。
> 最后核对：2026-09-19（作者：AI 协作者，基于本机实测）

自查入口：

```bash
curl -s http://127.0.0.1:3000/api/v1/health   # mockProviders / degradations / dependencies
npm run check:tools                           # 工具状态与实现是否一致
npm run audit:api                             # 客户端调了但后端没注册的接口
```

---

## 一、已完成（2026-09-18 ~ 09-19）

| 项 | 之前的状态 | 现在 | 怎么验证 |
|---|---|---|---|
| **plan 档（深度思考）** | 模型配好了但**没有任何调用方** —— 三档里只有它没有入口 | `POST /os/plan` → JSON Schema 强约束 → DAG → 拓扑排序；非法计划**整体降级**不硬编 | `npm run verify:os` ⑥（真实模型，约 25s） |
| **向量化 + RAG** | `embedding` 只服务于 `/health`，**无业务消费方** | `KnowledgeModule`：切片 → 向量化 → Qdrant → 检索 → 带引用回答 | `npm run verify:rag`（真实模型 + 真实 Qdrant） |
| **intent 档** | 曾被误判为"配了但无调用点" | 核实**本来就有**调用链（`/os/intent` ← `pages/os`） | `npm run verify:os` ②（5/5 命中） |
| **Redis 7.4.11** | 未安装 → `/health` `degraded`，队列降级为进程内执行 | 本机 Windows 二进制落地，**版本与 `docker-compose.yml` 的 `7-alpine` 对齐** | `npm run verify:realtime` |
| **`WECHAT_SECRET`** | 空 → 登录走伪 openid 开发模式 | 已填入真实 AppSecret，**真实微信登录启用** | 登录返回 `40029 invalid code`（不是 40001，说明密钥已被微信接受） |
| **`WECHAT_DEV_LOGIN`** | 无此开关 → 填了真 Secret 后**所有 `verify:*` 脚本登录 401** | 新增开关，让「是否走真实微信」与「有没有 Secret」**解耦**（`NODE_ENV=production` 时强制失效） | 脚本**一行未改**即恢复，三条端到端全绿 |
| **向量库 Qdrant** | 无 | v1.19.1 落地（ADR-14） | `curl localhost:6333/` |
| **FFmpeg（LGPL 构建）** | 未安装 → `check:ffmpeg` 只能"跳过" | BtbN `win64-lgpl` 构建落地；断言脚本改为**从 `.env` 读 `FFMPEG_BIN`**，并修正判定口径 | `npm run check:ffmpeg` |
| **`STORAGE_PUBLIC_BASE_URL`** | 留空 → 回落 `localhost`，**真机下载必失败** | 填入本机局域网 IP（含 `/api/v1` 前缀） | `npm run verify:files` |

### ⚠️ `WECHAT_SECRET` 生效的副作用（必读）

**填了真实 AppSecret 后，所有依赖登录的验证脚本都会失败**：
`verify:os` / `verify:rag` / `verify:e2e` / `verify:realtime` / `verify:files` 全都在
`❌ 登录（HTTP 401）` 这一步就停住，错误信息是微信的 `40029 invalid code`。

原因是：这些脚本用假 code 调 `/auth/login`，而**开发模式的伪 openid 只在
`WECHAT_SECRET` 为空时启用**（`wechat.service.ts`）—— 现在会真的打到微信并被拒绝。
**这是配置生效的正确结果，不是故障**；但意味着"配好了反而没法自动验证"。

→ 后续需要给验证脚本准备一个**仅 `development` 环境**的测试登录通道，
否则每次要跑端到端验证都得临时清空 `WECHAT_SECRET`。

### 顺带修掉的 4 个「静默故障」（都不报错，只是悄悄变坏）

1. **`envFilePath` 依赖 `process.cwd()`** —— 相对路径按启动目录解析，于是
   `cd apps/api` 启动读的是 `apps/api/.env`（`setup-env.mjs` 的**生成物**），
   而仓库根启动读的是根 `.env`。改了根 `.env` 忘了跑 `npm run setup:env` 时，
   **配置静默过期**（实测 11 个键读不到，含 `VECTOR_DRIVER` 与 `LLM_TOTAL_BUDGET_MS`）。
   → 锚定为绝对路径、仓库根优先（`apps/api/src/common/config/paths.ts`）。

2. **`LLM_TIMEOUT_MS(60s) > LLM_TOTAL_BUDGET_MS(45s)`** —— `attemptTimeout()` 取两者较小值，
   于是**第一次尝试就吃掉全部预算**，超时回来已无额度重试/降级。
   实测指纹：作业耗时 **45.028s** 且日志里**没有任何降级记录**。
   → 单次超时降到 30s，并加**启动期断言**（配错直接拒绝启动）。
   ASR 侧一直是对的（20s ≤ 25s），只有 LLM 侧漏了。

3. **LLM 连接复用导致请求挂起** —— Node `fetch`（undici）默认复用 keep-alive 连接，
   服务端空闲后会静默关闭它，复用时**一直挂起到超时**。
   症状极隐蔽：**刚重启一切正常，跑十几分钟后每个 LLM 调用都卡满预算**。
   实测：同一时刻新进程调同一接口 3.5s，老进程卡满 45s。
   → 请求头加 `Connection: close`。

4. **`verify-llm.mjs` 自己组装配置时漏了 `totalBudgetMs`** —— `TimeBudget` 的 deadline
   算成 `NaN`，于是**一次请求都发不出去**，报错是 `budget-exhausted-before-first-attempt`
   （看起来像"预算太小"，其实是"压根没传"）。三个档位因此全部假失败。

---

## 二、需要你提供凭证（拿到就能配，代码侧已就绪）

| 配置项 | 需要什么 | 不配的后果 |
|---|---|---|
| `WECHAT_SUBSCRIBE_TEMPLATE_TASK`<br>`_ORDER`<br>`_JOB` | 小程序后台申请的三个**订阅消息模板 ID** | 任务/订单/作业通知发不出去（`mock-notify`） |
| `WECHAT_PAY_MCHID`<br>`WECHAT_PAY_SERIAL_NO`<br>`WECHAT_PAY_PRIVATE_KEY_PATH`<br>`WECHAT_PAY_APIV3_KEY` | 微信支付**商户号 + 证书序列号 + 私钥文件 + APIv3 密钥** | 真实收款无法启用（回落 `mock-pay`）。⚠️ **但订单与担保支付链路本身已跑通**（M3-11/12/14/15，2026-09-19 落地）：下单 → 发起支付 → 回调 → 交付 → 验收放款 → 退款全流程可用，`npm run verify:order` 端到端验证。配齐这四项后实现 `WechatPayProvider` 即可切真实收款（业务代码零改动） |

> 凭证填进 `.env`（**严禁入库**），然后 `npm run setup:env` 同步一份给 Prisma。
> 新增变量要同时改三处：`.env.example` / `env.schema.ts` / `docs/dev/ENV.md`。

---

## 三、需要先做架构 / 产品决策（不是配一下就能好的）

| 项 | 卡在哪 | 现状 |
|---|---|---|
| **转换服务** `CONVERT_SERVICE_URL` | LibreOffice / Pandoc / ConvertX 是 **GPL / AGPL**，按红线必须**独立部署 + HTTP 调用**（ADR-05），该服务尚未实现 | 留空 → 该能力返回 `50362` |
| **`services/media` 侧车** | ✅ **已全部实现**（2026-09-19）：`probe` / `transcode` / `compress` / `cut` / `subtitle` / `audio-cut` / `audio-denoise`，且 `routes.IMPLEMENTED` 与 handler 表已对账（漂移会在启动日志里告警） | 视频压缩·转码·裁剪·字幕、音频裁剪·降噪**均可用** |
| **`services/ai` 侧车剩余端点** | `matting`（rembg + u2net）与 `separation`（Demucs `htdemucs`）**已实现**。仍为 501 的只剩 `/ai/inpaint`（决策未定，且需前置版权声明链路）。`/ai/ocr`、`/ai/asr`、`/ai/enhance`、`/ai/parse-document` 是**已被绕开的历史登记**（分别走硅基流动 VLM / 硅基流动 transcription / Sharp / `services/pdf`），不应再被调用 | 去水印不可用；其余能力均已从别处可用 |
| **人声分离的模型依赖** | `services/ai` 的 `/ai/separation` 需要 `demucs` + `torch`（约 1GB，`pip install demucs`），首次运行还要从 HuggingFace 拉 ~80MB 权重（国内可设 `HF_ENDPOINT=https://hf-mirror.com`）。**未安装时侧车返回 501 并附安装指引**，不返回原音频假装成功 | 装好即用；CPU 上跑"音频时长的 1~3 倍"，有 GPU 自动加速 |
| **搜索** `mock-search` | 需选型：MySQL FULLTEXT（零新组件）还是 Meilisearch / ES | 搜索走 Mock |
| **短信** `mock-sms` | 需选服务商（阿里云/腾讯云…）+ 凭证 | 短信通知不可用 |
| **内容审核** `mock-moderation` | 按设计文档（M4-05）**必须走微信内容安全 API**（`msgSecCheck` / `mediaCheckAsync`）+ 自建词库，不能用 LLM 提示词代替。⚠️ **业务接线已于 2026-09-19 完成**（`ModerationService`，见下方），此处只剩"换成 wechat 驱动" | **文本 UGC 已拦得住**（`npm run verify:moderation`）；`mock` 驱动拦不住变体与图片 —— 上线前必须切 `wechat` |
| **知识库前端入口** | 后端 `/knowledge/*` 五个接口**已就绪并验证通过**，但小程序端**没有任何入口**（`audit:api` 显示"后端有但前端未调用 13 条"） | 能力在，用户看不到 |
| **`search_knowledge` 工具** ✅ **已转 `active`（2026-09-19）** | 它是**内部能力**（`source: 'internal'`、`visible: false`）：不进工具箱、不进执行器，由助手的 tool calling **进程内直调**（`os-tools.ts` 分流 → `os-knowledge-tool.ts` → `KnowledgeService.search`），注册表对内部能力**不检查 status**。⚠️ 本文原写"真正缺的是 `OsService` 完全没有 tool calling"是**过期结论** —— `os.service.ts` 的 `chatWithTools` 早就传了 `tools: specs` 并消费 `res.toolCalls`（单测 `os.spec.ts`「模型发起 search_knowledge：工具被执行」覆盖）。它一直挂着 `planned` 的真实原因是 **`check-tool-status.mjs` 只认"执行器是否注册"**，改成 `active` 会误报"标为 active 但跑不通" —— 守卫已补上内部能力识别，状态恢复如实 | 助手能回答校园规定 / 办事流程类问题，且答案带来源引用（`verify:os` 断言它在可用能力清单里） |
| **`generate_mindmap` 超预算** ✅ **已修复（2026-09-19）** | 根因**不是"输出太长"，而是思考 token 失控**：`reasoning_effort: low` 的效果随任务复杂度递减，在思维导图这种"双产物 + 结构化语法"的任务上压不住 —— 直连实测 reasoning 仍占 token 的 60~75%、耗时 **23.6~31.1s**，**恰好在 30s 单次超时线上反复横跳**（这才是"时通时不通"的原因）；`max_tokens=2500` 时更会推理吃光、`content` 为 0 字。**修法**：`LlmCallOptions.disableThinking` + `LLM_DISABLE_THINKING`（双开关）→ 请求体带 `thinking:{type:'disabled'}` → reasoning **归零、耗时 3.6s**、`completion_tokens` 2016 → 314，产物 571 字但结构完整（5 维度 × 3 子项 + 合法 Mermaid） | 已恢复可用（`verify:tools` 通过） |

> ✅ **该缺陷已于 2026-09-19 修复**（方案见上表）。下面保留"分档预算"的原始判断与修正过程。
>
> ⭐ **它揭示的真正问题是"思考 token 无人管"**，不是单个工具的毛病：
> `LLM_REASONING_EFFORT` 的效果**强依赖任务复杂度** —— 极简任务（"只回复两个字"）
> 能压到 3 token，但复杂生成任务压不住（reasoning 占 60~75%）。所以：
> **凡是"输出结构固定、不需要推理"的重生成工具，都应显式 `disableThinking: true`。**
>
> ⚠️ 本文档原先记的"该 prompt 需要 54.2s，所以永远完不成"**是不准的**（现场复测
> 23.6~31.1s，且在 30s 线上下波动）—— **文档里的实测数字也会失真，排查以现场复测为准**。
>
> ⚠️ **遗留（未修）**：降级模型 `glm-4.7-flash` 实测极慢（同一请求 **97.3s**，比主模型慢 4 倍），
> 主模型超时后降级到它**等于必然烧光预算**。关思考能让它降到 17.9s，但仍比 air 慢 48 倍。
> → **降级链上每个模型都必须实测耗时，不能只看"能不能调通"**；换掉它需重新选型。
>
> ⚠️ 另一条容易误判的前提：工具调用是**异步作业 + 轮询**
> （`POST /tools/:name/invoke` 返回 `jobId`，客户端再 `GET /jobs/:jobId`），
> 所以"小程序 `request.ts` 的 30s 请求超时"**不约束生成过程** ——
> 真正的硬约束只有 `LLM_TIMEOUT_MS`（单次）与 `LLM_TOTAL_BUDGET_MS`（总）。
> ⚠️ `reasoning_effort` / `thinking` 都是**服务商特有参数**，换服务商时必须重测。
>
> **分档预算降级为后手**：关思考后 mindmap 只要 3.6s，根本用不到 60s 预算。
> 等真出现"关思考仍不够"的工具（`LlmCallOptions.totalBudgetMs?`，跨包改动）再做。

---

## 三之二、内容安全（M4-05）现状 —— **已接线，但只覆盖文本**

2026-09-19 之前的状态是 **"Provider 存在、零调用方"**：`WechatModerationProvider`
与 `CAMPUS_LEXICON` 都写好了，`MODERATION_DRIVER` 也配好了，但**没有任何业务代码调用它** ——
所有 UGC 写入口实际处于裸奔。这类问题单测查不出来（单测直接 `new` 一个 service，
永远不会暴露"没人 new 它"），只有端到端脚本能发现。

现在统一走 `apps/api/src/modules/moderation/`（`@Global`）的 `ModerationService`：

| 入口 | 字段 | 场景 | 验证 |
|---|---|---|---|
| `PUT /user/me` | 昵称、个人简介 | `profile` | ✅ |
| `PUT /user/me` | 性别、手机号、学院、年级、头像 | — | **不送审**，且不是漏做：`gender` 是 `z.nativeEnum` 的三个固定值、`phone` 是 11 位数字正则、`college`/`grade` 有长度上限，都没有自由文本；`avatar` 存的是**我们自己签发的** `/files/public/<id>` 地址（`z.string().url()`），用户塞不进任意外链。⚠️ 但**头像图片内容本身没有审核** —— 图片审核至今未接线（见下方 §三之三），换上一张违规头像目前拦不住，只能靠后台管理员看到。这条是已知缺口，不是"已验证"（缺口本体见下一节「仍未闭环的两处」第一条）。 |
| `POST /orders/:id/deliver` | 交付说明 | `comment` | ✅ |
| `POST /orders/:id/refund` | 退款理由 | `comment` | ✅ |
| `POST /os/sessions/:id/messages` | 会话消息 | `log` | ✅ |
| 发布需求 / 报名 / 评价（M3-06/10/16） | 标题、描述、留言、评价内容 | `forum` / `review` | ⛔ **入口本身未开工**，开工时注入 `ModerationService` 即可 |

一条命令复验：`npm run verify:moderation`（25 项断言，含"被拦后**没落库**"与"正常内容**不误伤**"）。

**仍未闭环的两处**：

- ⛔ **图片审核未接线**。`checkImage` 依赖公网可访问 URL（`mediaCheckAsync` 是**异步**接口，
  结论通过消息推送回写），要先落文件 + 开公网域名。`MockModerationProvider.checkImage`
  现在返回 `pass:false + action:'review'`（**不再假报 pass**），接线后不会出现"图片静默放行"。
- ⚠️ **`40323`（版权声明）路径目前不可达**：`assertCopyright` 实现正确且排在配额扣减之前，
  但唯二两个 `requiresCopyrightAck: true` 的工具（`repair_image` / `repair_video`）都是 `planned`，
  而 `assertAvailable` 先于 `assertCopyright` 执行 → 实际返回的是 404「尚未开放」。
  这是**正确的顺序**（"工具没开放"比"请勾选版权声明"更准确），但也意味着 M4-05
  验收里的"未勾选版权声明拒绝执行（40323）"**今天无法端到端演示**，要等这两个工具落地。

---

## 三之三、⚠️ `prisma migrate dev` 会**删掉 `search_index` 表**

这是本轮（2026-09-19）做 M3-02 加迁移时发现的**真实地雷**，务必先读。

**现象**：执行 `npm run db:migrate`（= `prisma migrate dev`）后，生成的 `migration.sql`
里除了你真正要改的东西，还会**多出一条 `DROP TABLE \`search_index\``**。

**原因**：`search_index` 是 `20260919120000_add_search_index` 用**手写 SQL** 建的（M4-07），
它需要 `FULLTEXT KEY ... WITH PARSER ngram`；而 Prisma **表达不了 ngram 解析器**，
所以 `schema.prisma` 里**故意没有**声明这个模型 → Prisma 把它当成"数据库里多出来的表"。

**不处理的后果**：M4-07 的**中文全文检索静默失效**。
MySQL 默认分词器按空格切词，中文没有空格 → 检索"摄影"匹配不到"校园摄影服务"，
**不报错、只是永远返回空**。而"搜不出东西"看起来像"还没建索引"，不像"表被删了"。

**怎么办**：生成迁移后**逐行检查** `migration.sql`，手工删掉这两类语句再应用：
`DROP TABLE \`search_index\``、`DROP INDEX \`ft_search_title_body\``。
参考 `20260919100618_add_verification_identity/migration.sql` 里的同样处理（附详细注释）。

**为什么不干脆声明模型**：两条路都会造成静默失效 ——
不声明 → 被 DROP；用 `previewFeatures = ["fullTextIndex"]` 声明 → Prisma 认得出索引存在，
但一旦需要重建索引，生成的 SQL **不带 `WITH PARSER ngram`**，中文检索同样退化成"永远搜不到"。
所以选择"不声明 + 在 `schema.prisma` 末尾与本节明确记录"。

**根治方向**：把 `search_index` 的读写从 Prisma 挪到裸 SQL（它本来就是
`SearchProvider` 单向写入、业务表不感知的），再把它从 Prisma 的管辖范围里摘出去。

---

## 四、本轮刻意**没有**改的

- **`parse_document` 保持 `planned`** —— PDF 栅格化（poppler / pdftoppm）是 **GPL**，
  必须进隔离转换服务，硬做会变成"假功能"。
- **`remove_background` 保持注册但报错** —— 同上，不假成功。
- **重排序模型（bge-reranker）不接** —— 粗排已把正确文档排到第一（实测 0.7963），
  接 rerank 目前**没有验收标准**，会是又一段死代码。
- ~~**`search_knowledge` 保持 `planned`**~~ → **2026-09-19 已转 `active`**（见上表该行）。
  原判"前置条件是给 OS 加 tool calling，单独改 `active` 没有调用方、等于制造新的悬空能力"
  **已被证伪**：tool calling 早已实现且有单测覆盖（`docs/product/青智校园_八项待办落地记录.md`
  第 7 项早就记着"✅ 已补（OsService 工具循环）"—— **两份文档互相矛盾，而 seed 的状态跟着错的那份走了**）。
  它一直挂着 `planned` 只是因为 `check-tool-status.mjs` 不认内部能力（守卫的判据缺一条，
  状态就被逼成了假的）。
  ⚠️ 这条留下的教训：**"没接线"的结论必须靠 grep 调用点验证，不能靠印象**；
  而且**修完功能要回头改"缺口清单"，否则缺口清单会自己变成新的错误来源**。
