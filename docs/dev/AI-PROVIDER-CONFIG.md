# AI 能力配置方案（双模型分工版）

> 状态：**权威配置文档**。A 组配置已实际启用；实施路线见第九节（含各项最新状态）。
> 创建：2026-09-17 ｜ 定版更新：2026-09-19
> 配套：`docs/dev/ENV.md`（全量环境变量）、`docs/dev/CONFIG-GAPS.md`（配置缺口活清单）
> 本文档已于 2026-09-19 并入原 `docs/dev/MULTI-MODEL-PROVIDER-PLAN.md`（多模型分层接入方案）
> 的独有内容（三层卡点分析、P0~P3 实施路线），该文件已移至 `docs/dev/archive/` 留档。
> 红线：新增/修改环境变量必须**三处同步** —— `.env.example`、`apps/api/src/common/config/env.schema.ts`、`docs/dev/ENV.md`。`.env` 严禁入库。

## 一、核心思路：文本与多模态分离，只用两家平台

本项目只用**两家**模型服务商，**共两个 API Key**：

| 服务商 | 承担能力 | Key |
|---|---|---|
| **智谱 BigModel** | 全部文本生成（LLM） | 1 个 |
| **硅基流动 SiliconFlow** | 多模态 / OCR / 文档解析 / 语音 | **1 个（全部能力共用）** |

| 层 | 模型 | 平台 | 理由 |
|---|---|---|---|
| **文本** | **`glm-4.5-air`**（当前实配，09-18 切回智谱走资源包额度；选型演进 GLM-5.3-Flash → DeepSeek-V4-Flash → 现配，见 2.2） | 智谱 | flash 系轻量档，短请求实测与硅基 DeepSeek-V4-Flash 相当 |
| **多模态** | **Qwen3.5-4B** | 硅基流动 | 4B 但**原生支持视觉输入**，256K 上下文，**限免** |

两者走**不同 Provider 槽位**，互不干扰。GLM-5.3-Flash 是纯文本模型，看不了图；
Qwen3.5-4B 文本能力弱于 GLM，但能"看图"。各用所长。

> ⚠️ **关键约束**：`OpenAiCompatibleLlmProvider` 的 `content` 是 `string`，
> **无法表达图像的多段 content**（`image_url` / base64）。
> 所以 Qwen3.5-4B **不能**填进 `LLM_BASE_URL`，必须走独立的 `ocr` 槽位 + 新 Provider。

---

## 二、分层配置总表

| 能力 | Provider 槽位 | 选型 | 是否需模型 | 成本 |
|---|---|---|---|---|
| 大纲 / 总结 / 解题 / 翻译 / 导图 / 简版 | `llm` | `glm-4.5-air`（当前实配，定版见 2.2） | 需要 | 资源包额度 |
| OCR 文字识别 | `ocr` | `deepseek-ai/DeepSeek-OCR`〔硅基〕✅**已接入** | 需要 | 限免 |
| 图片理解 | `ocr` | `Qwen/Qwen3.5-4B`〔硅基〕（需设 `VLM_ENABLE_THINKING=false`） | 需要 | 限免 |
| 文档 / 论文解析 | `docParse` | `PaddlePaddle/PaddleOCR-VL-1.5`〔硅基〕（长文档）<br>`deepseek-ai/DeepSeek-OCR`〔硅基〕（OCR 专项） | 需要 | 限免 |
| 语音转文字 | `audio.speechToText` | `Qwen/Qwen3-ASR-1.7B`〔硅基〕✅**已接入**<br>`FunAudioLLM/SenseVoiceSmall`〔硅基〕⚠️慢 60s+ | 需要 | 限免 |
| 人声 / 伴奏分离 | `audio.separateVocals` | Demucs `htdemucs`（`services/ai` 的 `/ai/separation`）✅**已接入** | 仅首次（下载权重） | 自部署 ¥0 |
| 抠图 | `image.removeBackground` | rembg（u2net 白名单） | 需要 | 自部署 ¥0 |
| **视频**压缩/转码/裁剪/烧字幕 | `video` | **FFmpeg**（LGPL，子进程调用） | **不需要** | ¥0 |
| **音频**转格式/降噪 | `audio` | **FFmpeg** | **不需要** | ¥0 |
| 图片压缩/转格式/增强 | `image` | Sharp（已真实可用） | **不需要** | ¥0 |
| PPT 渲染 | `ppt` | PptxGenJS（已真实可用） | 不需要 | ¥0 |
| 语义检索（RAG，未来） | `embedding` | BAAI/bge-m3 | 需要 | 免费 |

> **音视频那 7 项不需要模型**——缺的是 FFmpeg 子进程包装层，不是"便宜的视频模型"。

### 2.1 实测校准表（2026-09-17，逐项真打接口）

选型**以实测为准**，不照抄任何"推荐配置"表 —— 网上流传的表里，模型名、
免费状态、耗时经常与真实情况不符。下面每一行都跑过。

| 功能 | 模型 | 实测结论 | 能不能直接用 |
|---|---|---|---|
| 文本生成 / 深度思考 | `glm-4.7-flash`（智谱） | 官方**免费**；但高峰期 **5 次里 4 次 `429 + code 1305` 过载**，成功那次 **17~42s**（223 token 里 220 是推理）。`reasoning_effort=low` 对它**几乎无效** | ⚠️ **必须配 `LLM_FALLBACK_MODELS`**，否则等于不可用 |
| 意图识别 / 分类 | 同上，或 `glm-4-flash` | `glm-4-flash`：3/3 成功、**0.63~1.3s、无推理开销**（但不在官方免费清单里） | 分类任务不必用推理模型，省 token 也省延迟 |
| 图片文字识别 | `deepseek-ai/DeepSeek-OCR`（硅基） | **~300ms**，输出干净无标记，连打多次无抖动 | ✅ 已在用 |
| 语音转文字 | `Qwen/Qwen3-ASR-1.7B`（硅基） | **~100ms**；⚠️ 端点与文本不同（`/audio/transcriptions`）、`language` 是白名单 | ✅ 已在用 |
| 视觉理解 | `glm-4.6v-flash`（智谱） | 官方**免费**，识别准确（实测"珊瑚红"正确）；但 **5 次里 2 次过载**、7.8s，且**是推理型：`max_tokens < 800` 会返回空内容** | ⚠️ 需降级 + 给足 token 预算 |
| 向量化 | `BAAI/bge-m3`（硅基） | ✅ 实测可用：**1024 维、146ms** | ✅ **已接**：RAG 灌库与检索（M4-06），见下 |
| 重排序 | `BAAI/bge-reranker-v2-m3`（硅基） | ✅ 实测可用：相关度打分正确（"视频压缩"0.979 排第一） | ⛔ **暂不接**：粗排够用，rerank 是可选优化，见下 |
| 文生图 | `cogview-3-flash`（智谱） | 官方**免费**，实测 12.7s 正常返回图片 URL | ⛔ 项目里**没有"文生图"这个工具**，属新增功能而非改配置 |
| 文生视频 | `cogvideox-flash`（智谱） | 官方文档在 `/models/free/` 目录下 | ⛔ **不建议现在做**，理由见下 |
| 内容审核 | ~~`glm-4.7-flash` + 提示词~~ | **不合规，见下** | ⛔ 必须走微信内容安全 API |

> ✅ **向量化：已接上（2026-09-18）**
> 消费方是 `KnowledgeModule`（M4-06 校园知识库）：灌库时"切片 → `embed` → 写向量库"，
> 检索时"query → `embed` → 相似度检索 → 带引用回答"。
> 向量库按任务清单原文选了 **Qdrant**（MySQL 无向量能力），
> 配置项见 `docs/dev/ENV.md` 的 10c，决策记录见 `docs/architecture/DECISIONS.md`。
> 端到端验证：`npm run verify:rag`（真实模型 + 真实 Qdrant，含"检索不到就不硬答"）。
>
> ⛔ **重排序为什么仍然先别接**：
> 粗排（向量检索）已经把正确文档排到第一 —— 实测问「校园卡丢了怎么补办」，
> 目标文档得分 **0.7963**，且无关问题被阈值拦到 **0 条**。
> rerank 只在"正确项没进前 K"时才有价值，而那个场景需要真实语料量上来才有判据；
> 现在接就是又一段**没有验收标准的死代码**。

> ⛔ **内容审核为什么不能用"LLM + 提示词"**：
> 项目自己的设计文档已经定了方案 ——
> `docs/product/青智校园_小程序详细设计文档_V2.md` 6.7.1 与
> `docs/product/青智校园_开发任务清单.md` M4-05 都写明：
> **`ModerationProvider` = 微信内容安全 API（文本 `msgSecCheck` / 图片 `mediaCheckAsync`）+ 自建词库**，
> 且"所有 UGC 必经"、"红线，不能省"。
> 理由有三：① 微信小程序对 UGC 有**强制审核要求**，用第三方模型审核**过不了审**；
> ② LLM 审核漏判率高、可被提示词注入绕过；③ 判罚结果不可追溯、无法申诉。
> LLM 最多做**辅助**（如涉版权文本的语义判断），不能替代平台审核。

> ⛔ **文生视频为什么建议先不做**：
> ① 视频生成是**异步任务**（提交 → 轮询），与现有同步工具链路完全不同，
> 需要任务状态机 + 回调 + 超时处理；
> ② 产物是**大文件**，需要对象存储、CDN、小程序端播放与流量成本；
> ③ 免费档的**时长/分辨率/并发限制文档没写清**，而视频生成是最容易被限流的一类；
> ④ 收益最低：校园场景的真实需求集中在文档/图片/音视频**处理**（FFmpeg 那 6 项），
> 不是"凭空生成视频"。
> 相比之下 FFmpeg 包装层**零成本点亮 6 项功能**，性价比高得多 —— 应先做那个。

### 2.2 本项目定版配置表（照这张配）

综合实测与"项目里到底有没有消费方"，定版如下。**分三组看**：
现在就能用的 / 要先做功能才能用的 / 明确不做的。

#### A 组：现在就该用的（已配置或只需改配置）

> **当前实配以 `.env` 为准**：文本主力 `glm-4.5-air`（账号有资源包额度：
> 企微 1000 万 + 新用户 1200 万 token），降级链 `glm-4.7-flash`（智谱**永久免费**档，
> 同端点同 Key；⚠️ **时段性可用**，见 2.2 节末）。
> 硅基流动 `DeepSeek-V4-Flash` 是已实测定版的**备用方案**，写在 `.env` 底部"备用 A"，
> 智谱额度用尽/到期或智谱故障时切回。

| 槽位 | 模型 | 服务商 | 成本 | 实测依据 | 状态 |
|---|---|---|---|---|---|
| **全部三档（意图 / 生成 / 规划）** | `glm-4.5-air` | 智谱 | 资源包额度（企微 1000 万 + 新用户 1200 万 token） | 09-18 智谱端点实测：带 `reasoning_effort=low` 不 400、content 干净；短请求与硅基 DeepSeek-V4-Flash 相当，完整三节大纲 8.4s | ✅ **当前实配（`.env`）** |
| 降级链（所有档位共用） | `glm-4.7-flash` | 智谱 | **永久免费** | 09-19 实测 10 次连打 **8/10 成功**（1.1~2.9s）；⚠️ **时段性可用** —— 同一小时内另一批 2/2 全 429 | ✅ 保留（见 2.2 节末） |
| 文本备选（备用 A） | `deepseek-ai/DeepSeek-V4-Flash` | 硅基流动 | 入 **¥1** / 出 **¥2** | **意图 5/5、对话诚实不编造、大纲 437 字 5 子项**，2.1s | ✅ 已实测定版，现作备用 |
| 图片文字识别 | `deepseek-ai/DeepSeek-OCR` | 硅基流动 | 免费 | **~300ms**，输出干净、无抖动 | ✅ 已在用 |
| 语音转文字 | `Qwen/Qwen3-ASR-1.7B` | 硅基流动 | 免费 | **~100ms** | ✅ 已在用 |
| 图片压缩/转格式/增强 | Sharp | 本地 | ¥0 | 8~21ms | ✅ 已在用 |
| PPT 渲染 | PptxGenJS | 本地 | ¥0 | 74KB 合法 pptx | ✅ 已在用 |

**被淘汰的候选**（2026-09-18 实测，同一批用例：意图 5 条 + 对话 1 条 + 大纲 1 条）：

| 模型 | 意图识别 | 对话回复 | 大纲产物 | 价格(入/出) | 耗时 | 淘汰原因 |
|---|---|---|---|---|---|---|
| `deepseek-ai/DeepSeek-V3` | 5/5 ✅ | ✅ 诚实 | ⚠️ 251 字 | ¥2/¥8 | 6.3s | **质量合格**，原定降级位；因降级链暂时留空而未启用，**是最优先的候选** |
| `deepseek-ai/DeepSeek-V3.2` | 4/5 ⚠️ | ❌ **编造功能** | ⚠️ 282 字 | ¥2/¥3 | 5.7s | 实测答"AI PPT 生成**可以**根据你的 PPT 内容自动生成配套演讲稿" —— 平台没这功能。与 `glm-4-flash` 同类问题，**编造比贵严重** |
| `stepfun-ai/Step-3.5-Flash` | **0/5** ❌ | ✅ 诚实 | ✅ 752 字 | ¥0.7/¥2.1 | — | 最便宜，但**不支持 JSON mode**（`code 20024`）→ 意图档全挂。**"便宜"必须先过"功能用得上"这一关** |
| `Qwen/Qwen3.5-9B` | **0/5** ❌ | 超时 | 超时 | — | — | 连消息协议都不兼容（`System message must be at the beginning`，400） |
| `glm-4.7-flash`（智谱） | **1/5** ❌ | ✅ 正确 | ❌ **0 字** | 免费 | 35~67s | 推理型：`max_tokens` 被推理吃光，4/5 返回空 content（HTTP 500 / code 50043） |
| `glm-4-flash`（智谱） | 5/5 ✅ | ❌ **编造链接** | ❌ 194~248 字 | 便宜 | 1~9s | 实测给出 `www.qingzhi.com/ai/ppt` 这类不存在的地址，违反系统提示词第 4 条。**且硅基流动上没有这个模型名，无法用于当前服务商** |
| `glm-5.3-flash`（智谱） | 5/5 ✅ | ✅ 最好 | ✅ 707 字 5 级 | ¥0.8/¥2.8 | 2~13s | **质量合格，仅因单价略高且硅基有余额而换掉**（差距很小，随时可切回） |
| `Qwen2.5-7B` / `Qwen3-8B`（硅基） | 4/5、5/5 | ⚠️/空 | 190 字 | — | 25~69s | 太慢，不采用 |

> ⭐ **选型教训：不能只看价格。** 本项目两次实测都印证同一条 ——
> 便宜但**编造功能**的模型（`glm-4-flash`、`DeepSeek-V3.2`）比贵的更糟，
> 而更便宜的 `Step-3.5-Flash` 直接**不支持这项功能所需的参数**。
> 正确顺序是：**先过"功能可用"（协议/参数/不编造）→ 再比价格**。

### ⚠️ 降级链：为什么曾刻意留空、09-18 之后为何重新启用

**历史（主模型在硅基流动时）**：`LLM_FALLBACK_MODELS` 曾**刻意留空**，不是遗漏。原因是**降级链只能在同一个服务商内换模型名**：

```js
// apps/api/src/infra/providers/llm/openai-compatible.provider.ts
return [primary, ...this.cfg.fallbackModels.filter((m) => m !== primary)];
```

所有尝试共用同一个 `baseUrl` + `apiKey`。而当时想用来兜底的 `glm-4-flash`
**只存在于智谱**，硅基流动上没有（实测其 GLM 系列只有 `zai-org/GLM-5.3`、
`zai-org/GLM-4.5-Air`、`THUDM/GLM-4-9B-0414` 等 8 个，`glm-4-flash` /
`glm-4.7-flash` / `glm-5.3-flash` **全部不存在**）。填进去轮到它时只会 404 —— **假兜底**。

**当时的兜底手段**：
1. `LLM_MAX_RETRY=3` 的重试（退避 1s/4s/16s）—— 扛瞬时抖动；
2. 客户端 `pages/os/index.ts` 的 `intentFallbackText(intent)` —— 后端完全拿不到回复时，
   按意图给一句诚实的话（本地规则，不依赖网络）。

> ⚠️ **服务商级故障同服务商降级救不了**：2026-09-18 硅基流动的 `/audio/transcriptions`
> 就整体不可用过（同 Key 的 `/models` 与 `/chat/completions` 正常，只有语音端点挂）。
> 当日 11:55 复测恢复（`verify:tools` 9/9、`speech_to_text` 122ms），属服务侧故障、非本项目问题，
> 无需改代码。**教训保留**：这类故障按服务商维度整体失效，只能用「跨服务商降级」兜。
> 若将来切回硅基流动做主模型，当时登记的首选降级位是 `deepseek-ai/DeepSeek-V3`
> （同服务商、实测诚实不编造、意图 5/5，¥2/¥8）。

**现状（09-19 复测后，`.env` 实配）：降级链保留 `glm-4.7-flash`。**

09-18 启用它（同服务商永久免费档）。09-19 复测时先测到 **2/2 全部 429**，
一度判定"降级链形同虚设"并打算留空；**但加大样本后结论反转**：

| 候选 | 免费 | 可用性（09-19 多批次实测） | 诚实性 | 结论 |
|---|---|---|---|---|
| `glm-4.7-flash` | ✅ | ⚠️ **时段性**：10 次连打 **8/10 成功**（1.1~2.9s）；同一小时内另一批 **2/2 全 429** | ✅（未发现编造） | ✅ **保留** |
| `glm-4.5-flash` | ✅ | ❌ 55~67s，且出现过 `content` 为 0 字 | — | 不可用 |
| `glm-4-flash` | ✅ | ✅ 6/6（短任务 461~666ms / 中任务 22~29s） | ❌ **编造不存在的链接** | 不合规 |
| `glm-5.3-flash` | ❌ | ❌ `code 1113 余额不足或无可用资源包` | ✅（09-18 实测质量合格） | 账号用不了 |

⭐⭐ **两条教训，都值得记牢**：

1. **验证一个模型要同时看「可用性」和「诚实性」。** 只测"能不能返回内容"会漏掉
   `glm-4-flash` 这种"返回得很漂亮但在编造"的模型 —— 本项目已有先例（`DeepSeek-V3.2`
   编造"AI PPT 自动生成演讲稿"）。选型第一关永远是**不编造**，不是快慢或价格。
2. **别用一两次失败判定"不可用"—— 尤其对"时段性"的东西。** `glm-4.7-flash` 的过载率
   随高峰波动；2 个样本全 429 时我差点把它判死刑（改成留空 = 兜底率从 80% 直接归零）。
   **降级链的价值是"80% 能兜住"，不是"100% 能兜住"。** 要下结论就得多时段采样。

⛔ 换成 `glm-4-flash` 是**错的**（可用率更高但会编造）；留空也是**错的**（把 80% 兜底率扔掉）。
✅ 当前保留 `glm-4.7-flash`。
✅ 更好的候选：给智谱充值后切 `glm-5.3-flash`（09-18 实测质量合格、2~13s）；
或实现「跨服务商降级」（给降级位配独立的 `LLM_FALLBACK_BASE_URL` / `LLM_FALLBACK_API_KEY`，
用硅基流动的 `DeepSeek-V4-Flash`）—— **尚未实现**，见交付可用性报告 P1-3 待办。

🛡️ 这个漏洞此前**无人拦截**，因为 `verify:llm` 的第③节只验"该不该换、会不会换"（机制），
单测验的是"换的动作"—— **没有任何一项验证"换过去的那个模型自己能不能用"**。
09-19 已补上 `probeFallbackModels()`：对降级链上**每个模型**各打一次真实请求，失败即红。

⚠️ 另修掉一个**会让排查得出错误结论**的问题：`verify-llm.mjs` 原先硬编码读
`apps/api/.env`，而那是 `setup-env.mjs` 从根 `.env` 复制出的**生成物** ——
改了根 `.env` 后脚本仍读旧值，**看起来权威、实际过期**。现已改为按
`paths.ts` 的优先级读**仓库根 `.env`**（与后端一致）。

对应的 `.env`（**三处同步**：`.env` / `.env.example` / 本文件；以下为当前实配）：

```bash
# ---------- 智谱（文本 LLM，走资源包额度） ----------
LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
LLM_API_KEY=<智谱 Key>
LLM_MODEL_INTENT=glm-4.5-air        # 三档统一
LLM_MODEL_GENERATE=glm-4.5-air
LLM_MODEL_PLAN=glm-4.5-air
LLM_FALLBACK_MODELS=glm-4.7-flash   # 同服务商永久免费档（时段性可用，见上节实测）
LLM_REASONING_EFFORT=low            # ⚠️ 智谱只认 low/high/max，传 medium 会 400

# ---------- 硅基流动（OCR / 语音，与文本已不同家） ----------
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
SILICONFLOW_API_KEY=<硅基流动 Key>
VLM_MODEL=deepseek-ai/DeepSeek-OCR
ASR_MODEL=Qwen/Qwen3-ASR-1.7B
```

> **成本实测量级**（本项目真实用量：平均输入 ~473 token、输出 149 token / 次对话）：
> 按硅基 `DeepSeek-V4-Flash` 单价算单次对话 ≈ **0.0008 元（0.08 分）** →
> **1000 次 ≈ 0.8 元、10000 次 ≈ 8 元**（充 ¥16 约可支撑 2 万次对话）——该量级按备用方案计价，
> 供切回硅基流动时参考；**当前文本消耗智谱资源包额度，降级档 `glm-4.7-flash` 永久免费**。
> 这个量级下"为省几分钱牺牲质量"是不划算的。
>
> **切到备用 A（硅基流动 DeepSeek-V4-Flash）**：`.env` 底部已备好注释块，取消注释并注释掉
> 智谱那几行即可。⚠️ 切过去时**必须清空 `LLM_REASONING_EFFORT`** ——
> 硅基的 DeepSeek 带该参数会在短输出时泄漏 `</think>` 并重复内容（见 3.2 实测）。
> 注意 `zai-org/GLM-5.3` 在硅基流动也有，但 ¥8/¥28，比智谱官方贵得多。
>
> **备用 B（智谱永久免费档，不耗资源包）**：三档改 `glm-4.7-flash`。
> ⚠️ 它是**时段性可用**（09-19 实测 10 次连打 8/10 成功，同一小时内另一批 2/2 全 429），
> 且推理型 `max_tokens` 被吃光时可能返回空 content（见「被淘汰的候选」表）——
> 只适合额度告急时临时顶一下，**别当长期方案**。

#### B 组：要先做功能才有消费方（按性价比排序）

| 功能 | 模型 | 服务商 | 要做什么才能用 |
|---|---|---|---|
| **音视频处理 6 项**（压缩/转码/裁剪、音频转换、人声分离、降噪） | **FFmpeg**（不是模型） | 本地 | ① 装 **LGPL 构建**的 ffmpeg ② 写子进程包装层 ③ 注册 6 个工具。**零 API 成本，性价比最高** |
| **文生图** | `cogview-3-flash` | 智谱 | 项目里**没有"文生图"工具**（现有 `generate_image_prompt` 只出提示词）。需：新工具 + seed 注册 + Provider + 页面 |
| **图片理解**（非纯 OCR） | `glm-4.6v-flash` | 智谱 | 同样没有对应工具。⚠️ 是推理型，`maxTokens ≥ 800` 否则返回空 |
| **校园知识库 RAG** | `BAAI/bge-m3` + `bge-reranker-v2-m3` | 免费 | **向量化 Provider 已接**（`mock-embedding` 已摘掉，实测 1024 维 / 111ms）；但检索链路未做：需切片入库 + 外接向量库 + 检索 + 带引用回答。⚠️ 文档在"Qdrant 首选"与"不引入独立向量库"之间**自相矛盾，需先拍板** |

#### C 组：明确不做（附理由）

| 功能 | 候选 | 为什么不做 |
|---|---|---|
| 内容审核 | ~~`glm-4.7-flash` + 提示词~~ | **不合规**。项目设计文档 6.7.1 / M4-05 已定：必须用**微信内容安全 API**（`msgSecCheck` / `mediaCheckAsync`）+ 自建词库，所有 UGC 必经、"红线不能省"。用第三方 LLM 审核过不了微信审核、可被提示词注入绕过、判罚不可追溯 |
| 文生视频 | `cogvideox-flash` | 官方免费，但：① 异步任务链路（提交+轮询），与现有同步工具完全不同；② 产物是大文件，需存储+CDN+播放与流量成本；③ 免费档时长/分辨率/并发限制文档未写明；④ 收益最低 —— 校园真实需求在"**处理**"而非"凭空生成" |

---

## 三、环境变量配置

### 3.1 文本主力 —— 分档配置（**已接入，当前实配为智谱**）

> 选型依据（为什么三档统一、为什么淘汰其他候选）见上文「A 组」表格与「被淘汰的候选」表格，
> 此处只给与 `.env` 当前实配一致的、可直接抄的配置。

```bash
LLM_DRIVER=openai-compatible
LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
LLM_API_KEY=<你的智谱 Key>
LLM_MODEL_INTENT=glm-4.5-air        # 三档统一（走资源包额度）
LLM_MODEL_GENERATE=glm-4.5-air
LLM_MODEL_PLAN=glm-4.5-air
LLM_FALLBACK_MODELS=glm-4.7-flash   # 同服务商永久免费档（时段性可用，见 2.2「降级链」一节）
LLM_TIMEOUT_MS=30000
LLM_MAX_RETRY=3
LLM_TOTAL_BUDGET_MS=45000           # ⚠️ 必须 ≥ LLM_TIMEOUT_MS，启动期断言
# ⚠️ 必设，且**作用于所有档位**（Provider 级，不区分模型）。
# 实测对推理型模型是决定性的：不传时对话烧 1500 字推理 / 6.9s，
# 大纲烧 3115 字 / 24.8s；设 low 后推理降到 0 字、对话 2.3s、大纲 6.4s。
# ⚠️ 智谱只认 low / high / max —— 传 medium 会被 400 拒绝
# ⚠️ 切回硅基流动 DeepSeek 时必须清空本行（会泄漏 </think>，见 2.2 备用 A 说明）
LLM_REASONING_EFFORT=low
```

> **降级链的机制**：现有实现只能在同一服务商内换模型名
> （`return [primary, ...fallbackModels]`，共用 baseUrl + Key）。
> ⚠️ **保留 `glm-4.7-flash`，但要知道它是"时段性可用"**（09-19 实测：10 次连打 8/10 成功，
> 同一小时内另一批 2/2 全 429，见 2.2 节末）。注意
> "配了个同服务商的模型名"**不等于**"降级 100% 有效"：它大部分时段能兜住，
> 但高峰期会跟着一起过载 —— 降级链的价值是"**80% 能兜住**"，不是"100%"。
> 历史上在硅基流动做主模型时曾**刻意留空**（想用的 glm-4-flash 硅基没有，
> 填进去只会 404 = **真·假兜底**，与"时段性可用"是两回事）。
> 防服务商级故障需要「跨服务商降级」，尚未实现。
>
> 降级只在**可重试**失败（429 / 5xx / 网络）上发生；确定性失败（400，如模型名写错、
> 参数不支持）直接抛出 —— 换了也一样失败，多打一次只是浪费一次往返。

### 3.2 其余全部能力 —— 硅基流动 SiliconFlow（**共用同一个 Key**）

除智谱外，Qwen3.5-4B / PaddleOCR-VL-1.5 / DeepSeek-OCR / Qwen3-ASR 全部托管在
**硅基流动**。因此**只需配一次端点与 Key**，各槽位复用、只换 model 名。

```bash
# —— 硅基流动统一凭证（所有非智谱能力共用，国内站）——
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
SILICONFLOW_API_KEY=<你的硅基流动 Key>

# —— 各槽位只换 model 名 ——
VLM_MODEL=deepseek-ai/DeepSeek-OCR           # OCR / 图片理解（默认）
VLM_ENABLE_THINKING=                         # 留空=不发送，见下方告警
ASR_MODEL=Qwen/Qwen3-ASR-1.7B                # 语音转文字
```

> **国内站用户**：端点固定 `https://api.siliconflow.cn/v1`，对应控制台 `https://cloud.siliconflow.cn`。
> 如未来切换到国际站，把 `cn` 换成 `com` 即可。
>
> **模型名必须带组织前缀**（SiliconFlow 沿 HuggingFace 风格）：
> `Qwen/Qwen3.5-4B`、`PaddlePaddle/PaddleOCR-VL-1.5`、`deepseek-ai/DeepSeek-OCR`、
> `Qwen/Qwen3-ASR-1.7B`、`FunAudioLLM/SenseVoiceSmall`。写成 `qwen3.5-4b` 会 404。

#### 各能力说明（已实测）

| 槽位 | model | 用途 | 实测耗时 | 备注 |
|---|---|---|---|---|
| `ocr` | `deepseek-ai/DeepSeek-OCR` | 纯文字提取 | **1.3s** | 输出最干净，无标记 —— **默认** |
| `ocr`（备选） | `PaddlePaddle/PaddleOCR-VL-1.5` | 需版面坐标时 | 2.1s | 输出含 `<\|LOC_x\|>` 归一化坐标，可还原文字位置 |
| `ocr`（备选） | `Qwen/Qwen3.5-4B` | 图片**理解**（非纯 OCR） | 5.2s → 0.5s | 4B，原生视觉，256K 上下文；**必须设 `VLM_ENABLE_THINKING=false`** |
| `audio.speechToText` | `Qwen/Qwen3-ASR-1.7B` | 语音转文字 | **0.5s** | 52 语言 |
| `audio.speechToText`（备选） | `FunAudioLLM/SenseVoiceSmall` | 语音转文字 | 61.3s ⚠️ | 能通但明显过慢，不建议用于交互场景 |
| `docParse` | 复用 `VLM_MODEL` | 长文档 / 论文 | — | 未单开变量；实现时若需独立模型再新增 `DOCPARSE_MODEL` |

> ✅ **语音端点已实测确认**：ASR 走 `POST {BASE}/audio/transcriptions`（multipart，
> OpenAI Whisper 风格），**不是** `/chat/completions` —— 后者会返回
> `400 code 20012 Model does not exist`。

> ⚠️ **该端点不提供时间戳**（实测）：`response_format` 只认 `json`（默认），
> `verbose_json` / `srt` / `vtt` 一律 400，`timestamp_granularities[]` 被接受但忽略。
> 响应恒为 `{ text, usage }`，所以 `segments` 只能是空数组（不伪造时间轴）。
> 需要逐句时间戳（字幕烧录等）必须换方案：自部署 faster-whisper 或支持
> `verbose_json` 的服务。`usage.seconds` 会给出音频时长，目前未使用。

> ⚠️ **`language` 是白名单参数，必须归一化后再发**：实测只认 ISO 639-1 两字母码
> （`zh` `en` `ja` `ko` `fr` `de` `es` `ru` `pt` `it` `ar` `yue` `vi` `th` `id` `ms`
> `tr` `pl` `nl` `hi`）。`zh-CN`（带地区后缀）、`auto`、`中文`、`xx`（表外的码）
> **全部 400**。⚠️ 小程序界面的语言选项含「自动识别」→ 值为 `auto`，
> 原样透传会让该选项 100% 失败 —— 已在 `normalizeAsrLanguage` 里映射为
> **不发送参数**（服务端即自动识别），带地区后缀的截到主语言，未知取值同样降级为自动识别。

> ⚠️ **`enable_thinking` 只能按需发送**：`deepseek-ai/DeepSeek-OCR` 收到该参数直接
> `400 code 20015 ... does not support parameter enable_thinking`。所以 `VLM_ENABLE_THINKING`
> 默认留空＝不发送，对任何模型都安全；只有换成 Qwen3.5 / Qwen3-VL 等**混合思考模型**
> 时才设 `false`（否则会先"思考"，token 209 → 1、耗时 5.2s → 0.5s）。
> 注意 `reasoning_effort` 对 Qwen 系几乎无效（实测 207 → 197），不能用它替代。

> ⚠️ **`reasoning_effort` 的收益是「模型特定」的，不要当成通用提速手段。**
> 网上与本项目早期记录里"不传 vs `low` 差 4 倍"（大纲 24.8s → 6.4s）是
> **智谱 GLM** 上的实测；换成硅基流动的 `deepseek-ai/DeepSeek-V4-Flash` 后复测：
>
> | 配置 | 实测耗时 |
> |---|---|
> | 带 `low` | 65132 / 9503 / 7166 ms |
> | 不带 | 54731 / 8105 ms |
>
> **无显著差异**，且带参数时短输出出现过 `</think>` 残留（`可以</think>可以`）。
> 所以：
> 1. 判断"某模型太慢"时，**先确认这个参数调没调**，但不要指望它一定有效；
> 2. 真正能兜住延迟的是**总时间预算** `LLM_TOTAL_BUDGET_MS`（见 `docs/dev/ENV.md`），
>    它不依赖任何模型特性，是硬上限；
> 3. 换服务商时**必须重测**这个参数 —— 取值白名单与效果都可能不同
>    （智谱只认 `low`/`high`/`max`，传 `medium` 直接 400）。
>
> ⚠️ **同一模型下，它的效果还随「任务复杂度」递减**（09-19 实测，智谱 `glm-4.5-air`）：
>
> | 任务 | `low` 下的 reasoning | 结论 |
> |---|---|---|
> | 极简（"只回复两个字：可以"） | 3 token / 0.99s | ✅ 压得住 |
> | 大纲生成 | 0 字推理 / 6.4s | ✅ 压得住 |
> | **思维导图**（双产物 + 结构化语法） | **1595~4644 字，占 token 的 60~75%** | ❌ **压不住** |
>
> 思维导图因此耗时 23.6~31.1s，**恰好在 30s 单次超时线上反复横跳**（表现为"时通时不通"）。
> 这类场景要靠 **`LLM_DISABLE_THINKING`**（显式 `thinking:{type:'disabled'}`，见 `ENV.md`）——
> 实测 reasoning 归零、耗时 **3.6s**、`completion_tokens` 2016 → 314。
> **凡是"输出结构固定、不需要推理"的重生成工具，都应显式关思考**（`LlmCallOptions.disableThinking`）。

> 也可继续走自部署 faster-whisper（`WHISPER_MODEL=small`），无需 API。

### 3.5 本地媒体与 AI 侧车（已有变量，保持不变）

```bash
AI_SERVICE_URL=http://localhost:8000      # services/ai
MEDIA_SERVICE_URL=http://localhost:8001   # services/media（FFmpeg）
FFMPEG_BIN=ffmpeg                          # 必须 LGPL 构建
FFPROBE_BIN=ffprobe
REMBG_MODEL=u2net                          # 白名单模型
WHISPER_MODEL=small
VOCAL_SEPARATION_ENGINE=demucs             # ⚠️ 上游已归档，见风险节
GPU_CONCURRENCY=1
```

---

## 四、装配逻辑（红线 9）

所有新增 Provider 遵循**同一装配模式**——**配了凭证才启用，没配自动回退 Mock 并打标**：

```ts
// real-provider.factory.ts 中的模式（llm 已是此写法）
if (cfg.llm.enabled) {
  overrides.llm = new OpenAiCompatibleLlmProvider(cfg.llm);
}
// ocr / docParse / asr 同样处理
```

未配置时 `MockMarkerMiddleware` 自动打：

```
X-Provider: mock
X-Mock-Providers: mock-ocr,mock-video,mock-audio,...
```

前端据此显示"演示模式"角标。**绝不允许静默返回假数据**（红线 10）。

---

## 五、成本汇总

| 阶段 | 点亮能力 | 月成本 |
|---|---|---|
| 配文本主力（当前智谱 `glm-4.5-air`，降级 `glm-4.7-flash` 免费档） | 大纲/总结/解题/翻译/导图/PPT | **资源包额度内 ¥0** |
| 接 FFmpeg | 视频 4 项 + 音频 2 项 | **¥0** |
| 接 Qwen3.5-4B | OCR / 图片理解 | ¥0（限免期内） |
| 接 PaddleOCR-VL-1.5 | 文档/论文解析 | ¥0（限免期内） |
| 接 Qwen3-ASR | 语音转文字 | ¥0（限免期内） |

**"免费"不等于"永久免费"** —— 带"限免"标签的模型会恢复收费；L0 限速档位
（如 RPM 1000 / TPM 80,000）在生产流量下可能不够，需评估升档成本。
建议监控用量，限免结束前完成成本重估。

---

## 六、推荐接入顺序（截至 2026-09-17 的实际状态）

**已完成**：文本 4 项（GLM）、OCR（DeepSeek-OCR）、语音转文字（Qwen3-ASR）、
图片 3 项（Sharp）、PPT 渲染（PptxGenJS）、AI 助手（`/os` 意图识别 + 对话）。
—— 即 **`active` 工具全部真能跑**（`npm run verify:tools` 可复验）。
⚠️ `active` 的**条数会随实现推进变化**（截至 2026-09-19 已是 26 个），
**不要在这里写死数字** —— 实时值看 `npm run check:tools` 的输出。

**接下来按这个顺序做**：

| 顺序 | 事项 | 为什么排这个位置 |
|---|---|---|
| 1 | **装 LGPL 构建的 FFmpeg + 写子进程包装层** | 零 API 成本点亮 **6 项**音视频功能，是当前最大的能力缺口；⚠️ 本机尚未安装 ffmpeg |
| 2 | ~~把 A 组的两处配置改掉~~ **✅ 已完成（2026-09-18）** | 定版值**只以上文 2.2「A 组」表格为准**（此处曾抄录过一版历史模型名，已删除以防再次漂移） |
| 3 | ~~**内容审核接微信内容安全 API**（M4-05）~~ **✅ 业务接线已完成（2026-09-19）** | 合规红线，上线前不能省。⚠️ **仍未闭环的是"切到 `wechat` 驱动"与"图片审核"** —— 见 `CONFIG-GAPS.md` 三之二 |
| 4 | **文生图工具**（`cogview-3-flash`） | 需新工具 + 页面；比 RAG 简单得多 |
| 5 | **校园知识库 RAG**（M4-06） | 最大的一块：切片入库 + 外接向量库 + 检索 + 引用；先解决"向量库选型"的文档矛盾 |
| — | 文生视频 | **暂不做**，理由见 2.2 的 C 组 |

> 判断顺序的标准只有两条：**能不能立刻点亮真实功能**、**有没有合规/架构上的前置依赖**。
> 不要因为某个模型"免费"就优先接它 —— 没有消费方的 Provider 就是死代码。

---

## 七、风险与红线

1. **红线 10**：Mock 必须可辨。未配凭证的能力必须回退 Mock 并打 `X-Provider: mock`。
2. **红线 9**：未接能力宁可提示"尚未开放"，不产出看起来成功、实际无内容的作业。
3. **GPL 合规**：FFmpeg 必须 LGPL 构建，仅以**子进程 CLI** 调用，不链接 `libav*`；
   LibreOffice / Pandoc / ConvertX 等 GPL 组件禁止装入 `apps/` 或 `services/`。
4. **外部依赖只能走 Provider 接口**：禁止在业务代码里 `new` 第三方 SDK。
5. **Demucs 上游仓库已归档（技术债，但当前可用）**：2026-09-19 实测 `pip install demucs`
   仍能装到 **4.1.0**，权重从 HuggingFace 的 `adefossez/HTDemucs`（约 80MB）拉取 ——
   所以这条链路是通的，落地在 `services/ai/separation.py`。
   ⚠️ 但仓库不再维护，长期需评估 **Spleeter**（MIT，活跃）或商用源分离 API；
   换引擎时只需改 `separation.py` 与 `VOCAL_SEPARATION_ENGINE`，Provider 接口不动。
6. **不要拿 4B 模型做重推理**：Qwen3.5-4B 主业是视觉。长文档总结应
   **先 OCR 提取、再把文本交给 GLM-5.3-Flash 总结**（两段式）。
7. **新增变量三处同步**：`.env.example` / `env.schema.ts` / `ENV.md`。

---

## 八、验证

```bash
# 1) 确认哪些 Provider 仍是 Mock
curl -s -i http://localhost:3000/api/v1/health | grep -E "X-Provider|X-Mock-Providers"

# 2) 配了文本主力（当前 glm-4.5-air）后，跑一次大纲生成，观察延迟与 token 消耗
#    若单次响应 > 10s，先检查 LLM_REASONING_EFFORT（注意收益是模型特定的，见 3.4）
#    真正兜底的是 LLM_TOTAL_BUDGET_MS —— 它保证一次逻辑调用不超过该时长

# 3) FFmpeg 是否就绪
python -m services.media   # /health 应返回 ffmpeg 版本与 LGPL 校验结果
```

---

## 九、现状卡点与实施路线（并入自《多模型分层接入方案》，2026-09-19）

> 本章保留原方案文档的**独有**内容：三层卡点分析与 P0~P3 实施阶段。
> 重复内容（配置块、实测表、成本汇总、红线清单）已在第二/三/五/七节各留一份，不再抄录。
> 快照时点的状态标注均已按 09-18/09-19 实测与《青智校园_八项待办落地记录》更新。

### 9.1 一个工具要真出结果，必须连过三关（09-17 归因）

按调用链从前往后，任何一关没过，用户看到都是"用不了"。产品侧提出"把文本、图片、视频
能力拆开接不同模型"（如文本用 GLM、视觉用 Qwen3-VL、音视频用 FFmpeg）——结论是**可以，
现有 Provider 架构就是为此设计的**；但最早的卡点在**工具执行器**，而不是模型。

**第 1 层：工具执行器是否注册**（最早、最容易被忽略）。
`apps/api/src/modules/job/tool-executor.service.ts` 的 `handlers` 是**白名单注册制**
（"只注册真正接入过的工具"），未注册的工具在 `run()` 里直接抛 `ErrorCode.NotFound`，
作业落到 `rejected`。这意味着：**那些功能不是"模型没选好"，是压根还没接进执行器**——
为它们挑"便宜的模型"是走错方向，先注册 handler 才是第一步。
09-17 时点只注册 8 个（`compress_image` / `convert_image` / `enhance_image` /
`remove_background`（当时抛 `LlmUnavailable`）/ `generate_ppt` / `generate_outline` /
`summarize_text`（仅 `.txt/.md`）/ `generate_image_prompt`）；OCR、视频 4 项、音频转格式、
语音转文字当时完全未注册。**现状**：OCR / 语音经 `MediaAiToolRunner` 接入（09-17），
视频 4 项 + `convert_audio` 经 media 侧车接入（09-19），`remove_background` 已接 rembg
（u2net 白名单代码级强制，实测 168ms）。实时可跑清单以 `npm run check:tools` /
`npm run verify:tools` 为准。

**第 2 层：Provider 是否为真实实现**。
`packages/core/src/providers/factory.ts` 的 `pick()` 对未装配能力自动回退 `Mock*Provider`；
`apps/api/src/infra/providers/real-provider.factory.ts` 负责条件装配（见第四节装配逻辑）。
当前真实实现：`image`（Sharp，写死启用）、`ppt`（PptxGenJS，写死启用）、
`llm`（配 Key 启用）、`ocr`（`VlmOcrProvider`，09-17 接入）、
`audio`（`SiliconflowAsrProvider`，09-17 接入；仅 `speechToText` 真实，
`convert` / `denoise` / `separateVocals` 抛明确错误而非假装成功）、
`embedding`（`SiliconflowEmbeddingProvider`，09-18 接上真实消费方 `KnowledgeModule`）、
`vector`（`QdrantVectorProvider`，09-18 接入；未配 `VECTOR_DRIVER=qdrant` 时回退 Mock 并打
`mock-vector` 标）、`storage`（Local/MinIO 按 `STORAGE_DRIVER`）、
`queue`（Redis 按 `REDIS_QUEUE_DRIVER`）。其余 `video` / `docParse` / `moderation` / `pay`
仍为 Mock。

> ⚠️ **`embedding` 与 `vector` 是两件事，别合并**：前者是"文本 → 向量"（模型服务），
> 后者是"向量存哪儿、怎么找最近的"（数据库）。分开配置才能单独替换任意一侧
> （例如换 Embedding 模型但继续用同一个 Qdrant）。

**第 3 层：Python 侧车是否实现**。
`services/ai`、`services/media` 曾只登记路由表，`_dispatch()` 对已登记未实现端点统一返回
`501 + code 50341 + X-Service-Stage: skeleton`。**现状（09-19）**：media 的
`probe/transcode/compress/cut/subtitle` 5 端点全部实现（FFmpeg 子进程、LGPL 构建、
编码器运行时探测不写死）；ai 侧仅 `/ai/matting` 实现，其余 6 条仍为 501。
注：OCR 与语音转文字**绕开了这条侧车**、直连硅基流动，侧车里的 `/ai/ocr`、`/ai/asr`
是冗余路由，将来换自部署模型（如 faster-whisper）才会用上。

### 9.2 实施阶段与状态

| 阶段 | 内容 | 落点 | 状态 |
|---|---|---|---|
| **P0 零成本点亮** | FFmpeg 接入 `video`/`audio`：实现 `/media/*` 5 端点 + Node 侧 `FfmpegVideoProvider` + 注册 `compress_video` / `convert_video` / `cut_video` / `burn_subtitle` / `convert_audio` handler；修 `remove_background` | `services/media/`、`apps/api/src/infra/providers/{video,audio}/`、执行器 | ✅ 09-19 完成（media 5/5、抠图转正）。遗留：音频**降噪**无端点、`denoise` 仍抛错 |
| **P1 接文本模型** | 真 LLM 供 `generate_outline` / `summarize_text` / `generate_image_prompt` / `generate_ppt` | 配置见 2.2「A 组」与 3.1 | ✅ 已配置（模型名历经三轮实测修正，**别抄历史版本**，权威 = A 组表格 + `.env` 注释） |
| **P2 接多模态** | `VlmOcrProvider`（DeepSeek-OCR）+ `SiliconflowAsrProvider` + `MediaAiToolRunner` 注册 `ocr_image`/`speech_to_text`；文档解析另起 `docParse` 槽 | `apps/api/src/infra/providers/{ocr,audio}/` | ✅ 09-17 接入并实测；四个坑与参数告警见 3.2。`parse_document` 保持 `planned`：PDF 栅格化（poppler）是 **GPL**，须进隔离转换服务，未实现前不开 |
| **P2.5 补悬空能力** | "Provider 是真的 ≠ 业务真的在用"：`plan` 档曾无任何调用方、`embedding` 曾只服务于 `/health` | 新增 `POST /os/plan`（JSON Schema 强约束 → DAG → 拓扑排序，非法计划整体降级）；新增 `KnowledgeModule`（M4-06 切片→向量化→Qdrant→带引用回答） | ✅ 09-18 完成。**教训：验证脚本的覆盖面就是"发现悬空能力"的边界**——`plan` 档能一直悬空是因为 `verify-os.mjs` 当时只测 intent/chat（补 ⑥ 后进入门禁），RAG 在此之前根本没有验证脚本。对应门禁：`npm run verify:os`、`npm run verify:rag` |
| **P3（可选）拆 LLM 多端点** | 当前 `OpenAiCompatibleLlmProvider` 只吃单一 `cfg`（一个 baseUrl + 一个 Key），三档仅换 model 名共享端点。若要 intent 用智谱、plan 用 DeepSeek-R1 之类**跨厂商组合**，需把配置结构改为 per-tier 独立 endpoint（`llm.tiers.{intent,generate,plan}: {baseUrl, apiKey, model}`） | `packages/core` 配置结构 + Provider 构造函数 | ⛔ 未做。P1 同服务商方案下不需要，列为可选避免过早设计 |

**成本口径**：P0 + P1 完成后，原清单里 12 项功能大部分真实可用、月成本接近零；
"免费 / 限免 ≠ 永久免费"的监控要求见第五节。
风险与红线（Mock 可辨、宁可 rejected、GPL 合规、三处同步、Provider 接口、Demucs 归档、
交付全绿）统一见第七节，不重复列出。
