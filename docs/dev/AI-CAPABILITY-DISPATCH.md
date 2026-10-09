# AI 能力调用与调度机制

> 面向：要给助手接一个新能力的人 / 要排查"为什么助手说它做不到"的人。
> 代码落点：`apps/api/src/modules/os/`。守卫：`npm run check:ai-capabilities`。

## 1. 这个机制解决什么问题

改造之前，平台里有三份关于"助手能做什么"的说法，彼此不知道对方存在：

| # | 位置 | 性质 | 漂移后果 |
|---|---|---|---|
| ① | `seed.ts` 的 `TOOLS` | 工具箱给用户看的展示信息 | 界面说"免费可用"，点了报错 |
| ② | `tool-executor.service.ts` 的 `handlers` | 真正能跑的东西 | —— |
| ③ | `CHAT_SYSTEM_PROMPT` 里那段散文 | **给模型的能力承诺** | **助手会一本正经地向用户承诺一个不存在的功能** |

③ 最危险：它是**手写的**，没有任何机制保证它与 ①② 一致，而且漂移时**不报错**。

同时还有一个相反的毛病：助手只会"说话"。`OsService` 的工具清单里只有
`search_knowledge`，用户说"帮我做个 PPT"，它只能回一句
"可以用 AI PPT 生成工具完成，点这里开始" —— 把本该自动完成的事推回给用户。
**不是没实现，是没接线。**

现在这两件事一起解决了：能力清单**算出来**，执行**走同一条链路**。

## 2. 三层结构

```
ai-capability.catalog.ts   目录：声明"有哪些能力、什么时候该调、调完给人看什么"
        │
        ├─► os-capability.registry.ts   注册表：目录 ∩ 工具表 ∩ 执行器 → 只有三者都齐的才暴露
        │        │
        │        ├─► specs()        → 模型的工具定义（出方向 schema 转换）
        │        └─► promptLines()  → 系统提示词里的能力清单（不再手写）
        │
        └─► ai-dispatch.service.ts      调度：参数收敛 → 调 ToolInvokeService → 结果整合
                 │
                 ├─► ai-capability.schema.ts   出方向：DB schema → 模型可用的 JSON Schema
                 └─► ai-capability.params.ts   入方向：模型参数 → 执行器能吃 + 给人看的摘要
```

### 为什么要有"目录"这一层

单看某一处都不足以表达"这个能力能不能被助手用"：

- 在 `seed.ts` 里标了 `active`，只说明**用户点工具箱**能用；
- 执行器注册了 handler，只说明**有实现**；
- 而"助手能不能调"还取决于：输入是不是纯文字（还是必须先传文件）、
  是否需要用户亲自勾版权声明、跑得快还是慢。

这些**只属于助手**的属性必须有个地方声明。目录就是那个地方。

## 3. 一条能力声明的字段

| 字段 | 作用 | 漏填的后果 |
|---|---|---|
| `toolName` | 与 `seed.ts` / 执行器 handlers 的键**逐字一致** | 注册表对账失败，能力被丢弃并记日志 |
| `source` | `tool`（工具箱也有）/ `internal`（只给 Agent 用） | 内部能力会被拿去查工具表，然后因"没入库"被丢掉 |
| `intent` | 归属意图，取值必须来自 `OS_INTENTS` | **不报错**，但前端路由永远匹配不上（静默失效） |
| `title` | 结果卡标题 | —— |
| `scene` | **可触发场景**，原样进入模型的工具描述 | 写不清模型就会乱调；太短会被守卫拦下（< 8 字） |
| `notFor` | 不适用场景 | 只写好话 → 模型把"PPT 怎么做"当成生成任务，凭空建作业 |
| `invocation` | `auto`（纯文字，可直接执行）/ `guided`（需先有文件） | 见下节 |
| `needsFile` | `image`/`audio`/`video`/`text`/`false` | 调度层不知道"缺什么文件"，引导语没法说具体 |
| `resultKind` | `file` / `text` | 结果卡渲染方式不对 |
| `resultHint` | 成功后给用户的一句话 | 卡片副标题空着 |
| `guideHint` | 缺文件时的引导语（`guided` 必填） | 用户不知道该干什么 |
| `params` | **仅内部能力**需要：参数 JSON Schema | 内部能力的 `inputSchema` 为空，模型不知道能传什么 |

### `auto` 与 `guided` 的区别（最核心的一个字段）

- **`auto`**：输入全是文字，模型在对话里**直接执行**。
  例：`generate_ppt`（主题是文字）、`translate_text`（原文可以贴在对话里）。
- **`guided`**：**必须先有用户上传的文件**。
  例：`remove_background`、`compress_video`、`speech_to_text`。

`guided` 的能力**仍然会暴露给模型**，只是描述里写明"没文件不要调用"。这是刻意的取舍：

- 完全隐藏 → 用户说"帮我把图压小"，助手只能答"我做不到" —— 能力明明存在，助手却不知道；
- 全部标 `auto` → 模型会在没文件时硬调，然后拿到失败结果，再对着用户编一段听起来合理的解释。

**`guided` 不是永久限制，只是缺文件时的降级。** 当用户**已经在对话里传过文件**
（`POST /os/sessions/:id/messages` 带 `fileIds`）时，同一个能力会**真的执行**。

## 4. 输入输出规范

### 入参：三条路径，同一个 schema

工具类能力的参数规范**只有一份** —— `apps/api/prisma/tool-input-schemas.ts`（落库到 `tool.inputSchema`）。
它同时服务三个消费者，各取所需：

| 消费者 | 需要的形态 | 转换 |
|---|---|---|
| 执行页表单 | `title` / `enumLabels` / `x-widget` | 原样（`schema-to-fields.ts`） |
| 模型的工具定义 | 标准 JSON Schema，不能有未知键 | `toModelParams()`（出方向） |
| 执行器的入参 | 收敛过的合法值 | `coerceParams()`（入方向） |

出方向会把中文 `title` **降级成 `description`** 而不是删掉 —— 模型靠说明理解字段含义。
入方向会收敛这些实测错法：

| 模型的行为 | 收敛方式 |
|---|---|
| `pages: "16"` | 字符串转数字 |
| `style: "商务"`（传了标签） | 按位置映射回 `business` |
| `depth: 99`（超范围） | **钳位**到上限（比整段失败有用） |
| `reason: "因为…"`（发明字段） | 直接丢掉 |
| `pages: null` | 视为"没有这个值"，退回 `default` |
| `copyrightAck: "yes"` | 丢弃（不能让用户没做的确认被悄悄打开） |

### 出参：作业 + 结果卡

工具类能力全部走 `ToolInvokeService`（配额 → 幂等 → 建作业 → 预扣 → 执行），
所以**产物、进度、计费与用户自己在工具箱里点完全一致**。

同步还是异步由工具表的 `sync` 列决定，**不另设配置**：

- `sync: true`（图片类，秒级）→ 等结果，卡片状态直接是 `succeeded`；
- `sync: false`（PPT / 视频，几十秒）→ 提交后立刻回卡，状态 `queued`，用户点卡片看进度。

## 5. 结果整合

一次执行同时产出两样东西，**去向不同**：

| 产物 | 去向 | 作用 |
|---|---|---|
| `forModel` | 工具消息，进**当轮**上下文 | 让模型知道发生了什么（下一轮才不会重复调用） |
| `card` | 落库到 `os_message.cards`，随回复返回 | 让**用户**拿到产物入口 |

只给模型不给卡片 = 用户被告知"做好了"却找不到东西；
只给卡片不给模型 = 模型不知道自己做过什么，下一轮会重复调用。

### 结果卡的三种形态

```
kind: 'result'  →  本轮真的执行过了：带 jobId + status + outputCount
                   点卡片 → /pkg-toolbox/result/index?jobId=...
kind: 'guide'   →  本轮没有执行（缺文件）：带 route（**参数已填进 query**）
                   点卡片 → /pkg-toolbox/run/index?toolName=xxx&topic=...
kind: 'files'   →  本轮没有执行，但用户名下已有文件：带 route
                   点卡片 → /pkg-toolbox/files/index（我的文件）
```

⚠️ 三者**必须分开渲染**（`apps/mp/pages/os/index.ts` + `index.wxml`/`index.scss` 里样式不同：
result 主题色，guide 虚线 + 警示色，files 中性灰虚线）。
把 `guide` / `files` 渲染成"已完成"，就是红线 9 说的假成功 —— 用户会以为文件已经在了。

`files` 卡的徽标是**「往期产物」**、note 写**「这一轮没有新生成文件」**：
它不是本轮的结果，措辞必须把这一点说清楚，否则用户会把这张卡当成刚刚生成的东西。

### 状态文案的保守规则

`cardStatusText()` **只有 `succeeded` 才显示"已完成"**，其余（含状态缺失）一律"处理中"。
长任务提交后立刻回来时状态是 `queued`，渲染成"已完成"会让用户点进去发现文件还没出来。

## 6. 三道安全门（缺一不可）

模型是**不可信输入源**，调度层有三道门：

1. **白名单**：`registry.require(toolName)`。未在目录注册 / 当前不可用（未上线、
   执行器没接、需要版权声明）的能力，**连参数都不解析**。
   M2-08 的验收要求"未注册工具无法调用"就落在这里。
2. **必填项**：缺 `topic` 这样的必填参数 → **追问，不执行**。
   执行器有兜底（"未命名演示文稿"），但那会产出一份用户没要过的东西。
3. **文件**：`guided` 且对话里没文件 → 回引导卡，**不建作业、不扣配额**。

执行失败时，`forModel` 里带的是**真实原因**，并明确要求模型转述 ——
否则它会自己编一个更友好的理由。

### 幂等

幂等键 = `os:<会话id>:<工具名>:<轮次-序号>`。

- 必须带**调用位置**：模型会（在协议回填出错时）在同一个回复里发起两次完全一样的调用，
  而用户也可能**真的**想要两次（做完一版不满意再按同样参数做一版）。
- 只用「工具名 + 参数」当键会让第二次被静默复用第一次的作业。

## 7. 假成功防线（`guardFalseCompletion` + `files` 卡）

实测抓到的真实失败：

```
用户：帮我做一份校园二手交易平台的 PPT，课程汇报用，12 页
助手：已经为您生成了一份…PPT，共 12 页。点下面的卡片查看详情。   ← 而下面没有卡片
```

原因：**上下文历史里有它自己上一轮说过的"已经为您生成…"**，
模型把历史当成既成事实，于是不再调用工具、直接复述结论。

处理是**两步**，缺一不可：

1. **提示词**明确写"历史里的'已完成'不算数，没发起新调用的那一轮不许说完成"；
2. **出口兜底**两件套：
   - `guardFalseCompletion(reply, executed)` 补一句**服务端确知的事实**：
     *"（说明：这一轮我没有实际执行任何动作，所以下面没有新的结果卡…）"*；
   - **再附一张「我的文件」卡**（`buildFilesCard`，见下）。

### 为什么还要那张卡

模型之所以会这么说，**恰恰因为上一轮真的生成过** —— 东西很可能就躺在用户名下。
只补一句"本轮没执行"，用户听到的是坏消息（没做），
却依然不知道该去哪找手上那份文件。所以把"东西在哪"一起答完：
既不谎报本轮，也不让用户空手。

两个约束：

- **不吃"数量为 0"这一套门槛**（虽然会查一次数量，但只用来决定文案怎么说）。
  真机探针推翻过"0 就不给卡"的做法：长任务（PPT）是异步落盘，
  触发净化时作业**往往还在跑、文件尚未生成** —— 拿数量当门槛，
  最需要这张卡的时刻它恰好不出现。文案已明说"这一轮没有实际生成文件"，
  空列表与这句话是**一致**的，所以不算误导；真正误导的是"说了完成却不给出路"。
- 只在**净化真的触发时**才查这一次（正常对话一分钱不花），且查库失败**不让整轮对话失败**
  （按 0 处理 → 文案保守，回复与卡片照常返回）。

⚠️ `executed` 的判定很严：**缺文件回引导卡、白名单拒绝、执行失败都算"没执行"**。
放宽一格，就等于给假成功留了挡箭牌。同理 `isFalseCompletion` 与
`guardFalseCompletion` 的判定必须一致，否则会出现"补了卡但没有说明"这种半吊子状态。

## 8. 加一个新能力：五步，缺一不可

以 `compress_image` 为例：

1. `apps/api/prisma/seed.ts` → 该工具 `status: 'active'`
2. `apps/api/src/modules/job/tool-executor.service.ts` → 注册 handler
3. `apps/api/prisma/tool-input-schemas.ts` → 补入参 schema
4. `apps/api/src/modules/os/ai-capability.catalog.ts` → 加一条声明
   （`invocation` / `needsFile` / `scene` / `guideHint` 都要想清楚）
   ⚠️ 主表已贴 300 行红线。超了就**另开子表**（现有的：`ai-capability.catalog.files.ts`
   管文件/媒体类、`ai-capability.catalog.docs.ts` 管文档/数据类），在主表里用
   `...XXX_CAPABILITIES` 展开即可 —— 守卫 ⑤ 是**按 import 反查子表文件名**的，
   新增子表不用改脚本（早期硬编码过 `CATALOG_FILES`，加第三个子表时守卫直接读不到）。
5. `scripts/dev/verify-tools.mjs` → 补端到端用例
   ⚠️ 一个工具产**多个文件**时（如 `separate_vocals` 出人声+伴奏），用例要写
   `expectFiles: 2`，否则脚本按"1 个产物"判定会误报失败。
   ⚠️ **这一步现在是强制的**：执行器注册了、`CASES` 里却没有，`verify:tools`
   直接以非 0 退出。原因是前四步都各有静态守卫，只有"到底真跑过没有"没有机器在管 ——
   放行它等于允许"执行器认它、验证脚本从没验过它"的工具上线。

然后跑 `npm run check:ai-capabilities`（五方对账）与 `npm run verify:os`（真跑一遍）。

**漏第 4 步的后果是最隐蔽的**：工具在工具箱里能用，但助手不知道它存在 ——
用户说"帮我做这个"时助手会回答"我做不到"。守卫 ⑤ 专门拦这一种。

### 依赖外部部署的能力：先 `planned`，部署后三步同做（`explain_repository` 先例）

`explain_repository`（deepwiki-open 仓库解读）走完了五步里的 **1/2/3/5**，
唯独第 4 步（能力目录）与 seed 状态留给部署后 —— 因为它在自托管服务可用之前**根本跑不了**：

1. seed 里 `status: 'planned'`（执行器已注册、schema 已备、verify 用例带
   `DEEPWIKI_BASE_URL` 探活 skip）—— `check:ai-capabilities` 的双向断言都容忍这种组合：
   planned 不进目录不算"能跑没进"，执行器注册了在 CASES 有条目不算漏验；
2. **部署 deepwiki 并配置 `DEEPWIKI_BASE_URL` 后，三步同做才上线**：
   seed 转 `active` + 能力目录登记（`ai-capability.catalog.docs.ts`）+
   删掉 `check-tool-status.mjs` 的 `PROVIDER_NOT_READY` 豁免条目。
   三步缺一：只改 seed 会触发守卫 ⑤ 反向红（active+执行器→必须进目录），
   只进目录会触发守卫 ① 正向红（目录→必须 active）。

### 内部能力（`source: 'internal'`）走的是另一条路

上面五步是**工具箱工具**的路径。内部能力（只给 Agent 用、不进工具箱）落笔在 4 处：

1. `ai-capability.catalog*.ts` → 声明 `source: 'internal'`，并**就地写 `params`**
   （内部能力没有工具表那份 `inputSchema`，缺 `params` 会被注册表丢弃）；
2. 在**某个** `apps/api/src/modules/os/os-*-tool.ts` → 实现 `run(args)`：
   - `os-knowledge-tool.ts` —— 知识库检索；
   - `os-campus-tool.ts` —— 校园能力（需求解析 / 服务者检索）；
   ⚠️ 守卫 ⑥ **扫描所有 `os-*-tool.ts`**，新增实现文件不必改脚本。
3. `apps/api/src/modules/os/os-tools.ts` → 分流（`invocation.name === XXX`）；
4. `apps/api/prisma/seed.ts` → **仍需登记且 `status: 'active'`**（`visible: false` 保持 —— 它不进工具箱 UI）。

### 写操作类内部能力的额外门槛（2026-09-20 补充）

`seed.ts` 里 `campus` 类共 6 个工具，但**只接了 2 个**（`parse_requirement`、
`search_service_provider`）。`create_task` / `create_order` / `send_notification`
**刻意不接**：

- `create_order` 会走担保支付预扣，模型只要把"预算 50 元"理解成"50 分"，就会**真的产生一笔订单**；
- 这类能力的正确形态是"先给用户看将要执行什么 → 用户确认 → 再执行"的两段式交互。

**确认卡尚未落地之前不要接它们** —— 宁可让助手如实说"我帮你把需求整理好，发布请点下面按钮"，
也不要拿用户账号去冒险（红线 10：不许让假执行冒充执行）。

⚠️ **它不进执行器、也不进 `verify-tools.mjs`**（那个脚本只覆盖作业链路），
覆盖它的是 `verify:os`（真实 HTTP 对话）。由此带来两条必须记住的口径：

- `check-tool-status.mjs` 有**两把尺子**：工具箱工具看"执行器注册"，内部能力看"能力目录"。
  早先只有一把，`search_knowledge` 因此被逼着一直挂 `planned`（现在有 3 个内部能力：
`search_knowledge` / `parse_requirement` / `search_service_provider`）——
  **功能是好的，状态在说假话**（守卫判据缺一条，状态就成了守卫的奴隶）。
- `verify-tools.mjs` 的结论是"**N 个 active 工具箱工具**全部真能跑"，
  不是"所有 active 工具"。

## 9. 四个容易踩的坑

- **`import type` 不能用在 Nest 构造参数上**。`emitDecoratorMetadata` 要运行时类引用，
  被擦除后启动报 `Nest can't resolve dependencies of ... (... ?)`，
  参数显示成 `Function`。**编译过、单测过（手工 new 的），只有真启动才炸。**
- **新增卡片形态时，必须同步 `isRenderableCard`**（`os.service.ts`）。
  这是一个**白名单**，漏了不报错，只表现为"卡明明生成了、客户端却收不到" ——
  本轮加 `files` 时就踩到：服务端已落库，返回给客户端的却是空数组。
- **本机的库可能是旧的**。`/os/capabilities` 返回的 `dropped` 里出现
  "状态是 planned，尚未上线"时，多半是本地库没跟上 `seed.ts`（`npm run db:seed`），
  而不是代码问题 —— 这个字段就是为了一眼分清这两者而存在的。
- **WXML 里不能调函数**。状态文案 / 能否点击 / 按钮文字 / 图标，全部要在
  `toCardView()` 里算好再进 `setData`。模板里的嵌套三元不仅难读，
  出错时**没有堆栈**，只会静默渲染成空白。

## 10. 相关文件

| 文件 | 职责 |
|---|---|
| `ai-capability.catalog.ts` | 能力声明的数据表（唯一真相源） |
| `ai-capability.catalog.files.ts` | 子表：文件 / 媒体 / 音频类能力声明（主表超行数时拆出） |
| `ai-capability.catalog.docs.ts` | 子表：文档 / 数据类能力声明（`generate_document` / `analyze_data`） |
| `ai-capability.types.ts` | 声明类型 + 纯查找函数 |
| `ai-capability.schema.ts` | 出方向：DB schema → 模型 schema + 工具描述拼装 |
| `ai-capability.params.ts` | 入方向：参数收敛 + 结果卡参数摘要 |
| `os-capability.registry.ts` | 对账（目录 ∩ 工具表 ∩ 执行器）+ 生成 spec / 提示词清单 |
| `ai-dispatch.service.ts` | 三道门 + 调 `ToolInvokeService` + 结果整合 |
| `os-tools.ts` | 复合注册表：内部能力 / AI 能力分流 |
| `os-knowledge-tool.ts` | 唯一的内部能力（知识库检索） |
| `os-tool-card.ts` | 结果卡的契约（三种形态）+ `buildFilesCard`（与小程序 `utils/os.ts` 同形） |
| `os-chat-prompt.ts` | 系统提示词（能力清单由注册表注入） |
| `scripts/dev/check-ai-capabilities.mjs` | 静态守卫：五方对账 |
| `scripts/dev/verify-os.mjs` ⑦ | 端到端：对话 → 建作业 → 结果卡 |
