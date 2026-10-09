# AGENTS.md —— AI 协作者入口

本文件只做**指路**，不重复内容。工程约束的唯一权威版本是
`docs/rules/DEVELOPMENT-STANDARDS.md`，请先完整读它再动手。

## 开工前必读（按顺序）

1. `docs/rules/DEVELOPMENT-STANDARDS.md` —— 十条红线、分层约束、命名规范、提交规范
2. `docs/architecture/OVERVIEW.md` —— 系统架构、代码分层、**后端在哪里**
3. `docs/product/青智校园_开发任务清单.md` —— 找到本次改动对应的任务编号（如 `M0-05`）
4. `docs/compliance/OPEN_SOURCE_LICENSES.md` —— **引入任何新依赖之前**必须先登记
5. `docs/dev/MP-VISUAL-SYSTEM.md` —— **动小程序 UI 之前必读**：模块主题色板、糖果图标规范、
   动效库、装饰层与指针视差的唯一标准
6. `docs/dev/AI-CAPABILITY-DISPATCH.md` —— **给 AI 助手接新能力之前必读**：
   助手能调什么、什么时候调、输入输出规范、结果卡怎么整合（含五步接入清单）
7. `docs/dev/AI-OUTPUT-QUALITY-STANDARD.md` —— **改 AI 文案 / PPT / 图表之前必读**：三维度产出标准、
   评分权重与量化验收指标（含字数下限、要素清单、版式与图表多样性阈值）

## 代码落点速查

| 改动类型 | 落点 |
|---|---|
| 前后端共用的业务规则（枚举 / 状态机 / 错误码 / 校验 / 金额） | `packages/core/src/` |
| 后端业务接口 | `apps/api/src/modules/<领域>/` |
| 外部系统适配（DB / LLM / 图片 / PPT / 存储） | `apps/api/src/infra/` |
| HTTP 横切（配置 / 日志 / 过滤器 / 拦截器 / 管道 / 中间件 / 装饰器） | `apps/api/src/common/` |
| 小程序页面 | `apps/mp/pages/<模块>/index.*` 或 `apps/mp/pkg-<模块>/<页面>/index.*` |
| 小程序视觉令牌 / 主题 / 动效 / 图标 / 装饰 | `apps/mp/styles/`（`tokens` `themes` `motion` `icons` `deco` `components`） |
| 小程序交互动效（指针视差 / 陀螺仪 / 动画重播） | `apps/mp/utils/fx.ts` |
| Python AI / 媒体能力 | `services/ai/` 或 `services/media/`（公共部分进 `services/shared/`） |
| 仓库工具脚本 | `scripts/{db,dev,docs,license}/` |
| 词书数据（含音标/释义/词组/例句，JSONL 一行一词） | `scripts/db/data/<code>.jsonl` + `books.json` 清单（**由 `npm run db:fetch-words` 生成，别手改**） |
| 说明性文档 | `docs/{product,architecture,api,db,dev,rules,compliance}/` |

## 交付前必须全绿

```bash
npm run lint          # ≤300 行 / ≤50 行 / 禁 any / 禁 ==
npm run typecheck     # core + sdk + api + 小程序
npm test              # 单测（改了 packages/core 必须补/更新用例）
npm run build
```

### 静态守卫（编译期查不出、只能在交付前拦的那一类）

| 命令 | 断言 | 拦的是哪类"不报错"的问题 |
|---|---|---|
| `npm run audit:mp` | WXML 绑了但 TS 没写方法 / `navigateTo` 跳 tabBar / 孤岛页 / 假数据未标注 / 骨架页误导文案 / 地址数据散落 / 主题类未定义或成死类 / 隐形装饰（`qz-rise`/`qz-water` 未配形状类）/ 语义令牌用错属性（把 `--sh` 当背景）/ `qz-*` 组件类不存在 / 图标无尺寸来源（`.qz-i` 裸用）/ **`wx:else` 与 `wx:for` 同挂一个标签**（WXML 编译期报错、整页打不开，而 lint/tsc 均不看 WXML 语法）/ 自造 CSS 令牌（`var(--color-*)` 这类项目里没有的名字，带兜底值时**永远取不到主题色**）/ 界面文案混入繁体字 / **装饰层没接指针视差**（有 `.qz-deco` 却没走完 §六 四步）/ **整页没有 `qz-an-*` 入场动效** / **页面 SCSS 裸色值**（`#RRGGBB` 或数字型 `rgba()`） | 点了没反应、页面进不去、把"没上线"说成"你没做"、**整页取色、整块样式或整排图标静默失效却毫无报错**、只有开发者工具才发现的白屏、**同一模块里一半页光斑跟手另一半纹丝不动**、换肤时没人记得的那几处白字不跟随 |
| `npm run audit:api` | 客户端 `api.ts` 调的每个接口，后端是否真注册了 | 前端调了个不存在的接口，只在运行时 404 |
| `npm run check:points` | `apps/mp` 下除 `utils/billing.ts` 外不含"积分"二字 | 免费期漏改的计费文案 |
| `npm run check:tools` | seed 里 `status:'active'` 的工具必须真能跑 | 界面写着"可用"、点了报错 |
| `npm run check:categories` | 服务分类 id 在 `seed.ts` 与小程序 `CATEGORIES` 两侧一致 | 分类改名只改一边，点进去"查不到任务"像"还没人发布" |
| `npm run check:workspaces` | 有 `package.json` 的工作区必须纳入 `typecheck`/`build`；spec 文件必须能被 vitest 收集 | 新工作区"没被包含"= 永远不会被检查，且无任何报错 |
| `npm run check:doc-counts` | 文档里凡在说"工具总数"的数字，必须等于 `seed.ts` 的真实条数 | 报告/README 里的数字与代码漂移后被反复引用（曾把接口默认过滤后的"可见数"当成全量） |
| `npm run check:ai-capabilities` | AI 能力目录 ⊆ seed(active) ∩ 执行器；意图合法；guided 必带文件要求；**能跑却没进目录的工具**也要报 | 助手向用户承诺一个跑不通的功能，或**明明有能跑的能力、助手却不知道**（只能答"我做不到"） |
| `npm run check:ai-output-quality` | 质量标准 ⊆ 提示词 ⊆ 质检 ⊆ 图表类型（四处同源）；文案字数下限、PPT 版式与图表多样性阈值均已注入 | AI 文案写太短、PPT 九页同构、图表只有一种样式，且**没有任何一步报错** |
| `npm run check:timeout-budget` | 服务端 `LLM_TOTAL_BUDGET_MS`/`ASR_TOTAL_BUDGET_MS` ≤ 客户端超时 − 5s 回程余量（**三处对账**：源码默认值 + `.env.example` + **真正生效的 `.env`**） | 用户看到"请求超时"以为失败，实际服务端仍在跑、还落库扣费 —— **两端判定相反**；⚠️ `.env` 里配大了会让**后端启动即失败**，而前两处都查不到它 |
| `npm run check:sampling` | 采样参数集中在 `packages/core/src/providers/sampling.ts` 档位表；源码中不得出现 `temperature:` / `top_p:` 字面量；每档必须配 `topP` | 同类任务取值不一致（意图识别 0.1 vs 0.2）、调优要翻遍全仓、新调用点只能猜该填几 |
| `npm run check:vocab-books` | 词书定义单一来源：`fetch-wordlists.mjs` 的 BOOKS ↔ `data/books.json` 清单一致；每本都有**非空** `data/*.jsonl`；清单 `wordCount` == 实际条数；词条总量 ≥ 10000 | BOOKS 加了词书但没重跑 `db:fetch-words`（**清单是旧的，界面看不到这本**）、`data/*.jsonl` 被写坏成只有坏行（词书以"建设中"建出来）、`books.json` 与文件漂移、词库退化回几百词的"起步词表" |
| `npm run check:trad` | 繁简字表（`scripts/db/traditional-chars.mjs`，724 字，三处共用）自证三条：① 过滤前语料里**真实存在**的繁体句必须认得出；② 过滤后语料**一句都不许**残留；③ 生僻简体字（`铂`/`鲱`/`蟑`）**绝不误报**。每条都带样本下限，样本不足即判失败 | 字表判据写错却**打印绿灯**（第一版漏 1180 条繁体 + 误杀简体；第二版把生僻简体字当繁体，查词书报 35 条**全是误报**）。⚠️ 自证样本**必须取自真实语料**，不要自己造句 —— 自造样本可能根本不在语料里，导致恒判红的假警报 |

### 开发环境诊断（**不是门禁**）

| 命令 | 用途 |
|---|---|
| `npm run check:api-base` | 小程序报连接超时 / 真机连不上时**先跑它**：读 `apps/mp/config/endpoints.ts` 的 `LOCAL_API_BASE`，按 host 分两种模式 —— 局域网地址时与本机网卡比对，不符时直接给出该改成什么（`--fix` 自动改代码与文档）；公网域名时（**当前配置：开发期直连线上**）只探测线上 `/health` 是否应答，网卡与本地 `.env` 比对全部跳过，且 `--fix` 不会把地址改回局域网 IP。 |

> ⚠️ 它的结论**依赖当前这台机器的网络**（换台机器必然失败，而那不是缺陷），
> 所以刻意不列入上面的交付门禁 —— 放进去只会制造假红灯。

## 硬性纪律（违反即返工）

- **不许用假数据冒充功能**：Mock 必须带 `X-Provider: mock`，界面显示"演示模式"角标；
- **状态变更只能走 `transition()`**（`packages/core/src/state-machine`），禁止直接赋值；
- **金额一律「分」整数**（`packages/core/src/utils/money.ts`），禁止浮点；
- **外部依赖只能走 Provider 接口**（`packages/core/src/providers`），禁止在业务代码里 `new` 第三方 SDK；
- **样式只用 Design Token**（`apps/mp/styles/tokens.scss`），禁止硬编码色值；
- **小程序 UI 必须遵守 `docs/dev/MP-VISUAL-SYSTEM.md`**：根节点挂 `qz-page th-<模块>` 主题类、
  取色只用 `var(--m1..--m4/--ms/--mt/--sh/--r-card)`、图标只用 `.qz-i-xxx` 糖果图标库、
  动效只用 `motion.scss` 现成类（不自己写 `@keyframes`）、装饰包 `.qz-deco` 内容包 `.qz-content`；
- **`.env` 严禁入库**，新增环境变量必须同时改 `.env.example`、
  `apps/api/src/common/config/env.schema.ts`、`docs/dev/ENV.md` 三处。

## 不要做的事

- 不在仓库根新增散落的脚本或文档（进 `scripts/<类别>/` 或 `docs/<类别>/`）；
- 不提交构建产物、日志、`.bak` / 「副本」文件；
- 不新建空目录占位（需要时连同第一个文件一起建）；
- 不改 `docs/product/archive/` 里的历史文档；
- 不把 GPL / AGPL 组件（LibreOffice、Pandoc、ConvertX 等）装进 `apps/` 或 `services/`。
