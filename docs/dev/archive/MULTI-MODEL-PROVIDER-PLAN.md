# 多模型分层接入方案

> 🗄️ **已合并留档（2026-09-19）**：本文独有内容（三层卡点、P0~P3 实施路线）已并入
> [`../AI-PROVIDER-CONFIG.md`](../AI-PROVIDER-CONFIG.md) 第九节（状态已按 09-18/09-19 实测更新），
> 重复的配置块 / 实测表 / 成本 / 红线未搬运。本文件仅留档，不再更新。

> 状态：**待评审，未实施**（本文件只做方案，不改动任何代码）
> 创建：2026-09-17
> 相关：`docs/rules/DEVELOPMENT-STANDARDS.md`（红线 9 / 红线 10）、`docs/architecture/OVERVIEW.md`

## 一、为什么要写这份文档

产品侧提出：能否把文本、图片、视频能力**拆开接不同模型**（如文本用 GLM-5.3-Flash、视觉用
Qwen3-VL-Flash、音视频处理用 FFmpeg）。

结论是：**可以，而且现有 Provider 架构就是为此设计的**。但在动手前，需要先纠正一个流传中
的认知偏差——"功能用不了"的原因不止一层，其中最早的一层卡点在**工具执行器**，而不是模型。

---

## 二、现状实测：卡点其实有三层

按调用链从前往后，一个工具要能真正产出结果，必须连过三关。任何一关没过，用户看到都是"用不了"。

### 第 1 层：工具执行器是否注册（最早、最容易被忽略）

`apps/api/src/modules/job/tool-executor.service.ts` 的 `handlers` 采用**白名单注册制**
（文件注释：「只注册真正接入过的工具」）。未注册的工具在 `run()` 里直接抛
`ErrorCode.NotFound`，作业落到 `rejected`，提示「工具「xxx」尚未接入执行器」。

**当前只注册了 8 个：**

| 工具 | 注册 | 底层 | 真实可用 |
|---|---|---|---|
| `compress_image` | ✅ | Sharp | ✅ |
| `convert_image` | ✅ | Sharp | ✅ |
| `enhance_image` | ✅ | Sharp（锐化 + 提饱和） | ✅ 非 AI 超分 |
| `remove_background` | ✅ | rembg（未接） | ❌ 抛 `LlmUnavailable` |
| `generate_ppt` | ✅ | PptxGenJS | ✅ 大纲为参数模板，非 LLM |
| `generate_outline` | ✅ | `providers.llm` | ⚠️ 配 Key 即用 |
| `summarize_text` | ✅ | `providers.llm` | ⚠️ 仅 `.txt/.md`，PDF/Word 明确拒绝 |
| `generate_image_prompt` | ✅ | `providers.llm` | ⚠️ 配 Key 即用 |

**完全未注册**（用户点下去直接 rejected）：OCR、视频压缩/转码/裁剪/字幕、音频转格式/降噪/
裁剪、人声伴奏分离、语音转文字、文档论文解析。

> 这一层意味着：**这些功能不是"模型没选好"，是压根还没接进执行器**。
> 去为它们挑选"便宜的模型"是走错方向——先注册 handler 才是第一步。

### 第 2 层：Provider 是否为真实实现

`packages/core/src/providers/factory.ts` 的 `pick()` 对未装配的能力自动回退 `Mock*Provider`。
`apps/api/src/infra/providers/real-provider.factory.ts` 当前装配 **9 项真实实现**：

- `image` = `SharpImageProvider`（写死启用）
- `ppt` = `PptxGenJsProvider`（写死启用）
- `llm` = `OpenAiCompatibleLlmProvider`（**条件启用**：`cfg.llm.enabled`，即需配 Key）
- `ocr` = `VlmOcrProvider`（**条件启用**：`cfg.vlm.enabled`，共用硅基流动 Key）✅ 2026-09-17 接入
- `audio` = `SiliconflowAsrProvider`（**条件启用**：`cfg.asr.enabled`；仅 `speechToText` 真实，
  `convert` / `denoise` / `separateVocals` 抛明确错误而非假装成功）✅ 2026-09-17 接入
- `embedding` = `SiliconflowEmbeddingProvider`（**条件启用**：`cfg.embedding.enabled`）
  ✅ 2026-09-18 接上真实消费方（`KnowledgeModule`，M4-06）
- `vector` = `QdrantVectorProvider`（**条件启用**：`cfg.vector.enabled`，即 `VECTOR_DRIVER=qdrant`；
  否则回退 `MockVectorProvider` 并打 `mock-vector` 标，红线 10）✅ 2026-09-18 接入
- `storage` = Local / MinIO（按 `STORAGE_DRIVER`）
- `queue` = RedisStreamQueueProvider（按 `REDIS_QUEUE_DRIVER`）

其余 `video` / `docParse` / `moderation` / `pay` 等仍为 Mock。

> ⚠️ **`embedding` 与 `vector` 是两件事，别合并**：前者是"文本 → 向量"（模型服务），
> 后者是"向量存哪儿、怎么找最近的"（数据库）。分开配置才能单独替换任意一侧
> （例如换 Embedding 模型但继续用同一个 Qdrant）。

### 第 3 层：Python 侧车是否实现

`services/ai/routes.py`、`services/media/routes.py` 只登记了路由表，`services/shared/http.py`
的 `_dispatch()` 对**所有已登记但未实现**的端点统一返回 `501 + code 50341 + X-Provider: mock`。
包括 `/ai/ocr`、`/ai/asr`、`/ai/matting`、`/ai/inpaint`、`/ai/separation`、`/ai/parse-document`
以及 `/media/*` 全部 5 条。

> 注：OCR 与语音转文字**已绕开这条侧车**，直接由 `apps/api` 调硅基流动 API
> （见 P2）。侧车里的 `/ai/ocr`、`/ai/asr` 目前是冗余路由，将来若换成自部署模型
> （如 faster-whisper）才会用上。

---

## 三、目标架构：按"是否需要模型"分层

关键拆分——**"处理"和"理解"是两件事**，混为一谈会导致选型走偏：

| 能力类别 | 是否需要模型 | 归属 Provider | 选型 |
|---|---|---|---|
| 文本生成（大纲/总结/解题/翻译/导图） | 需要 | `llm` | **GLM-5.3-Flash**（免费） |
| 图片理解 / OCR | 需要 | `ocr` | **Qwen3-VL-Flash**（约 ¥0.16/百万输入） |
| 文档论文解析 | 需要 | `docParse` | Qwen3-VL-Flash 或 MinerU |
| 语音转文字 | 需要 | `audio.speechToText` | 自部署 faster-whisper / Doubao 原生音频 |
| 人声伴奏分离 | 需要 | `audio.separateVocals` | Demucs（**上游已归档，需换 Spleeter 等**） |
| 抠图 | 需要 | `image.removeBackground` | rembg u2net（白名单） |
| **图片压缩/转格式** | **不需要** | `image` | Sharp（已可用） |
| **视频压缩/转码/裁剪/烧字幕** | **不需要** | `video` | **FFmpeg 子进程** |
| **音频转格式/降噪** | **不需要** | `audio` | **FFmpeg 子进程** |
| PPT 渲染 | 不需要 | `ppt` | PptxGenJS（已可用） |

> **最省钱的结论**：视频、音频那 7 项标 Mock 的功能，缺的不是模型而是 **FFmpeg 子进程包装层**。
> 接上后边际成本为零，不需要为它们买任何模型。

---

## 四、实施阶段

### P0 —— 零成本点亮（不涉及任何模型采购）

**目标**：把"不需要模型"的能力全部点亮。

1. **FFmpeg 接入 `video` / `audio`**
   - 落点：`services/media/` 实现 `/media/transcode|compress|cut|subtitle|probe` 五个端点
   - 约束：只以**子进程调用 CLI**，绝不链接 `libav*`（避免 GPL 污染主工程）；
     必须是 **LGPL 构建**，由 `scripts/license/check-ffmpeg-license.sh` 断言
   - 新增 Node 侧 `FfmpegVideoProvider` / `FfmpegAudioProvider`（HTTP 调 `services/media`）
     落在 `apps/api/src/infra/providers/{video,audio}/`
   - 装配进 `RealProviderFactory`
2. **注册执行器 handler**：`compress_video` / `convert_video` / `cut_video` / `burn_subtitle` /
   `convert_audio` / `denoise_audio`
3. **顺带修 `remove_background`**：当前已注册但必抛异常，UI 上表现为"点了就报错"。
   要么接 rembg，要么在执行器层前置降级为明确提示

**产出**：7 项功能从"rejected / Mock"变为真实可用，API 成本 **0 元**。

### P1 —— 接文本模型（免费）

**目标**：让 `generate_outline` / `summarize_text` / `generate_image_prompt` / `generate_ppt` 用上真 LLM。

1. `.env` 配置（**三处同步**：`.env.example`、`apps/api/src/common/config/env.schema.ts`、
   `docs/dev/ENV.md`）：
   ```bash
   LLM_BASE_URL=https://api.siliconflow.cn/v1
   LLM_API_KEY=<硅基流动 Key>
   LLM_MODEL_INTENT=deepseek-ai/DeepSeek-V4-Flash    # 三档统一
   LLM_MODEL_GENERATE=deepseek-ai/DeepSeek-V4-Flash
   LLM_MODEL_PLAN=deepseek-ai/DeepSeek-V4-Flash
   LLM_FALLBACK_MODELS=
   LLM_REASONING_EFFORT=low
   ```
   > ⚠️ 本段的模型名**改过三轮**（DeepSeek → 智谱 glm-4.7-flash → 智谱分档 → 硅基
   > DeepSeek-V4-Flash），每次都是实测推翻了上一次的判断。**别照抄这里的旧版本**，
   > 权威版本永远是 `docs/dev/AI-PROVIDER-CONFIG.md` 的「A 组」表格 + `.env` 注释。
   > 选型结论：**先过"功能可用"（协议/参数/不编造）这一关，再比价格。**
   > 降级链当前**刻意留空** —— 现有实现只能同服务商换模型名，跨服务商降级尚未实现。
2. `LLM_REASONING_EFFORT=low` **必须设**。实测（见 `openai-compatible.provider.ts` 注释）：
   GLM 系列是推理型模型，默认推理很深——"只回复两个字：可以"会消耗 **112 完成 token、
   3.5 秒**；设 `low` 后降到 **3 token、0.99 秒**。不设会让小程序端明显卡顿。
   ⚠️ 智谱只认 `low` / `high` / `max`，传 `medium` 会被 400 拒绝（code 1210）。
3. `generate_ppt` 接入真 LLM 大纲（当前是参数模板，见执行器注释 M1-07）

**产出**：4 项文本功能真实可用，API 成本 **0 元**（GLM-4.7-Flash 免费）。

### P2 —— 接多模态模型（硅基流动，限免期内零成本）

**目标**：点亮 OCR / 图片理解 / 文档解析。

服务商：**硅基流动 SiliconFlow**（与 P1 的智谱是两家，各用各的 Key）。

1. 新增 `VlmOcrProvider`，实现 `OcrProvider` 接口
   - 落点：`apps/api/src/infra/providers/ocr/vlm-ocr.provider.ts`
   - 接口：`recognize(file: Buffer, opts?) → { blocks: OcrBlock[]; fullText: string }`
     （`OcrBlock` 支持四角坐标，VLM 可返回版面框）
   - 模型：`deepseek-ai/DeepSeek-OCR`（**必须带组织前缀**，写成 `qwen3.5-4b` 会 404）
   - 端点：`https://api.siliconflow.cn/v1`（国内站，配套控制台 `cloud.siliconflow.cn`）
   - **不能复用 `OpenAiCompatibleLlmProvider`**：它只传 `content: string`，
     无法表达图像的多段 content（`image_url` / `base64`），需独立实现
2. 装配 `overrides.ocr = new VlmOcrProvider(...)`，未配 Key 时自动回退 `MockOcrProvider`
3. 注册 `ocr_image` handler（`MediaAiToolRunner`）
4. 文档解析另起 `docParse` 槽位：`PaddlePaddle/PaddleOCR-VL-1.5`
   （OmniDocBench v1.5 **94.5%**，长文档）或 `deepseek-ai/DeepSeek-OCR`（OCR 专项）
5. 成本：**限免期内 ¥0**。⚠️ "限免"会到期，需监控用量并在到期前重估

#### ✅ 实施状态（2026-09-17 完成并实测）

| 项 | 状态 | 实测结论 |
|---|---|---|
| `VlmOcrProvider` | ✅ 已接入 | 落点 `apps/api/src/infra/providers/ocr/vlm-ocr.provider.ts` |
| `SiliconflowAsrProvider` | ✅ 已接入 | 落点 `apps/api/src/infra/providers/audio/asr.provider.ts` |
| `MediaAiToolRunner` | ✅ 已注册 | 承载 `ocr_image` / `speech_to_text` 两个工具 |
| 配置三处同步 | ✅ 完成 | `.env` / `.env.example` / `docs/dev/ENV.md` |
| 自检脚本 | ✅ 新增 | `scripts/dev/verify-siliconflow.mjs`（含装配层校验） |

**实测（国内站，同一张中文截图 / 1 秒音频）：**

| 模型 | 典型耗时 | 长尾 | 判定 |
|---|---|---|---|
| `deepseek-ai/DeepSeek-OCR` | **300ms** | 未观察到抖动 | ✅ **默认选它** |
| `PaddlePaddle/PaddleOCR-VL-1.5` | 120~250ms | ⚠️ 约 1/3 概率首轮返回乱码、耗时 14~15s | ⚠️ 需靠重试兜住 |
| `Qwen/Qwen3.5-4B`（理解/OCR 通用） | 0.6~1.2s | ⚠️ 偶发 32s | ⚠️ 交互场景慎用 |
| `Qwen/Qwen3-ASR-1.7B` | **~100ms** | 未观察到抖动 | ✅ **语音默认** |
| `FunAudioLLM/SenseVoiceSmall` | 61.3s | — | ❌ 太慢，不建议 |

**踩到的四个坑（已修）：**

1. **ASR 不走 `/chat/completions`** —— 必须 `POST /audio/transcriptions`（multipart）。
   打错端点返回 `400 code 20012 Model does not exist`，报错信息极具误导性。
2. **`enable_thinking` 不能无脑传** —— `deepseek-ai/DeepSeek-OCR` 收到直接
   `400 code 20015`。故配置默认留空＝不发送；只有 Qwen3.5 这类混合思考模型才设 `false`
   （实测 token 209 → 1、耗时 5.2s → 0.5s）。`reasoning_effort` 对 Qwen 系无效。
3. **免费档会返回 HTTP 200 + 一长串重复字符** —— 属"假成功"，若不拦截会被当成
   识别成功存下来（违反红线 9）。已加 `isDegenerateOutput` 拦截，且**归入可重试错误**
   （实测重试能救回来）。
4. **`language` 是白名单参数** —— 实测只认 ISO 639-1 两字母码；`zh-CN`、`auto`、
   `中文`、表外码全部 400。⚠️ 小程序语言选项里的「自动识别」值就是 `auto`，
   原样透传会让该选项 **100% 失败**。已在 `normalizeAsrLanguage` 归一化
   （`auto`/未知值 → 不发送参数，即服务端自动识别）。

**两个"能力边界"实测结论（不是 bug，但影响功能承诺）：**

- **ASR 拿不到时间戳** —— `verbose_json` / `srt` / `vtt` 全部 400，
  `timestamp_granularities[]` 被忽略。故种子里的工具描述已从
  「带时间戳的转写」改为「音频转文字，支持中英日韩等多语种」，
  免得界面承诺一个做不到的能力。需要字幕时间轴须换 faster-whisper。
- **`parse_document` 仍未实现**（种子状态 `planned`）—— 它声明解析 PDF，
  而 PDF 栅格化（poppler / pdftoppm）是 **GPL**，按红线必须进隔离转换服务，
  该服务尚未实现。硬做会变成"假功能"，故保持未开放。

> 完整配置见 `docs/dev/AI-PROVIDER-CONFIG.md`。
> 一键自检：`npm run build -w @qz/api && node scripts/dev/verify-siliconflow.mjs`

### P2.5 —— 补上 plan 档与 RAG 的真实调用点（2026-09-18）

P1 / P2 解决的是"Provider 是不是真的"，但 **Provider 是真的 ≠ 业务真的在用**。
当时有三处"配好了却没人调"的悬空能力：

| 能力 | 当时的实际状态 | 现在 |
|---|---|---|
| `intent` 档 | ✅ 有调用方（`/os/intent` ← 小程序 `pages/os`），**曾一度被误判为"无调用点"** | 不变，已纳入 `verify:os` ② |
| `plan` 档 | ⛔ **无任何调用方** —— 三档里只有它没有入口 | ✅ 新增 `POST /os/plan`：JSON Schema 强约束 → DAG → 拓扑排序；非法计划**整体降级**，不硬编半张图 |
| `embedding` | ⛔ 只服务于 `/health`，没有任何业务消费方 | ✅ 新增 `KnowledgeModule`（M4-06）：切片 → 向量化 → Qdrant → 检索 → 带引用回答 |

**教训：验证脚本的覆盖面，就是"发现悬空能力"的边界。**
`plan` 档能一直悬空而无人察觉，是因为 `verify-os.mjs` 当时只测 intent / chat；
补上 ⑥ 之后它才进入门禁。同理，RAG 在此之前**根本没有验证脚本**。

对应验证（都会真实调用模型，不是"跑通就算"）：

```bash
npm run verify:os    # 含 ⑥ plan 档：拓扑序 / 类型白名单 / 未降级 / 鉴权
npm run verify:rag   # 灌库 → 语义检索 → 带引用回答 → 清理（真实模型 + 真实 Qdrant）
```

### P3（可选）—— 拆 LLM 多端点

当前 `OpenAiCompatibleLlmProvider` 构造函数只吃**单一 `cfg`**（一个 `baseUrl` + 一个 `apiKey`），
三个 tier（`intent`/`generate`/`plan`）仅换 model 名、共享同一端点。

若后续想 intent 用智谱、plan 用 DeepSeek-R1 之类跨厂商组合，需要先改造配置结构为
**per-tier 独立 endpoint**：

```ts
llm: {
  tiers: {
    intent:   { baseUrl, apiKey, model },
    generate: { baseUrl, apiKey, model },
    plan:     { baseUrl, apiKey, model },
  }
}
```

**P1 阶段不需要做**，全部用智谱时现有配置已够用。列为可选，避免过早设计。

---

## 五、成本汇总

| 阶段 | 点亮功能 | API 成本 |
|---|---|---|
| P0 | 视频 4 项 + 音频 2 项（FFmpeg） | **¥0** |
| P1 | 文本 4 项（GLM-5.3-Flash） | **¥0** |
| P2 | OCR / 图片理解 / 文档解析（硅基流动） | **¥0（限免期内）** |
| P3 | 按需 | 视组合而定 |

> ⚠️ **"免费 / 限免"≠ 永久免费**：平台标注"限免"的模型会恢复收费，
> 且 L0 限速档（约 RPM 1000 / TPM 80,000）在生产流量下可能不足。
> 建议监控用量，限免结束前完成成本重估。

P0 + P1 完成后，截图里 12 项功能中大部分即可真实可用，**月成本接近零**。

---

## 六、风险与红线约束

1. **红线 10（Mock 必须可辨）**：所有新增 Provider 未配置凭证时必须回退 Mock，
   并让 `MockMarkerMiddleware` 打上 `X-Provider: mock` + `X-Mock-Providers` 响应头，
   前端显示"演示模式"角标。**绝不允许静默返回假数据**。
2. **红线 9（宁可显示未接入）**：未接能力的工具宁可 rejected 并提示"尚未开放"，
   不要产出看起来成功、实际无内容的作业。
3. **GPL 合规**：FFmpeg 必须是 LGPL 构建，且以**子进程 CLI** 调用，不链接 `libav*`；
   LibreOffice / Pandoc / ConvertX 等 GPL 组件**禁止**装入 `apps/` 或 `services/`。
4. **新增环境变量必须三处同步**：`.env.example`、`env.schema.ts`、`docs/dev/ENV.md`。
   `.env` 严禁入库。
5. **外部依赖只能走 Provider 接口**：禁止在业务代码里 `new` 任何第三方 SDK。
6. **Demucs 上游已归档**：人声分离若坚持此路线属技术债，建议评估 Spleeter 或商用方案后再接。
7. **交付前全绿**：`npm run lint` / `typecheck` / `test` / `build`；改动 `packages/core` 需补单测。
