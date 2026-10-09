# 开源组件与 License 台账

> 落地文件：本文件（对应设计文档 2.12 强制要求）
> 首次建立：2026-09-17（M0-22）
> 维护规则：**任何新依赖引入前必须先登记本表**，未登记不得进入生产依赖

**核查工具**：`python scripts/license/license_audit.py`（自动拉取 Star / License / 归档状态）
**CI 守卫**：`.github/workflows/ci.yml` 的 compliance job 会校验本文件存在，并执行 FFmpeg 许可断言

---

## 一、三条红线（不可协商）

> 1. License 不明确的一律**不作为生产依赖**
> 2. 标注 `Research Only` / `Non-commercial` 的模型权重**一律不用**
> 3. AGPL/GPL 组件**一律独立服务 + 只调 API**，不链接、不修改、不分发

---

## 二、A 级：可直接使用（MIT / Apache-2.0 / BSD）

| 组件 | 版本 | 仓库 | License | 商用 | 署名 | 模型 License | 使用位置 | 风险 |
|---|---|---|---|---|---|---|---|---|
| PptxGenJS | ^3.12.0 | gitbrent/PptxGenJS | MIT | 允许 | 保留版权声明 | — | `apps/api/src/infra/providers/ppt/` | 低 |
| Sharp | ^0.33.5 | lovell/sharp | Apache-2.0 | 允许 | 保留 NOTICE | — | `apps/api/src/infra/providers/image/` | 低 |
| MinIO JS SDK | ^8.0.7 | minio/minio-js | Apache-2.0 | 允许 | 保留 NOTICE | — | `apps/api/src/infra/providers/storage/`（M0-12 对象存储直传） | 低 |
| ws | ^8.21.3 | websockets/ws | MIT | 允许 | 保留版权声明 | — | `apps/api/src/modules/job/job-progress.gateway.ts`（M1-05 进度推送） | 低 |
| NestJS | ^10.4 | nestjs/nest | MIT | 允许 | 保留版权声明 | — | `apps/api` | 低 |
| zod | ^3.24 | colinhacks/zod | MIT | 允许 | 保留版权声明 | — | `packages/core/src/validators/` | 低 |
| Vant Weapp | 1.x（按需） | youzan/vant-weapp | MIT | 允许 | 保留版权声明 | — | `apps/mp`（基础组件） | 低 |
| Qdrant | v1.19.1（实测落地版本） | qdrant/qdrant | Apache-2.0 | 允许 | 保留 NOTICE | — | 向量库：知识库检索（M4-06）**必需**；实现见 `apps/api/src/infra/providers/vector/`（裸 HTTP 调用，**不引入任何 npm 依赖**） | 低 |
| PaddleOCR | — | PaddlePaddle/PaddleOCR | Apache-2.0 | 允许 | **需署名** | — | OCR 工具（`services/ai/ocr.py`，`OCR_PROVIDER=selfhost` 时启用；CPU 版 paddlepaddle） | 低 |
| faster-whisper | — | SYSTRAN/faster-whisper | MIT | 允许 | 保留版权声明 | Whisper 权重 MIT | 语音转文字（`services/ai/asr.py`，`ASR_PROVIDER=selfhost` 时启用） | 低 |
| Mermaid | 11.4.1（vendor 本地化） | mermaid-js/mermaid | MIT | 允许 | 保留版权声明 | — | 思维导图 / 图表渲染（`services/media/templates/`，`RENDER_PROVIDER=playwright` 时服务端出图；JS 已本地化无 CDN） | 低 |
| docling | >=2.0 | docling-project/docling | MIT | 允许 | 保留版权声明 | — | 文档解析（`services/pdf/docling_parse.py`，`DOC_PARSER_PROVIDER=docling` 时启用；模型产物落 `DOCLING_ARTIFACTS_PATH`） | 低 |
| markmap（lib/view） | 0.18.12（vendor 本地化） | markmap/markmap | MIT | 允许 | 保留版权声明 | — | 思维导图渲染模板（`services/media/templates/markmap.html`） | 中（上游 release 停更，须锁版本） |
| d3 | 7.9.0（vendor 本地化） | d3/d3 | ISC | 允许 | 保留版权声明 | — | markmap 渲染依赖（`services/media/templates/vendor/`） | 低 |
| playwright | 1.49.1 | microsoft/playwright | Apache-2.0 | 允许 | 保留 NOTICE | — | 服务端图表截图（`services/media/render.py`；chromium 由 `playwright install` 独立安装） | 低 |
| deepwiki-open | 自托管 REST | AsyncFuncAI/deepwiki-open | MIT | 允许 | 保留版权声明 | — | 仓库解读（`apps/api/src/infra/providers/repo/` 只调 `POST /api/wiki/ask`，不引入 SDK；`DEEPWIKI_BASE_URL` 配置后才启用） | 低 |
| omni-tools | — | iib0011/omni-tools | MIT | 允许 | 保留版权声明 | — | 小程序本地小工具的**选题与算法思路参考**（`apps/mp/pkg-toolbox/{timestamp,base64,password,json,diff,unit,datecalc}/`，全部 TS 重写非拷贝） | 低 |
| node-qrcode | ^1.5.4 | soldair/node-qrcode | MIT | 允许 | 保留版权声明 | — | `apps/api/src/modules/job/image-tool-runner.ts`（`generate_qrcode` 二维码生成，纯本地计算） | 低 |
| pdf-lib | ^1.17.1 | Hopding/pdf-lib | MIT | 允许 | 保留版权声明 | — | `apps/api/src/modules/job/pdf-tool-runner.ts`（`images_to_pdf` 图片合成 PDF，纯 JS 无原生依赖） | 低 |
| @types/qrcode | ^1.5.6 | DefinitelyTyped/DefinitelyTyped | MIT | 允许 | — | — | 仅开发期类型声明，**不进运行时产物** | 低 |

## 三、B 级：必须隔离部署（AGPL / GPL）

> 接入方式：**独立容器 + HTTP API**。不链接、不修改、不分发源码。

| 组件 | 仓库 | License | 风险 | 处置 | 使用位置 |
|---|---|---|---|---|---|
| ConvertX | C4illin/ConvertX | **AGPL-3.0** | 网络服务即触发开放义务 | 独立部署，只调 API | `CONVERT_SERVICE_URL` |
| PPTist | pipipi-pikachu/PPTist | **AGPL-3.0** | 同上 | 独立服务或仅参考 | 在线 PPT 编辑（P1） |
| Pandoc | jgm/pandoc | **GPL-2.0** | 强传染 | 独立服务，不分发二进制 | 文档格式转换 |
| LibreOffice | LibreOffice/core | GPL-3.0 / MPL-2.0 | 强传染 | 独立容器 | 文档转换 |
| **FFmpeg** | FFmpeg/FFmpeg | **LGPL-2.1+（必须选此构建）** | 选错构建（含 `--enable-gpl`）会污染整个项目 | **必须 LGPL 构建 + 子进程调用**，CI 用 `scripts/license/check-ffmpeg-license.sh` 断言 | 音视频处理 |
| **PyMuPDF** | pymupdf/PyMuPDF | **AGPL-3.0**（Artifex 双许可：AGPL 或商业授权） | 网络服务 / 链接进主工程都会触发开放义务 | **独立安装 + 子进程调 CLI**，绝不 `import fitz`；`services/pdf/requirements.txt` 保持为空 | PDF 合并 / 拆分 / 压缩 / 取文本（`PYMUPDF_BIN`） |
| Stirling-PDF | Stirling-Tools/Stirling-PDF | **MIT + 多目录例外**（2026-10-08 读 LICENSE 全文核实） | 基座 MIT，但 `app/proprietary/`、`app/saas/`、`engine/`、`frontend/editor/src/{proprietary,desktop,saas,cloud,portal,portal-saas}/` 各挂独立商业许可；GitHub 因此显示 `NOASSERTION` | **不得整包当 MIT 用**；只用非例外目录，或独立部署只调 API | PDF 工具（P1） |
| MinerU | opendatalab/MinerU | **Apache-2.0 + 附加条款**（2026-10-08 读 LICENSE 全文核实） | ① 商业可用不需授权，除非 MAU > 1 亿 或 月营收 > 2000 万美元；② **基于它对外提供在线服务须在界面显著署名** | 现阶段阈值远未触及 → 可用，但**必须挂署名**；无署名 UI 之前不进生产 | 文档解析（P1） |

## 四、C 级：仅参考设计，不引入代码

| 组件 | 仓库 | License | 只借鉴什么 |
|---|---|---|---|
| Langflow | langflow-ai/langflow | MIT | 节点化编排与状态管理思路 |
| MetaGPT | FoundationAgents/MetaGPT | MIT | 多 Agent 角色协作与 SOP 拆解 |
| LangGraph | langchain-ai/langgraph | MIT | StateGraph / Checkpointer 思想（**不引入依赖**，ADR-02） |
| it-tools | CorentinTh/it-tools | **GPL-3.0** | **仅交互与信息架构，绝不抄代码** |
| PowerTools | SmileSnail5470/PowerTools | **GPL-3.0** | 仅「授权素材处理」的合规话术 |
| Dify | langgenius/dify | Apache-2.0 + 附加条款 | Workflow / HITL 设计（不引入） |

## 五、禁止使用

| 组件 | 仓库 | 原因 |
|---|---|---|
| n8n | n8n-io/n8n | Sustainable Use License，**禁止作为商业服务转售/托管** |
| UVR 模型权重 | Anjok07/ultimatevocalremovergui | 代码 MIT，但**集成的模型权重多为 Research Only** → 改用 Demucs / spleeter 直连 |
| rembg 受限模型 | danielgatis/rembg | `isnet-general-use` / `birefnet-*` 等许可受限 → **仅使用白名单模型**（见下） |

### rembg 模型白名单（代码级强制，`services/ai`）

```python
COMMERCIALLY_SAFE_MODELS = {"u2net", "u2netp", "u2net_human_seg", "silueta"}
# 明确排除：isnet-general-use, birefnet-*, sam, ...
```

## 六、模型权重许可（与代码许可分开核查，文档 2.8）

| 组件 | 代码 License | 权重许可 | 结论 |
|---|---|---|---|
| faster-whisper | MIT | Whisper 权重 MIT | ✅ 可用 |
| Demucs | MIT | 官方随仓库发布的权重为 MIT | ✅ 可用（**原 GitHub 仓库已归档**，长期需评估替代） |
| PyTorch（`torch`） | BSD-3-Clause | — | ✅ 可用（Demucs 的运行时依赖，随 `pip install demucs` 装入；CPU 版即可跑） |
| spleeter | MIT | 官方模型 MIT | ✅ 可用 |
| rembg | MIT | **部分模型受限** | ⚠️ **仅白名单模型** |
| UVR | MIT（代码） | **多数 Research Only** | ❌ 不使用其权重 |
| 云端 LLM（DeepSeek/Qwen/…） | — | 由服务商条款约束 | ✅ 按 API 条款使用，需记录条款 URL |
| **智谱 GLM-5.3-Flash（云端 API，当前在用）** | — | **调用免费**（服务商条款约束）；模型权重**未开源**，仅通过 API 使用 | ✅ 已接入（M1-07 / M1-11）。条款：<https://open.bigmodel.cn/dev/api> 与《智谱开放平台服务协议》。⚠️ 该模型为**推理型**（始终思考），需配 `reasoning_effort` 控制成本；权重不开源，若未来要求"开源自部署"需另选 Qwen3.5（Apache-2.0）等 |

## 七、Node 依赖清单（package.json）

运行时依赖（均由 npm 管理，License 见各包内 `LICENSE`）：

| 包 | 版本 | License |
|---|---|---|
| @nestjs/common / core / platform-express | ^10.4.15 | MIT |
| @nestjs/config / jwt / swagger / throttler | ^3/10/8/6 | MIT |
| @prisma/client + prisma | ^6.2.1 | Apache-2.0 |
| pptxgenjs | ^3.12.0 | MIT |
| sharp | ^0.33.5 | Apache-2.0 |
| zod | ^3.24.1 | MIT |
| ioredis | ^5.4.2 | MIT |
| minio | ^8.0.7 | Apache-2.0 |
| ws | ^8.21.3 | MIT |
| bcryptjs | ^2.4.3 | MIT |
| jsonwebtoken | ^9.0.2 | MIT |
| rxjs | ^7.8.1 | Apache-2.0 |
| reflect-metadata | ^0.2.2 | Apache-2.0 |

开发依赖：typescript / eslint / prettier / vitest / husky / lint-staged / commitlint / miniprogram-api-typings — 均为 MIT/Apache-2.0。

管理后台前端（`apps/admin`，React + Vite，2026-09-20 登记）—— **全部为 MIT，A 级**：

| 包 | 版本 | License | 用途 |
|---|---|---|---|
| react / react-dom | ^18.3.1 | MIT | UI 运行时 |
| react-router-dom | ^6.30.6 | MIT | 路由（列表 ↔ 详情 ↔ 表单跳转） |
| vite | ^5.4.0（实装 5.4.21） | MIT | 构建与 dev server |
| @vitejs/plugin-react | ^4.7.0 | MIT | React 插件（Babel 转换） |
| @types/react / @types/react-dom | ^18.3.x | MIT | 类型（仅开发期） |

> `zod` 与 `@qz/core` 的 zod 是同一份（根 node_modules 去重后为 3.25.76），
> 不重复登记；前端复用它做**与后端同源**的表单校验。
>
> ⚠️ 本表为**声明范围**；npm 会提升/去重到具体版本（如 vite 实装 5.4.21）。
> 生产构建产物内不含这些包的源码（已被打包器转换为自有产物），
> 但 `THIRD_PARTY_NOTICES.md` 仍需保留其版权声明（见第八节待办）。

## 七、词书数据来源（M4-15 记单词，2026-09-21 扩充）

> ⚠️ **这是"数据"不是"代码"**，但处置原则同源：**授权不明确的一律不作为可分发内容**。
> 落地脚本：`scripts/db/fetch-wordlists.mjs`（下载 + 校验 + 落盘 JSONL）
> → `scripts/db/gen-words.mjs`（纯导入，**不联网、不调 LLM**）。

### ⚠️ 处置口径已变更（2026-09-21）：从"只取词形"改为"完整入库"

**变更前**：只取词形（拼写），释义/音标/例句由本项目 LLM 生成。

**变更后**：**直拉上游的完整词条**（含美/英音标、释义、词组搭配、例句），
逐条校验后落库，`word.source='curated'`。

**变更理由**：核查发现上游 `full_line_jsonl/sentence/正序/` 目录本身就是
**带完整释义、音标、词组、例句的成品数据**。若坚持"只用词形 + LLM 重新生成"，
等于花十几个小时把已有内容再编一遍，且 LLM 产出还会漂移、会编造词源。

**风险已如实登记**：上游 `KyleBing/english-vocabulary` **无 LICENSE（All Rights Reserved）**。
本项目**不分发、不修改、不复制**其仓库文件，但**确实把其整理的释义/词组落入了本项目数据库**
（这些是**有独创性的编排与表达**，随来源授权走）。**此项风险由项目方承担并已明示**，
无明确授权即可上线使用 —— 上线前必须复核（见下）。

### 取用范围对照

| | 取什么 | 依据 |
|---|---|---|
| **取** | 单词**拼写** + "属于哪本词表" | **事实性数据**，源自公开考试大纲 / 课标，不构成有独创性的表达 |
| **取（本次变更）** | 美/英**音标**、**释义**、**词组搭配**、**例句** | ⚠️ 这些是**有独创性的编排与表达** → **属登记风险项**，非"已获授权" |
| **不取** | 上游仓库的任何文件本身 | 不分发、不修改、不复制其文件 |
| **不标为权威** | 界面不得声称这是权威词典（`source='curated'` 如实标注） | 见 `schema.prisma` 的 `source` 列说明 |

### 来源清单

| 来源 | 仓库 | 声明 License | 取用范围 | 风险与处置 |
|---|---|---|---|---|
| KyleBing/english-vocabulary | github.com/KyleBing/english-vocabulary | **无 LICENSE（All Rights Reserved）** | 23 本词书的**完整词条**（词形 + 音标 + 释义 + 词组 + 例句） | ⚠️ **中高**。README 自述为"共享学习资源"，向上游 `kajweb/dict`（爬自公开背单词应用）追溯。**已按"无授权 = 保留所有权利"登记风险**：项目方决定"完整入库 + 登记风险"，上线前法务复核 |
| 全国大学英语四、六级考试大纲（2016 年版） | 公开 PDF（全国大学英语四六级考试委员会） | 官方公开考纲 | 四/六级**词表范围**（词形） | 低。考试大纲属公开教育文件，词表是应考范围的事实描述 |
| mahavivo/english-wordlists | github.com/mahavivo/english-wordlists | **无 LICENSE（All Rights Reserved）** | ⚠️ **本版未使用**（仅词形，已由上面的完整词书取代） | 已不再引用；保留此条以记录历史核查 |
| 义务教育 / 高中课程标准 | 教育部公开文件 | 官方公开文件 | 小学 / 初中 / 高中**词表范围**（词形） | 低。同上：课标是公开教育文件 |

> **为什么要写清"已登记风险"而不是"已获授权"**：这两句话的法律含义完全不同。
> 把"无 LICENSE 的上游数据"含糊成"公开资源，可以用"，是**把风险藏起来**——
> 将来出问题时会发现**没有人做过这个决定**。现在的写法让"谁在什么情况下接受了什么风险"可追溯。

> ⚠️ **上线前必须复核（这是硬性前置，不是建议）**：若法务否决，
> 处置是**只保留官方大纲/课标来源的词形**，释义与例句改为本项目 LLM 重新生成
> （即回到"变更前"的口径）。脚本已把来源声明在 `books.json` 的 `source` 字段，
> 改来源只需换 `fetch-wordlists.mjs` 的 `BOOKS` 并重跑 `db:fetch-words` + `db:gen-words`。

### 词书与词量（实测值，`npm run check:vocab-books` 可复核）

> ⚠️ **本表已于 2026-09-21 按 M4-16 的精简口径更新**。原 23 本词书中的
> 小学（`primary3`~`primary6`）、初中通用（`junior` / `junior7`~`junior9`）、
> 高中通用（`highschool` / `highschool_rj`）**已按需求删除**，
> 学段词书只保留两本**教材版**（`junior_bnu` 初中·外研社、`highschool_bs` 高中·北师大），
> 腾出的版面用于四六级句子 / 口语 / 作文三类练习。
> **词书数量本身不是守卫判据**（见 `check-vocab-books.mjs` 的说明），
> 守住的是"每本都有非空数据"与"总量不退化成起步词表"。

| code | 名称 | 分类 | 级别 | 词条数 |
|---|---|---|---|---|
| `junior_bnu` | 初中词汇（外研社） | school | -1 | 1,652 |
| `highschool_bs` | 高中词汇（北师大） | school | 0 | 2,874 |
| `cet4` / `cet6` | 四级 / 六级核心词汇 | exam | 1 / 2 | 4,543 / 3,991 |
| `tem4` / `tem8` | 英语专业四级 / 八级词汇 | exam | 3 / 4 | 4,338 / 12,405 |
| `kaoyan` | 考研核心词汇 | exam | 3 | 5,044 |
| `ielts` / `toefl` | 雅思 / 托福核心词汇 | abroad | 5 | 5,254 / 10,363 |
| `sat` / `gre` / `gmat` | SAT / GRE / GMAT 核心词汇 | abroad | 6/7/7 | 4,437 / 9,982 / 3,301 |
| `business` | 商务英语词汇 | career | 4 | 2,801 |
| | **合计** | | | **13 本 / 70,985 条关联** |

> **"13 本 / 70,985 条"与"不重复单词数"是两个数**：一个词可同属多本词书
> （`word_book_word` 是关联表）。**报总数时必须说清是哪一个**，否则看起来像重复计数。

---

## 七之二、句子语料来源（M4-16 练习中心，2026-09-21 新增）

> 落地脚本：`scripts/db/fetch-sentences.mjs`（下载 + 规则过滤 + 落盘 JSONL）
> → `scripts/db/gen-sentences.mjs`（**纯导入，不联网、不调 LLM**：切语块、判可朗读性、写库）。

### 来源清单

| 来源 | 仓库 | 声明 License | 取用范围 | 风险与处置 |
|---|---|---|---|---|
| Tatoeba（多语言例句库） | tatoeba.org（导出包 `sentences.tar.bz2` + `links.tar.bz2`） | **CC-BY 2.0 FR** | 英文例句（含中文对译，经 `links` 表按句 id 关联） | ✅ **低 —— 这是本项目第一个"授权明确"的外部数据集**。CC-BY 的要求是**署名**：界面/关于页须标注"例句来自 Tatoeba（CC-BY 2.0 FR）"。**未做署名即违反许可**，与"无授权"同等级别的风险 |

**实测规模**：入库 21,039 条，其中**适合口语跟读**的经 `isSpeakable()` 筛出子集
（≥4 词、不含双引号 —— 引述对话要读两个人的话，且 ASR 会把引号吃掉）。

> ⚠️ **撇号 ≠ 引号**：过滤规则里 `/["']/` 会误伤 `don't` / `it's`，一次跳掉 3,960 条。
> 英文里**对话引号一律是双引号**，所以判据只用 `"`。这条已写进 `gen-sentences.mjs` 注释。

> ⚠️ **语块（连词成句的"砖块"）在导入时预先切好落库**，不在请求时算 ——
> 原因见 `gen-sentences.mjs` 文件头：请求时切会让同一句话两次练到的砖块不同，
> 且"改了切分规则要重跑"要求切分是可重复的确定性过程。
> ⚠️ 落库的键名是 **`text`**（不是 `en`），读取端在 `practice-queue.service.ts` 的 `toChunks()`
> —— **这两处必须一致**，曾经不一致导致 21,039 条的砖块全部静默失效。

### 作文题库

`apps/api/prisma/seed.ts` 的 `seedPracticeTopics()`：**8 道**四六级作文题（真题 6 / 模拟 2），
`source='curated'`（本项目自编提纲，**范文由 LLM 生成且必须标注为 AI 生成**，
不得冒充官方范文 —— 见 `PracticeTopic.sample` 列注释）。

---

## 七之三、2026-10-08 同类开源项目检索新增（**全部尚未引入**）

> 来源：GitHub Search API 实测（star / 最近 push / SPDX 均为当日值）+ 关键项 LICENSE 全文。
> 本节只登记**核查结论**，不构成引入决定。真正引入前仍要按 §八 的动作再跑一次
> `curl https://api.github.com/repos/{owner}/{repo}`，并按红线 1 复核 LICENSE 全文。

### 可引入的候选（License 干净）

| 组件 | 仓库 | License | 核查结论与用途 |
|---|---|---|---|
| **pdfcpu** | pdfcpu/pdfcpu | Apache-2.0 | Go CLI，覆盖合并 / 拆分 / 压缩 / 书签 / 元数据。**是 §三 PyMuPDF（AGPL）的一条无传染替代路径**：同为"子进程调 CLI"形态，但不需要"独立安装 + 绝不 `import fitz`"这条边界。若采纳，可顺带消掉 AGPL 面 |
| **opendataloader-pdf** | opendataloader-project/opendataloader-pdf | Apache-2.0（**无附加条款**） | PDF → AI-ready 结构化。比 §三 MinerU 干净：无 MAU/营收阈值、无在线服务署名义务。是 `parse_document` 与课件 RAG 入库的首选候选 |
| **Umi-OCR** | hiroi-sora/Umi-OCR | MIT | 离线 OCR，支持**排除水印 / 页眉页脚** —— 现有 `ocr_image` 没有的能力 |
| **sensitive-word** | houbb/sensitive-word | Apache-2.0 | DFA 敏感词，带**标签分类分级**。可借它的分级标签喂 `moderation`（Java 库本身不引，取其词库与分级思路） |
| **SmartSub** | buxuku/SmartSub | MIT | 仅参考：ASR → 翻译 → 润色 → TTS → 烧录的**流水线化**组织方式（本项目这几个能力是散点工具） |
| **nanobot** | HKUDS/nanobot | MIT | 仅参考：模型路由与**降级/fallback** 策略（本项目实测 4xx 不触发降级，值得对照它的实现）。Python 栈，不引依赖 |
| **geekai** | yangjian102621/geekai | Apache-2.0 | 仅参考：注册登录 / 充值 / 按次与包月套餐的商品化表达（Go 后端，搬不动代码，搬业务模型） |

### 明确**不可**导入的数据源（红线 1）

| 数据 | 仓库 | License | 结论 |
|---|---|---|---|
| GPT-4 生成的单词书 | Ceelog/DictionaryByGPT4 | **CC-BY-SA-4.0** | ShareAlike 会传染衍生词库。**只借字段设计**（词义 / 例句 / 词根词缀 / 变形 / 文化背景 / 记忆技巧），数据不搬，除非拿到单独授权 |
| 四六八级 / 考研 / 雅思 / 托福词库 | kajweb/dict | **无 LICENSE** | 默认保留所有权利，**法律上不可用**。只当覆盖率对照表，用于核对 `scripts/db/data/books.json` 的词书是否漏了常见大纲 |
| 打字背单词 | RealKai42/qwerty-learner | GPL-3.0 | 不进 `apps/`。仅参考它的听写 / 拼写练习闭环交互 |

## 八、上线前自查清单

- [ ] 所有生产依赖均已登记本表
- [ ] 所有 `NOASSERTION` 项已人工打开 LICENSE 全文确认
- [ ] 所有模型权重已单独核查许可
- [ ] FFmpeg 已确认为 LGPL 构建（`ffmpeg -buildconf` 无 `--enable-gpl`）
- [ ] AGPL/GPL 组件已确认为独立进程 + HTTP 调用
- [ ] MIT/Apache-2.0 组件的版权声明已保留在 `THIRD_PARTY_NOTICES.md`（待补）
- [ ] rembg 模型白名单已在代码中强制校验
- [ ] **词书数据来源已复核**（第七节）：⚠️ **这是硬性前置**。当前词库**完整入库了无 LICENSE 上游
      （KyleBing/english-vocabulary）的音标/释义/词组/例句** —— 若法务否决，
      改为"只保留官方大纲/课标来源的词形"，释义与例句由本项目 LLM 重新生成
- [ ] **Tatoeba 署名已落地**（第七之二节）：CC-BY 2.0 FR **要求署名**。
      须在小程序「关于」页与文档中标注"例句来自 Tatoeba（CC-BY 2.0 FR）"。
      ⚠️ **未署名即违反许可** —— 与"无授权使用"是同一等级的风险，不是"最好加上"
- [x] 云端 LLM 服务条款 URL 已记录，且确认允许商用（智谱 GLM-5.3-Flash：2026-09-17 登记，Flash 系列免费；商用条款见智谱开放平台协议）
- [ ] 已确认没有 GPL 代码被复制进主工程

---

**维护提示**：License 与 Star 会变化，建议每季度执行一次
`GITHUB_TOKEN=xxx python scripts/license/license_audit.py` 并更新本表。
