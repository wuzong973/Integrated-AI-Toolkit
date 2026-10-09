# 「青智校园」GitHub 仓库清单

> 整理日期：2026-09-17
> 数据来源：①工作区《青智校园_同类开源项目检索报告》（GitHub Search API 实时拉取）②本次详细设计文档附录 A
> **重要**：标注 ✅ 的条目为 2026-09-17 经 GitHub API 核实过 Star 数与 License；标注 ⚠️ 的条目仅给出官方地址，**Star/License 未核实，正式引入前必须自己再跑一次 `https://api.github.com/repos/{full_name}` 核对**。
> 星标数与许可证会变动，以开工当日为准。

---

## 一、✅ 已核实：可直接使用的底层组件（MIT / Apache-2.0）

这一层是"轮子"，可以直接装、可以商用，是成本最低的部分。

| 用途 | 仓库 | 地址 | Star | License | 备注 |
|---|---|---|---|---|---|
| PPT 渲染引擎 | `gitbrent/PptxGenJS` | https://github.com/gitbrent/PptxGenJS | 6.2k | MIT | 生成 `.pptx` 的核心，首版必用 |
| AI PPT 全栈方案 | `presenton/presenton` | https://github.com/presenton/presenton | 10.3k | Apache-2.0 | 含 LLM 出结构 + 渲染，可作 PPT Agent 下游 |
| AI PPT（轻量备选） | `allweonedev/presentation-ai` | https://github.com/allweonedev/presentation-ai | 3.0k | MIT | 代码量小，好读好改 |
| 人声/伴奏分离 | `facebookresearch/demucs` | https://github.com/facebookresearch/demucs | 10.4k | MIT | GPU；**模型权重许可需单独核查** |
| 人声分离（备选） | `deezer/spleeter` | https://github.com/deezer/spleeter | 28.5k | MIT | 老项目，速度更快 |
| AI 抠图 / 去背景 | `danielgatis/rembg` | https://github.com/danielgatis/rembg | 24.8k | MIT | **部分模型非商用，选 u2net 等可商用权重** |
| 语音转文字 | `SYSTRAN/faster-whisper` | https://github.com/SYSTRAN/faster-whisper | 25.4k | MIT | CPU 也能跑，字幕/转写首选 |
| OCR 文字识别 | `PaddlePaddle/PaddleOCR` | https://github.com/PaddlePaddle/PaddleOCR | 89.7k | Apache-2.0 | 中文识别最好，需署名 |
| 文档解析（PDF→结构化） | `opendatalab/MinerU` | https://github.com/opendatalab/MinerU | 81.2k | **Apache-2.0 + 附加条款**（2026-10-08 核实） | ⚠️ 已从"可直接用"降级：在线服务须**显著署名**，且 MAU>1 亿 / 月营收>2000 万美元需商业授权。无署名 UI 前不进生产；无附加条款的替代见 `opendataloader-pdf` |
| PDF 工具中心 | `Stirling-Tools/Stirling-PDF` | https://github.com/Stirling-Tools/Stirling-PDF | 93.7k | **MIT + 多目录例外**（2026-10-08 核实） | ⚠️ 已从"可直接用"降级：`app/proprietary/`、`app/saas/`、`engine/`、`frontend/editor/src/{proprietary,desktop,saas,cloud,portal}/` 各挂商业许可，**不能整包当 MIT**。只参考其 50+ 操作的分类与搜索交互 |

---

## 二、✅ 已核实：可借鉴架构的产品级项目

这一层别抄代码，抄**信息架构与交互组织方式**。

| 借鉴点 | 仓库 | 地址 | Star | License | 怎么用 |
|---|---|---|---|---|---|
| 工具箱形态与分类 | `ZihangDong/toolknit-desktop` | https://github.com/ZihangDong/toolknit-desktop | 1.1k | Apache-2.0 | 看它的音视频/图片/PDF/AI 四大分类怎么组织 |
| 统一文件转换中心 | `LoredCast/filewizard` | https://github.com/LoredCast/filewizard | 1.1k | MIT | **源文档原文点名**；FFmpeg+LibreOffice+Pandoc+ImageMagick 的 WebUI 封装 |
| Agent 编排（可视化） | `langflow-ai/langflow` | https://github.com/langflow-ai/langflow | 155k | MIT | 学它的节点化与状态管理；License 比 Dify 干净 |
| 多 Agent 角色协作 | `FoundationAgents/MetaGPT` | https://github.com/FoundationAgents/MetaGPT | 70k | MIT | 学"策划员/写作员/调度员"的 SOP 化任务拆解 |
| 工具箱 UX 范本 | `CorentinTh/it-tools` | https://github.com/CorentinTh/it-tools | 41k | **GPL-3.0** | 只看交互，不抄代码（传染性） |
| 图片/视频合规话术 | `SmileSnail5470/PowerTools` | https://github.com/SmileSnail5470/PowerTools | 47 | **GPL-3.0** | 学它把"去水印"包装成"授权素材处理"的话术 |

---

## 三、⚠️ 高风险：必须隔离部署或放弃（AGPL / GPL / Fair-code）

**规则：以「独立服务 + HTTP API」方式接入，绝不复制源码进闭源内核，否则触发源码开放义务。**

| 项目 | 地址 | Star | License | 风险与处置 |
|---|---|---|---|---|
| ConvertX | https://github.com/C4illin/ConvertX | 19k | **AGPL-3.0** | 网络服务化即触发开放义务 → 独立部署、只调 API |
| PPTist | https://github.com/pipipi-pikachu/PPTist | 9.3k | **AGPL-3.0** | 在线 PPT 编辑器（补"生成后要改"的闭环）→ 独立服务或仅参考 |
| Dify | https://github.com/langgenius/dify | 156k | Apache-2.0 + 附加条款 | 多租户与商标限制 → 商用前核对；本项目建议**仅参考其 Workflow/HITL 设计，自研编排层** |
| n8n | https://github.com/n8n-io/n8n | 205k | Sustainable Use License | **禁止作为商业服务转售** → 参赛演示无碍，商业化需换掉 |
| UVR（人声分离 GUI） | https://github.com/Anjok07/ultimatevocalremovergui | 26k | MIT（代码） | **官方要求署名；集成的模型权重多为 Research Only** → 优先用 Demucs 直连 |

---

## 四、⚠️ 待核实地址（源文档只给了方向名，未验证过仓库）

A(1).docx 第四节列了这些方向。**2026-10-08 用 GitHub Search API 逐个实测：这 6 个名字都查不到对应的可维护仓库** —— 命中的只有 0~5 star 的同名玩具库或 2018 年归档项目。结论：它们是**方向名，不是真实仓库**，别再当待办挂着。

| 源文档提到的方向 | 用途 | 2026-10-08 实测结论 |
|---|---|---|
| LaZy Campus | 校园任务、接单、实时聊天、评价 | ❌ 无可维护仓库（只命中 `LazyCampus` 2018 归档、0★） |
| PeerCommerce | 校园技能服务、预约、订单、钱包 | ❌ 只命中 2 个 0★ 仓库（一个是 Zoho Creator 应用，非代码） |
| Campus AI Agent | 校园助手、意图识别 | ❌ 无同名仓库。**最接近的是 `20czy/zafu_xiaolin_campus_agent`**（36★，push 2026-08，"高校 AI harness，接入教务/一卡通/图书馆/OA"）—— 但**无 LICENSE，只读思路** |
| Conductor（任务编排） | 工作流、Human-in-the-loop | ❌ 名字太泛，无法定位到具体仓库；编排层按 ADR-02 自研 |
| TaskForce | Multi-Agent 协作 | ❌ 搜索命中 0 条 |
| Paperclip | AI 员工管理、Agent 组织 | ❌ 无可维护仓库 |

**已确认地址的相关项目**（有把握是官方仓，但 Star/License 本次未查）：

| 项目 | 地址 | 用途 |
|---|---|---|
| LangGraph | https://github.com/langchain-ai/langgraph | Agent 状态管理、工具调用、工作流（源文档点名） |
| FFmpeg | https://github.com/FFmpeg/FFmpeg | 音视频处理底座（**选 LGPL 构建 + 动态链接**） |
| Whisper | https://github.com/openai/whisper | 语音识别原版（生产建议用 faster-whisper） |
| Pandoc | https://github.com/jgm/pandoc | 文档格式转换（GPL-2.0，独立服务部署、不分发） |
| Tesseract OCR | https://github.com/tesseract-ocr/tesseract | OCR 备选 |
| ImageMagick | https://github.com/ImageMagick/ImageMagick | 图片处理备选 |
| LibreOffice | https://github.com/LibreOffice/core | 文档转换引擎（MPL-2.0，需署名） |

---

## 五、落地建议：按 License 分三档用

```
第一档  放心用（MIT / Apache-2.0）
        PptxGenJS · Presenton · Langflow · MetaGPT · Demucs · rembg
        faster-whisper · PaddleOCR · ToolKnit · File Wizard
        → 直接 install，写进 OPEN_SOURCE_LICENSES.md

第二档  隔离用（AGPL / GPL / Fair-code）
        ConvertX · PPTist · it-tools · PowerTools · n8n · Dify(条款)
        → 独立容器部署 + 只调 HTTP API，禁止复制源码进主工程

第三档  先别用（权重或条款不明）
        UVR 模型权重 · MinerU · Stirling-PDF · 第四节的 6 个校园项目
        → 开工前逐项跑 GitHub API 核实，不核实不进生产依赖
```

## 六、核实一条依赖的标准动作

```bash
# 1. 看仓库元信息（License、Star、是否归档）
curl https://api.github.com/repos/{owner}/{repo}

# 2. 看 License 全文与附加条款（很多项目根目录有 LICENSE + 额外 NOTICE）
curl https://api.github.com/repos/{owner}/{repo}/license

# 3. 看最近提交时间，判断是否停更
curl "https://api.github.com/repos/{owner}/{repo}/commits?per_page=1"

# 4. 模型类项目必须单独查权重许可（代码 MIT ≠ 权重可商用）
#    重点看 README / model card 里的 "License" 或 "non-commercial" 字样
```

> GitHub Search API 无需 token：搜索 10 次/分钟、core 接口 60 次/小时，批量查询记得 sleep 2s 以上。

---

## 七、需要维护的台账

按源文档要求，落地文件为 `/docs/compliance/OPEN_SOURCE_LICENSES.md`，每行必须登记：

`组件 | 版本 | 仓库地址 | License | 是否商用 | 署名要求 | 模型 License | 使用位置 | 风险说明`

**红线**：License 不明确的一律不作为生产依赖；标注 Research Only / Non-commercial 的模型权重一律不用。

---

## 七、2026-10-08 增补检索（AI 工具箱 / 日常实用工具方向）

### 先修正一个判断：**本地工具这一层本项目已经有了**

上一轮检索曾建议"照 `omni-tools` 的类目补日常实用工具"，但漏看了 `apps/mp/pkg-toolkit/`
—— 它已经在承担这一层（绩点 / AA 分账 / 抽签 / 考试倒计时 / 课程表 / 行程）。

**新增本地纯计算工具请进 `pkg-toolkit`，不要进 `seed.ts` 的 `TOOLS`。**
理由写在 `apps/mp/pkg-toolkit/gpa/index.ts` 顶部注释里：工具箱的"同步"路径**仍会建作业记录
并预扣额度**（`ToolInvokeService.invoke`），算一次绩点留一条作业是错配。本地工具的正确形态是
`apps/mp/utils/<tool>.ts` 纯函数 + `tests/<tool>.spec.ts` 单测 + 一个分包页面，
**零依赖、离线可用、不占额度**（小程序不能 `import '@qz/core'`，所以算法必须自包含在 `apps/mp/utils/`）。

2026-10-08 已按此形态补了 3 个：单位换算、日期差计算、字数统计。

### 新增参考（Star / push / SPDX 为 2026-10-08 实测）

| 借鉴点 | 仓库 | Star | 最近 push | License | 怎么用 |
|---|---|---|---|---|---|
| **工具箱类目全集** | `iib0011/omni-tools` | 10.3k | 2026-10-04 | **MIT** | 图片/视频/PDF/文本列表/日期时间/数学六大类；**全部客户端处理**、Docker 镜像 28MB。补类目的清单范本 |
| 卡片网格 + 主题 + **探活** | `lissy93/dashy` | 26.6k | 2026-10-07 | **MIT** | 未决 issue 仅 19，维护质量最高。它的"服务可用性检查"是 `check:tools`（静态）之外的运行期一层 |
| 插件 manifest 注册表 | `rubickCenter/rubick` | 10.0k | 2026-01 | **MIT** | uTools 式插件市场。可对照 `AI-CAPABILITY-DISPATCH.md` 的五步接入，把 seed 工具行升级为自描述 manifest |
| 工具箱 UX（**GPL**） | `CorentinTh/it-tools` | 40.8k | 2026-10-05 | GPL-3.0 | 已在 §二。补一条：它每个工具有独立 URL，对应"一句话直达"之外的分享/回访路径 |
| 字幕流水线 | `buxuku/SmartSub` | 5.6k | 2026-09-30 | **MIT** | ASR→翻译→润色→TTS→烧录一条链；本项目这几个是散点工具，串起来即增值 |
| 模型路由 / 降级 | `HKUDS/nanobot` | 48.8k | 2026-10-07 | **MIT** | 对照"4xx 不触发降级"这个实测痛点读它的 fallback 策略；Python 栈不引依赖 |
| 充值 / 套餐商品化 | `yangjian102621/geekai` | 4.7k | 2026-09-13 | **Apache-2.0** | Vue3 + **Vant**（与本项目同族），搬业务模型不搬 Go 代码 |
| PDF 解析（**无附加条款**） | `opendataloader-project/opendataloader-pdf` | 29.5k | 2026-10-07 | **Apache-2.0** | MinerU 的干净替代，无阈值、无署名义务 |
| PDF CLI（**替 PyMuPDF**） | `pdfcpu/pdfcpu` | 8.9k | 2026-10-04 | **Apache-2.0** | 合并/拆分/压缩/书签。同"子进程调 CLI"形态但无 AGPL 传染 |
| 离线 OCR + 去水印 | `hiroi-sora/Umi-OCR` | 47.7k | 2025-11 | **MIT** | "排除水印/页眉页脚"是现有 `ocr_image` 缺的能力 |
| 敏感词分级标签 | `houbb/sensitive-word` | 6.1k | 2026-03 | **Apache-2.0** | 取它的词库标签分类分级喂 `moderation` |
| PPTX 模板导入 + 风格目录 | `arcsin1/oh-my-ppt` | 2.1k | 2026-09-29 | **Apache-2.0** | 补"生成后要改"的闭环；90+ 风格 skill 的组织方式 |
| 整页出图式 PPT | `ningzimu/codex-ppt-skill` | 6.4k | 2026-10-02 | **MIT** | 与"可编辑 pptx"相反的路线，适合"高颜值不再编辑"的可选档位 |
| 多端订单模型 | `siam1026/siam-cloud` | 342 | 2026-06 | **Apache-2.0** | 用户/商家/配送/总后台四端权限与订单流转 |
| 校园小程序 IA（**停更**） | `mohuishou/scuplus-wechat` | 691 | 2020-06 | **无 LICENSE** | 40+ 页面校园 IA 最全范本；只看页面划分，代码不可用 |
| 打字典交互（**GPL**） | `RealKai42/qwerty-learner` | 23.3k | 2026-09-08 | GPL-3.0 | 听写/拼写练习闭环交互范本，不进 `apps/` |

### 数据源结论（词书方向）

- `Ceelog/DictionaryByGPT4`（6.4k★，**CC-BY-SA-4.0**）：字段设计可借（词义/例句/词根词缀/变形/文化背景/记忆技巧），**数据不搬** —— ShareAlike 会传染衍生词库。
- `kajweb/dict`（3.7k★，**无 LICENSE**，2024-04 停更）：**法律上不可用**，只当覆盖率对照表，核对 `books.json` 是否漏了常见大纲。

详细许可档位登记见 `docs/compliance/OPEN_SOURCE_LICENSES.md` §七之三。
