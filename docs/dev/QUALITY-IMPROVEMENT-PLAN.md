# 产出质量提升方案（M3 质量专项）

> 面向：要做质量改进的人、做验收的人。
> 本文只做**方案与排期**，不改代码；每条措施都给出「现状证据 → 动作 → 落点 → 验收」。
> 相关权威文档：`docs/dev/AI-OUTPUT-QUALITY-STANDARD.md`（产出标准）、`docs/dev/AI-CAPABILITY-DISPATCH.md`（助手调度）、
> `docs/rules/DEVELOPMENT-STANDARDS.md`（十条红线）。
> 编号约定：本文 `Q1..Q24` 是措施编号，实施时映射为任务编号 `M3-01..M3-12`（见 §8）。

---

## 0. 一句话诊断

**现在的问题不是"没有质量标准"，而是标准算出来的分没有载体，且生成链路是"一锤子买卖"。**

三个可验证的事实：

1. `analyzeContent` / `analyzeDeck` 算完分只 `logger.warn` 打进日志（`llm-tool-runner.ts:340-352`、`tool-executor.service.ts:287-294`），
   `ToolJob` 表里**没有任何 quality 字段**（`schema.prisma:247-276` 全表 grep `quality` 零命中）；
2. 9 个文本工具里只有 2 个传了 `qualityDocType`（`llm-tool-runner.ts:76`、`:178`），其余 7 个**零质检**；
3. `AgentCallLog` 表（含 tokens / 耗时 / 模型，`schema.prisma:390-407`）**从来没有写入点**，
   因此"哪版提示词、哪个模型导致分数下滑"这个问题**在数据上无法回答**。

结论：**先修度量，再修生成**。否则所有质量改进都无法证明有效，也无法在回归中被守住。

---

## 1. 现状体检

### 1.1 AI 生成侧（文本 / PPT）

| 维度 | 现状（证据） | 对用户的实际影响 |
|---|---|---|
| 调用次数 | 文档单次调用（`llm-tool-runner.ts:324-336`）；PPT 一次 `structured()` 同时产出大纲+页内容+版式+图表+讲稿，`maxTokens: 4200`（`tool-executor.service.ts:200-273`） | 页数一多，每页被摊薄；想写细也写不下 |
| 未达标处置 | 只 warn、不重试、不回写（`llm-tool-runner.ts:341-352`） | 低分产物照样交付，且没人知道 |
| 缺节兜底 | 模型少给节 → `sections.push({ points: [] })`（`tool-executor.service.ts:277-279`） | **主动制造空内容页** |
| 输出解析 | `extractJson` 只剥 ``` 围栏 + 找首尾括号（`:484-494`），无括号补齐/尾逗号修复；失败直接抛 `AiOutputInvalid` | 一次格式抖动 = 整个任务失败 |
| 截断 | 全仓无 `finish_reason` 检查 | `finish_reason=length` 的半截内容被当正常结果 |
| 采样参数 | 只有 `temperature`（`:94-95`），无 `top_p`；`temperature` 散落硬编码 0.7/0.6/0.1/0.3 四处 | 不可治理、不可复现 |
| 模型分档 | INTENT/PLAN/GENERATE 三档**配置同名模型**（`glm-5.3-flash`） | 分档只是配置项，没有真的"强模型干重活" |
| 阈值同源 | `generate_outline` 的"800 字"硬编码在提示词里（`llm-tool-runner.ts:70`），与 `standard.ts` 不同源 | 标准改了、提示词没改，两边漂移 |
| 自修正 | 全仓**无** self-refine / best-of-n 实现 | 明知不合格也只能交付 |

### 1.2 对话侧（智能程度）

| 维度 | 现状（证据） | 影响 |
|---|---|---|
| 意图/规划 | 确实用了 LLM（`os.service.ts:363-370` intent 档 temp 0.1；`:426-431` plan 档 temp 0.3） | ✅ 方向对，但 `PLAN_ATTEMPTS=2` 两次发**同一份提示词**（`:424-431`），是 retry 不是 refine |
| 工具循环 | `MAX_TOOL_ROUNDS = 2`（`:63`），用尽后兜底一次无工具答复（`:347`） | 多步任务（先做 PPT 再转 PDF）做不完 |
| 上下文 | `HISTORY_LIMIT = 12` 条，`recentHistory` 只取 role/content（`:469-479`），**无 token 级裁剪** | 长文档进过上下文就爆窗或挤掉关键信息 |
| 澄清 | `needsClarification` / `questions` 已在 schema 与提示词里（`os-intent.ts:29-30,83-84`），但后端与小程序**均无消费点** | 模型想问却问不出来，只能瞎猜参数瞎做 |
| 结果自检 | 无 | 助手在产物落地前就宣布"做好了" |

### 1.3 非 AI 工具侧（真正的"静默劣质"）

| 工具 | 现状（证据） | 影响 |
|---|---|---|
| 图片压缩 | 从不传 `targetSizeBytes`（`image-tool-runner.ts:34-38`）→ 永远走固定 quality 分支（`sharp-image.provider.ts:35-37`）；**无 rotate / withMetadata / resize**，`apps/api/src` 全量 grep 零命中 | 手机竖拍图**躺倒**；超大图不缩放；压缩率听天由命 |
| 图片压缩（png） | `pipeline.png({ quality })`（`sharp-image.provider.ts:83`），sharp 的 png quality 仅在 `palette:true` 生效 | **压完必然变大，且静默成功** |
| 图片增强 | `sharpen().modulate({ saturation: 1.08 })` 无参硬编码（`:64`）；`sidecar-image.provider.ts:53` **丢弃 `_scale`**，超分其实不存在 | 锐化过度、超分是假的 |
| 格式错配 | `toBuffer()` 不带格式 → 输出保持输入格式，却固定存为 `_enhanced.png`（`image-tool-runner.ts:93-95`） | jpg 输入 = "名为 png 的 jpeg 字节" |
| 视频编码 | `ffmpeg.py:153-167` 按候选顺序取第一个可用编码器；无 libx264 时静默落到 `mpeg4`/`libopenh264`（后者写死 `-b:v 2M`，`:461`） | **画质断崖下降但作业显示成功**；编码器名只进响应头，不落库不展示 |
| 视频压缩 | CRF 23（`:38`）+ `veryfast`（`_quality_args`）且与 `-b:v` 并存 → 目标体积不被保证；明确不做两遍（`:124-125`）；产出后不比对实际大小 | "压到 50MB"做不到，也不告诉你 |
| 视频裁剪 | 未传 `mode` → 默认 `-c copy`（`handlers.py:198-204`），切点对齐关键帧 | 剪出来差几百毫秒，还不告知 |
| 音频降噪 | mp3/m4a 一律 `-b:a 96k`（`:317-318`） | 320kbps 源文件被静默降到 96k |
| PDF 压缩 | 固定 `-compress -garbage 4 -sanitize`，**无图片降采样**（`engine.py:147-156`） | 扫描件压不动（但变大时正确抛 42212 ✅） |
| 产物元信息 | `ToolJob` **无 result 列**；结果页只展示文件名与个数（`pkg-toolbox/result/index.wxml:54,109`，`presenters.ts:128-139` 未用 `fileAsset.size`） | 压缩率、分辨率、时长、页数**全程不可见** |
| 统一后置校验 | job 模块无空产物/体积异常校验 | 失败只能靠用户自己发现 |

### 1.4 闭环侧

- 回归只锁**评分器**：`packages/core/src/quality/__tests__/quality.spec.ts` 用固定 fixture 断言（真实 AI 产出不进回归）；
- 端到端脚本 `scripts/dev/verify-l1-ppt.py` 只验"文件能打开"（魔数 `PK`、`[Content_Types].xml`），**零内容断言**，且未注册进 `package.json`；
- 小程序有「重新生成」按钮，但只是 `wx.redirectTo` 回执行页（`result/index.ts:297-300`），**不带原 jobId、不带原因**；全 apps grep `feedback` **0 命中**；
- 除 `/health` 外无任何 metrics / 统计接口（`apps/admin` 只有一个 README）。

---

## 2. 提升框架：五层杠杆

```
L4 演进层   反馈 → golden set → 提示词版本 → A/B          （让质量可持续变好）
L3 呈现层   产物元信息 / 质量分可见 / 降级可见              （让用户感知到质量）
L2 生成层   采样治理 · 两阶段 · self-refine · 输出协议       （决定产出上限）
L1 输入层   意图 · 澄清 · 上下文 · 真实数据接入              （决定产出方向）
L0 度量层   质量分落库 · 调用日志 · 指标接口                 （否则一切不可验证）
```

**顺序必须是自下而上**：L0 不修，L1~L3 的收益无法证明；L3 不修，L2 的改进用户感知不到。

---

## 3. P0 · 度量与闭环（先做，约 1~2 天）

### Q1 质量分落库

- **动作**：`ToolJob` 增列 `qualityScore Int?` / `qualityIssues Json?` / `attempts Int @default(1)`；
  `generate_document`、`generate_outline`、`generate_ppt` 成功后写入分数与未达标原因。
- **落点**：`apps/api/prisma/schema.prisma`、`packages/core/src/quality/`（导出稳定结构）、`job.service.ts:236-243` 的 `succeed()`。
- **验收**：跑一次文档生成 → `SELECT qualityScore FROM tool_job` 有值；分数 <85 时 `qualityIssues` 非空。

### Q2 全量工具接入质检 + 分数可见

- **动作**：给其余 7 个文本工具（translate / paperSummary / solveQuestion / imagePrompt / mindmap / summarize / …）补 `qualityDocType` 或新增匹配类型，
  让 `analyzeContent` 覆盖全部文本产出；未达标日志统一格式带 `jobId`。
- **落点**：`llm-tool-runner.ts`（`:76`、`:178` 之外的调用点）、`document-specs.ts`。
- **验收**：`npm run verify:tools` 全绿且日志中每个文本工具都有质量行。

### Q3 LLM 调用日志真的写入

- **动作**：在 Provider 出口统一落 `AgentCallLog`（model / promptTokens / completionTokens / latencyMs / status / **promptVersion** / jobId）。
- **落点**：`openai-compatible.provider.ts`（`chat`/`chatStream`/`structured` 三处出口统一收口）。
- **验收**：任跑一个 AI 工具 → `AgentCallLog` 新增一行，tokens 非 0。
- ⚠️ 这张表建了却从没写过，是"看起来有成本看板、实际没有"的典型。

### Q4 端到端判据从"能打开"升级到"分数达标"

- **动作**：`scripts/dev/verify-l1-ppt.py` 增加页数、每页要点数、版式种类、综合分断言（≥85）；注册为 `npm run verify:ppt-quality` 并进 CI。
- **验收**：故意把 `maxTokens` 调小造一份劣质 deck，脚本必须**失败**。

---

## 4. P1 · AI 生成质量（最高收益）

### Q5 两阶段生成（PPT）

- **现状**：一次调用出大纲+所有页内容，`maxTokens: 4200`，12 页时每页摊到约 300 token。
- **动作**：拆为
  ① 大纲阶段：只出页标题 + 该页要点数 + 版式意图 + 是否用图 + 图表计划（低温度、短输出）；
  ② 页内容阶段：**分批**生成（每批 5~6 页），每批自带已完成页的标题列表防重复；
  ③ 合并后走现有 `resolveLayout` / `dedupeAdjacentLayouts`。
- **落点**：`tool-executor.service.ts:200-273` 拆分为 `planDeck()` + `fillPages()`。
- **验收**：12 页 deck 的"每页平均要点数"与"要点平均字数"较改造前提升，且 `≥85` 分占比提升（用 Q4 脚本量化）。
- ⚠️ 延迟会上升 → 必须配合进度阶段文案（`stage`）逐批上报，否则用户以为卡死。

### Q6 self-refine（质检回灌重生成，最多 +1 次）

- **动作**：质检未达标时，把 `issues`（如"篇幅不足：1800/3000"、"缺少市场规模章节"）作为一条 user 消息回灌，
  重新生成**一次**，取两次中高分者；`attempts` 落库。
- **落点**：`llm-tool-runner.ts:340-352` 处增加 refine 分支；`job.service.ts` 记录 `attempts`。
- **成本**：单任务最多 2 倍 token。控制手段：只对 `score < 85` 触发、只对文档/PPT 触发、`BILLING_ENABLED=false` 期间全量开、开启计费后按积分档位决定。
- **验收**：构造一份"必定短"的提示（如要求 3000 字商业计划书但温度调高），refine 后分数应上升；`attempts=2` 可查。

### Q7 输出协议加固（JSON 不再靠运气）

- **动作**（三层，按 Provider 能力探测逐级降级）：
  ① 优先用原生结构化输出（`response_format: json_schema` 或 function calling / tool_choice）—— 需先确认服务商支持度；
  ② 不支持则保留 schema 提示词 + **本地修复器**：补齐未闭合括号/中括号、去除尾逗号、剥离前后解释文字、处理截断（见 Q8）；
  ③ 修复后仍失败 → 抛带**样本片段**的错误，而不是笼统 `AiOutputInvalid`。
- **落点**：`openai-compatible.provider.ts:484-494` 的 `extractJson`、`:413-419` 的 `withSchemaHint`。
- **验收**：单测覆盖「尾逗号」「少一个 }」「前置解释文字」「```json 围栏」四类脏输出，必须全部解析成功。

### Q8 截断检测与续写

- **动作**：读 `finish_reason`，为 `length` 时自动发起续写（把已生成内容 + "从断点继续，不要重复" 再发一次，最多续 2 次），
  或在 JSON 场景下直接触发 Q6 的 refine。
- **落点**：`openai-compatible.provider.ts` 的 `chat()` 出口。
- **验收**：把某工具的 `maxTokens` 临时调到很小，产物必须是完整段落而不是半句话。

### Q9 采样参数集中治理

- **动作**：新建 `packages/core/src/quality/sampling.ts` 定义档位表（intent / plan / short / document / deck-outline / deck-pages / vision），
  每档固定 `temperature` / `top_p` / `reasoningEffort` / `maxTokens`；所有调用点改查表，**禁止散落硬编码**。
- **落点**：新文件 + `llm-tool-runner.ts:332`、`tool-executor.service.ts:272`、`os.service.ts:315/369/430`。
- **验收**：新增守卫 `npm run check:sampling` —— 源码中除该表外出现 `temperature:` 字面量即失败。

### Q10 质检扩维（评"对不对、贴不贴、听不听话"）

- **现状**：`score.ts:151-159` 只评形式（篇幅/要素/层级/句长/重复率），要素覆盖还是子串匹配（`:118` 语义改写即误判）。
- **动作**：新增三个维度（**先观察不阻断**，跑两周看分布再决定是否纳入 85 分门槛）：
  ① **指令遵循**：把用户原始输入与显式约束（如"控制在 500 字内"）传进评分器 —— 用户显式约束**优先于**标准下限，
     否则标准本身就在制造"不听话"；
  ② **贴合度**：产出主题与用户输入的关键词重合度（打分器签名需从 `(markdown, docType)` 扩为 `(markdown, docType, input)`）；
  ③ **事实一致性**：有源材料（上传文档/表格/知识库）时，比对产出中的数字断言是否能在源材料中找到；
     找不到且未标注「示例/估算/需核实」的判为幻觉嫌疑（红线 10 的自动化版本）。
- **落点**：`packages/core/src/quality/score.ts`、`standard.ts`（权重表），沿用 `check:ai-output-quality` 的对账习惯。
- **验收**：构造"用户要求 500 字但文档标准 3000 字"的输入 → 指令遵循维度必须给出高分且不被篇幅维度判死。

### Q11 模型真分档

- **现状**：三档同名 `glm-5.3-flash`（快模型），长文写作质量被模型上限锁死。
- **动作**：`INTENT` 档保留快模型（便宜、低延迟）；`PLAN` 档换中等推理模型；`GENERATE` 档（尤其 3000 字级文档与 PPT）换长上下文写作模型。
- **前置**：新模型必须先在 `docs/compliance/OPEN_SOURCE_LICENSES.md` 登记许可（`Research Only` / `Non-commercial` 一律不用），
  并跑 `node scripts/dev/verify-llm.mjs` + `/health` 确认 `mock-llm` 消失。
- **验收**：同一份 prompt 跑新旧模型，用 Q1 的落库分数对比（样本 ≥10），分差需显著。

### Q12 空壳页零容忍

- **动作**：`tool-executor.service.ts:277-279` 的补空页改为：缺节时**回退到大纲阶段重新规划**（或直接合并相邻节），
  绝不产出 `points: []` 的页；渲染后再跑一次 `analyzeDeck`（当前只在渲染前算完即丢弃，`:287`）。
- **验收**：构造"模型只给 3 节却要 10 页"的用例，产物不得出现空白内容页。

---

## 5. P1 · 对话侧智能程度

### Q13 澄清机制接线

- **现状**：`needsClarification` / `questions` 在 schema 与提示词里都有（`os-intent.ts:29-30,83-84`），**前后端都没有消费点**。
- **动作**：`ai-dispatch.service.ts:91-99` 的缺参分支改成回"澄清卡"（带 2~3 个候选选项），用户点选后带着原参数续跑。
- **验收**：对助手说"帮我做个 PPT"（不给主题）→ 必须回澄清而不是拿默认值瞎做一份。

### Q14 上下文按 token 预算裁剪

- **动作**：`HISTORY_LIMIT=12` 改为预算制：system 与能力清单常驻 + 最近 N token 原文 + 更早部分做摘要；
  长工具结果（如 OCR 全文）只保留摘要与文件引用，不整段回灌。
- **落点**：`os.service.ts:469-479` 的 `recentHistory`。
- **验收**：连续 30 轮对话后仍能正确调用工具，且不出现上下文超限错误。

### Q15 工具循环动态化 + 失败诊断回灌

- **动作**：`MAX_TOOL_ROUNDS=2` 改为按任务复杂度 2~4；工具失败/被拒时把**失败原因**（而不是裸错误）回灌给模型，让它换参数或换工具重试。
- **落点**：`os.service.ts:63`、`:312`；`ai-dispatch.service.ts`。
- **验收**："把这个 PDF 转成 Word 再总结"这类两步任务能跑通（当前需 3 轮以上必然失败）。

### Q16 结果自检再答复

- **动作**：工具成功后，把产物摘要（页数/字数/文件名/质量分）回灌给模型，**再**让它组织最终答复；
  分数过低时答复里主动说明"内容偏短，可重新生成"。
- **验收**：助手不得在产物落地前宣布完成；低分产物必须被提及。

### Q17 用户偏好记忆

- **动作**：沉淀用户画像（专业/年级、偏好字数、常用风格、语言），注入对话 system；`files` 卡与历史产物可引用。
- **验收**：第二次让助手写同类型文档时，风格与深度应符合上次偏好。

---

## 6. P1 · 非 AI 工具产出质量

### Q18 图片链路

| 子项 | 动作 | 落点 |
|---|---|---|
| Q18a | `sharp(buffer).rotate()` 修 EXIF 方向；`.withMetadata()` 保留 ICC | `sharp-image.provider.ts` |
| Q18b | **目标体积二分迭代**：传 `targetSizeBytes` 时按 quality 二分逼近（现有 `:24-33` 分支已预留，只是从没被调用） | 同上 + `image-tool-runner.ts:34-38` 真正传参 |
| Q18c | png 分支改为 `palette:true` 真压缩；压缩后变大则**回退原图 + 结果页明示"该图已无压缩空间"**（红线 9：降级必须可见） | 同上 |
| Q18d | 最大边限制（如 4096）+ alpha 处理（转 jpeg 时白底而非黑底） | 同上 |
| Q18e | 增强参数可配置（锐化半径/饱和度）；`_scale` 被丢弃 → **要么接真超分，要么把 2x/4x 选项下线**（现在等于欺骗） | `sidecar-image.provider.ts:53` |
| Q18f | 产物格式与扩展名一致（`toBuffer()` 带 format 或按实际格式命名） | `image-tool-runner.ts:93-95` |

### Q19 视频链路

| 子项 | 动作 | 落点 |
|---|---|---|
| Q19a | 编码器**可见**：落 `tool_job.result.encoder`，结果页展示；落到 `mpeg4`/`libopenh264` 等低质量编码器时结果页明示"兼容模式，画质较低" | `ffmpeg.py` + 结果页 |
| Q19b | 目标体积优先：CRF 与 `-b:v` 互斥使用；需要精确体积时开两遍编码（可开关，默认关） | `_quality_args`（`:443-467`） |
| Q19c | 产出后校验：体积超目标 / 时长与源差异 >1s / 无音轨 → 明确失败而非"成功但不对" | `handlers.py` |
| Q19d | 裁剪提供"快速（`-c copy`，关键帧对齐）"与"精确（重编码）"两种模式，默认精确，UI 说明差异 | `media-tool-runner.ts:99`（当前未传 mode） |

### Q20 音频链路

- 输出码率**跟随源文件**（不低于源），取消一律 96k 的写死；降噪强度走用户参数而非硬编码档位；格式默认保持源容器。
- 落点：`services/media/handlers.py:317-318`、`:229`、`:310`。

### Q21 PDF 链路

- 压缩增加图片降采样（按目标体积选 DPI），让扫描件压得动；
- 取文本遇到**无文字层**（扫描件）时，结果页直接引导到 `ocr_image` 而不是让用户拿到空结果（后端已抛 42213，前端要接住）。
- 落点：`services/pdf/engine.py:147-156`、`apps/mp` 结果页。

### Q22 统一产物元信息与后置校验（横切，收益最大）

- **动作**：
  ① `ToolJob` 增 `result Json?`，统一写入 `{ sizeBefore, sizeAfter, ratio, width, height, durationSec, pages, encoder, latencyMs, qualityScore }`；
  ② 统一后置校验：`buffer.length === 0` / 体积异常增长 / 时长异常 → 判失败并给明确错误码；
  ③ 结果页展示压缩率、分辨率、时长、页数、耗时（`presenters.ts:128-139` 目前没用 `fileAsset.size`）。
- **验收**：跑一次图片压缩与一次视频压缩，结果页能看到"12.4MB → 3.1MB（-75%）"这类信息。

---

## 7. P2 · 演进机制（让质量持续变好）

### Q23 Golden set 与离线回归

- 建 20~30 条**真实**用例（含中文长文、含表格、含刁钻指令），固定模型与温度，
  离线跑出分数基线；提示词或模型变更时对比基线，**下降即失败**。
- 与 `quality.spec.ts`（打 fixture）区分开：那是"评分器自测"，这是"产出回归"。

### Q24 反馈闭环与提示词版本化

- 结果页加「有用 / 没用」+ 原因（太短 / 不对题 / 有错 / 格式差），落库并关联 `jobId` + `promptVersion` + `model`；
- 提示词从函数内硬编码（`document-specs.ts:48`、`tool-executor.service.ts:373`）抽为带版本号的资源，
  支持按版本灰度对比（Q23 的基线上跑 A/B）。

---

## 8. 排期与任务编号建议

| 批次 | 措施 | 建议编号 | 依赖 |
|---|---|---|---|
| **P0 度量** | Q1 Q2 Q3 Q4 | M3-01 质量度量闭环 | 无，**最先做** |
| **P1-A 生成** | Q5 Q6 Q8 Q12 | M3-02 生成链路增强 | M3-01 |
| **P1-B 协议** | Q7 Q9 Q11 | M3-03 模型调用层加固 | 无（可并行） |
| **P1-C 智能** | Q13 Q14 Q15 Q16 | M3-04 对话理解增强 | M3-02 |
| **P1-D 工具** | Q18 Q19 Q20 Q21 Q22 | M3-05 / M3-06 非 AI 工具质量 | 无（可并行） |
| **P2 演进** | Q10 Q17 Q23 Q24 | M3-07 质量演进机制 | M3-01 |

并行建议：M3-03 与 M3-05 与 M3-01 可同时开工（不同模块，无文件冲突）；M3-02 依赖 M3-01 才有量化前后对比。

---

## 9. 风险与取舍

| 风险 | 说明 | 处置 |
|---|---|---|
| 成本翻倍 | self-refine 最多 2 倍 token | 仅 `score<85` 触发；按档位/积分控制；先跑两周看触发率 |
| 延迟上升 | 两阶段 + refine 显著变慢 | 逐阶段上报 `stage` 进度；PPT 走分批，首批先出 |
| 评分器误判 | 新维度（指令遵循/贴合度）可能误杀 | **先观察后强制**：新维度先只落库不计入总分，跑够样本再进 85 分门槛 |
| 合规 | 换模型 = 新依赖 | 任何新模型先登记 `docs/compliance/OPEN_SOURCE_LICENSES.md`，`Research Only`/`Non-commercial` 不用 |
| 降级不可见 | 压完更大、编码器降级、超分没做 | 一律**显式告知**（红线 9），不许静默换结果 |
| 过度工程 | 24 条全做会拖长周期 | 严格按 P0 → P1-A → 其余；**没有度量就不要做优化** |

---

## 10. 每批交付门禁（沿用现有约定）

```bash
npm run lint            # ≤300 行 / ≤50 行 / 禁 any / 禁 ==
npm run typecheck       # 含 apps/mp
npm test                # 改 packages/core 必须补用例（Q7/Q10 必须有单测）
npm run build
npm run check:ai-output-quality   # 标准 / 提示词 / 质检 / 图表类型四处对账
npm run check:ai-capabilities     # 能力目录对账（动 os 模块时）
npm run verify:tools              # 26/26
npm run verify:ppt-quality        # Q4 新增：端到端内容质量判据
```

新增守卫建议：`npm run check:sampling`（Q9，禁止散落 temperature 字面量）。
