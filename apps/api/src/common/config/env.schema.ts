import { z } from 'zod';

/**
 * 环境变量白名单与校验（任务清单 M0-05）
 *
 * 纪律：
 *  ① 所有环境变量必须在此登记，未登记的变量不会被应用读取；
 *  ② 启动期一次性校验，缺失/非法立即抛错，不允许"跑到一半才崩"；
 *  ③ 业务代码禁止直接读 process.env，统一走 ConfigService（见 configuration.ts）。
 */

/**
 * 布尔型环境变量。
 *
 * 为什么不用 z.coerce.boolean()：Boolean('false') === true，
 * 会把 LOG_MASK_SENSITIVE=false 静默判成"开启"，脱敏失效且毫无报错。
 * 这里显式支持 true/false、1/0、yes/no、on/off（大小写不敏感）。
 */
const envBoolean = (fallback: boolean) =>
  z
    .union([z.boolean(), z.string().regex(/^(true|false|1|0|yes|no|on|off)$/i)])
    .default(fallback ? 'true' : 'false')
    .transform((value) => (typeof value === 'boolean' ? value : /^(true|1|yes|on)$/i.test(value)));

export const EnvSchema = z.object({
  // 运行环境
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_PREFIX: z.string().default('/api/v1'),
  APP_VERSION: z.string().default('0.1.0'),

  // Provider 模式（红线 9/10）
  PROVIDER_MODE: z.enum(['mock', 'real', 'hybrid']).default('hybrid'),

  // 数据库（MySQL 8.0+）
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL 必填，例如 mysql://qz:qz_dev_password@localhost:3306/qingzhi'),
  // 影子库：仅 prisma migrate dev 使用，生产可指向任意空库（migrate deploy 不读）
  SHADOW_DATABASE_URL: z
    .string()
    .default('mysql://qz:qz_dev_password@localhost:3306/qingzhi_shadow'),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(10),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),
  QUEUE_DRIVER: z.enum(['redis-stream', 'rabbitmq']).default('redis-stream'),
  // 队列 Worker（M1-04）：并发数可配置是验收项；认领阈值决定"Worker 被强杀后多久任务重回队列"
  QUEUE_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
  QUEUE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  QUEUE_CLAIM_IDLE_MS: z.coerce.number().int().min(1000).default(60000),
  /** 卡在 queued 超过该毫秒数即视为"投递丢失"，由启动/周期扫描重新投递 */
  QUEUE_ORPHAN_QUEUED_MS: z.coerce.number().int().min(1000).default(60000),

  // 对象存储
  // local = 本地文件系统（开发默认，不依赖外部服务）；minio 已停止分发；oss/cos 为生产用
  STORAGE_DRIVER: z.enum(['local', 'minio', 'oss', 'cos']).default('local'),
  /** local 驱动的落盘目录（相对仓库根或绝对路径） */
  LOCAL_STORAGE_DIR: z.string().default('./data/uploads'),
  STORAGE_ENDPOINT: z.string().default('http://localhost:9000'),
  STORAGE_REGION: z.string().default('cn-hangzhou'),
  STORAGE_BUCKET: z.string().default('qingzhi-dev'),
  STORAGE_ACCESS_KEY: z.string().default('minioadmin'),
  STORAGE_SECRET_KEY: z.string().default('minioadmin'),
  STORAGE_PRESIGN_EXPIRE: z.coerce.number().int().default(900),
  STORAGE_PUBLIC_BASE_URL: z.string().optional().default(''),

  // JWT
  JWT_SECRET: z.string().min(16, 'JWT_SECRET 至少 16 位，生产环境请用 64 位随机串'),
  JWT_ACCESS_EXPIRE: z.string().default('2h'),
  JWT_REFRESH_EXPIRE: z.string().default('30d'),

  // 微信
  WECHAT_APPID: z.string().default(''),
  WECHAT_SECRET: z.string().optional().default(''),
  /**
   * 是否**强制**走开发模式的伪 openid（即使已配好真实 AppSecret）。
   *
   * ## 为什么需要它（2026-09-19 实测）
   *
   * 端到端验证脚本（`verify:*`）都用假 code 调 `/auth/login`。填了真 Secret 之后，
   * 假 code 会被微信拒（`40029 invalid code`）→ **所有脚本登录 401，"配好了反而没法验证"**。
   * 本开关让"是否走真实微信"与"有没有 Secret"解耦。
   *
   * ⚠️ `NODE_ENV=production` 时**强制失效**（`buildWechat` 里判定），不必担心误开。
   */
  WECHAT_DEV_LOGIN: z
    .string()
    .optional()
    .transform((v) => String(v ?? '').toLowerCase() === 'true')
    .default('false'),
  WECHAT_CODE2SESSION_URL: z.string().default('https://api.weixin.qq.com/sns/jscode2session'),
  WECHAT_SUBSCRIBE_TEMPLATE_TASK: z.string().optional().default(''),
  WECHAT_SUBSCRIBE_TEMPLATE_ORDER: z.string().optional().default(''),
  WECHAT_SUBSCRIBE_TEMPLATE_JOB: z.string().optional().default(''),

  // 微信支付
  WECHAT_PAY_MCHID: z.string().optional().default(''),
  WECHAT_PAY_SERIAL_NO: z.string().optional().default(''),
  WECHAT_PAY_PRIVATE_KEY_PATH: z.string().optional().default(''),
  WECHAT_PAY_APIV3_KEY: z.string().optional().default(''),
  WECHAT_PAY_NOTIFY_URL: z.string().optional().default(''),

  // LLM
  LLM_DRIVER: z.enum(['openai-compatible', 'mock']).default('openai-compatible'),
  LLM_BASE_URL: z.string().default('https://api.deepseek.com/v1'),
  LLM_API_KEY: z.string().optional().default(''),
  LLM_MODEL_INTENT: z.string().default('glm-4.7-flash'),
  LLM_MODEL_GENERATE: z.string().default('glm-4.7-flash'),
  LLM_MODEL_PLAN: z.string().default('glm-4.7-flash'),
  /**
   * 单次 HTTP 请求超时（毫秒）。
   *
   * ⚠️ 必须 **≤ `LLM_TOTAL_BUDGET_MS`**（启动期由 `assertTimeoutWithinBudget` 断言）。
   * 默认 30s 的依据：实测长输出（800 字）约 12s、plan 档约 21s —— 给正常慢请求留余量，
   * 同时保证"第一次挂起"之后还剩 ~15s 预算发起重试。
   */
  LLM_TIMEOUT_MS: z.coerce.number().int().default(12000),
  LLM_MAX_RETRY: z.coerce.number().int().min(0).max(10).default(3),
  /**
   * **单次逻辑调用**的总时间预算（毫秒）—— 覆盖"所有模型 × 所有重试 × 所有退避"的总和。
   *
   * ## 为什么必须有它（实测踩坑）
   *
   * 超时是**乘法放大**的：单次尝试 `LLM_TIMEOUT_MS`、每模型 `LLM_MAX_RETRY` 次、
   * 退避 1s/4s、还要乘以模型数。按默认值算：
   *
   * ```
   * 2 个模型 × (3 次 × 60s + 退避 5s) = 370 秒
   * ```
   *
   * 也就是说，一个用户点「发送」后**最长可能等 6 分钟**才看到失败 ——
   * 而小程序侧 `request.ts` 的 `timeout` 只有 30 秒，早就断了。
   * 结果是：前端显示"网络开小差了"，后端还在傻等，
   * 并且**每次超时都真的打满了供应商的 token 配额**（钱花了，用户啥也没得到）。
   *
   * 加了这个预算后，无论怎么配 `LLM_MAX_RETRY` / `LLM_FALLBACK_MODELS`，
   * 一次逻辑调用的墙钟时间都不会超过它 —— 这是个**不变量**，不是建议值。
   *
   * 取值参考：小程序请求超时 30s，所以预算应**明显小于** 30s 才有意义
   * （留出网络与后端处理时间）。默认 45s 是给"大纲生成"这类长任务留的余量；
   * 意图识别这类交互式调用建议压到 8~12s。
   */
  LLM_TOTAL_BUDGET_MS: z.coerce.number().int().min(1000).default(25000),
  /**
   * 降级模型（逗号分隔，可选）。主模型**重试耗尽**后按顺序再试这些模型。
   *
   * 为什么需要：免费档的 flash 模型会过载，返回 `HTTP 429 + code 1305
   * 该模型当前访问量过大`。实测 `glm-4.7-flash` 高峰期 5 次里 4 次 429，
   * 唯一成功那次耗时 42 秒 —— 光靠重试（1s/4s/16s）等不来可用性，
   * 只会让用户白等 20 秒再看到失败。
   *
   * 配了降级模型后：主模型过载 → 自动换一个健康的模型，用户几乎无感。
   * 留空则不降级（只重试主模型），保持"只用一个模型"的干净语义。
   */
  LLM_FALLBACK_MODELS: z.string().optional().default(''),
  /**
   * 推理深度。空串 = 不发送该字段（默认）。
   *
   * ⚠️ **枚举取值是实测得出的，不是抄 OpenAI 规范**：
   * 智谱 GLM flash 系列只接受 `low` / `high` / `max`，
   * 传 `medium` 或 `minimal` 会被直接 400 拒绝
   *（`code 1210 该模型始终思考，不支持关闭思考；请使用 low、high 或 max`）。
   * 所以这里**刻意不允许 medium** —— 让配置错误在启动时就报错，
   * 而不是等到线上每次请求都 400。
   *
   * 实测同一请求（"只回复两个字：可以"）：
   *   不传 → 完成 token 112（其中 107 是推理）、3.5s
   *   low  → 完成 token 3、0.99s ← 推荐
   *   high → 完成 token 3、2.2s
   *   max  → 完成 token 135、2.5s（推理拉满，仅复杂任务用）
   *
   * ⚠️ **别把这组数字当通用结论**：上表是**极简任务**测出来的。换到复杂生成任务
   *（如 `generate_mindmap`）`low` 就**压不住**了 —— 实测 reasoning 仍占 token 的
   * 60~75%、耗时 23.6~31.1s，在 30s 超时线上反复横跳。那种场景要靠
   * `LLM_DISABLE_THINKING`（显式关思考），**不是**靠调这个档位。
   */
  LLM_REASONING_EFFORT: z.enum(['', 'low', 'high', 'max']).default(''),

  /**
   * 是否**允许**向端点发送 `thinking: { type: 'disabled' }`（智谱 GLM 的"关闭思考"）。
   *
   * ⚠️ 语义是"**允不允许发这个参数**"，不是"要不要思考" —— 真正决定关不关的是调用方：
   * 只有显式传 `LlmCallOptions.disableThinking` 的调用（目前是 `generate_mindmap`
   * 这类重生成工具）才会带上它。
   *
   * 为什么要多这一层：`thinking` 是**服务商特有参数**，换到不支持的 OpenAI 兼容端点会 400。
   * 届时把这里设为 `false` 即可（Provider 会跳过发送），不必改代码。
   *
   * 实测（`glm-4.5-air`，同一思维导图 prompt）：
   *   不关 → reasoning 占 token 60~75%、耗时 **23.6~31.1s**（在 30s 超时线上反复横跳）
   *   关掉 → reasoning 归零、耗时 **3.6s**、`completion_tokens` 2016 → **314**
   * `glm-4.7-flash` 同样接受该参数（43.4s → 17.9s）；**更老的** flash 系列会报
   * `code 1210 该模型始终思考，不支持关闭思考`。
   */
  LLM_DISABLE_THINKING: z
    .string()
    .optional()
    .transform((v) => String(v ?? '').toLowerCase() !== 'false')
    .default('true'),

  // AI 媒体服务
  AI_SERVICE_URL: z.string().default('http://localhost:8000'),
  MEDIA_SERVICE_URL: z.string().default('http://localhost:8001'),
  /**
   * 图表渲染（Mermaid / markmap → PNG 分享图）的实现选择。
   *
   * `mock`（默认）= **不渲染、不新增产物**：`generate_mindmap` 只交付文本产物，
   * 分享图这一步静默跳过（零回归）。`playwright` = 媒体侧车截图出图。
   *
   * ⚠️ 开启前提：media 侧车已执行 `pip install playwright &&
   * playwright install chromium --with-deps`（中文字体包必须装，否则渲染出的
   * 中文全是方块）。未满足时侧车返回 501 + 安装指引，文本产物不受影响。
   */
  RENDER_PROVIDER: z.enum(['mock', 'playwright']).default('mock'),
  /** edge-tts 可执行文件（LGPLv3，装在仓库之外的独立 venv）。留空 = 未安装，`/media/tts` 返回 501。 */
  MEDIA_TTS_BIN: z.string().optional().default(''),
  /**
   * FFmpeg / ffprobe 可执行文件路径 —— **给 `services/media` 侧车用**，后端自己不调用。
   *
   * ⚠️ 必须是 **LGPL 构建**：`scripts/license/check-ffmpeg-license.sh` 会断言
   * `-buildconf` 里不出现 `--enable-gpl`（那才是 FFmpeg 的默认许可语义）。
   * 默认走 PATH 查找；本机未装进 PATH，故 `.env` 里显式指向绝对路径。
   */
  FFMPEG_BIN: z.string().default('ffmpeg'),
  FFPROBE_BIN: z.string().default('ffprobe'),
  REMBG_MODEL: z.string().default('u2net'),
  VOCAL_SEPARATION_ENGINE: z.enum(['demucs', 'spleeter']).default('demucs'),
  WHISPER_MODEL: z.string().default('small'),
  GPU_CONCURRENCY: z.coerce.number().int().min(1).default(1),

  // ---------- 硅基流动 SiliconFlow（多模态 / OCR / 语音，共用一个 Key） ----------
  /**
   * 硅基流动统一凭证。OCR、文档解析、语音转文字全部复用这两个变量，
   * 各能力只通过 *_MODEL 指定模型名。
   *
   * 为什么共用一个 Key：这些能力同属一家服务商，分开配置只会增加维护成本；
   * 将来若某项能力迁到别家，再单独拆出专属变量即可。
   */
  SILICONFLOW_BASE_URL: z.string().default('https://api.siliconflow.cn/v1'),
  SILICONFLOW_API_KEY: z.string().optional().default(''),

  /**
   * OCR 的实现选择：`cloud` = 硅基流动 VLM（默认）；`selfhost` = AI 侧车 PaddleOCR。
   *
   * 切 `selfhost` 的前提与 `ASR_PROVIDER` 相同：`AI_SERVICE_URL` 已配置
   * （未配置时回落 Mock，红线 10）+ 侧车已安装 paddleocr / paddlepaddle（CPU 版）。
   * selfhost 的收益是结果确定性与零按次计费；超时用 `AI_SERVICE_TIMEOUT_MS`（120s），
   * 首次调用要下载 PaddleOCR 模型，偏慢属正常。
   */
  OCR_PROVIDER: z.enum(['cloud', 'selfhost']).default('cloud'),
  /**
   * OCR / 图片理解模型。**必须带组织前缀**（HuggingFace 风格）。
   *
   * 实测对比（同一张中文截图）：
   *   deepseek-ai/DeepSeek-OCR        1.3s，输出最干净（纯文本，无标记）
   *   PaddlePaddle/PaddleOCR-VL-1.5   2.1s，输出含 <|LOC_x|> 版面坐标标记（需清洗，但可还原位置）
   * 默认选 DeepSeek-OCR；需要版面坐标时切换 PaddleOCR-VL。
   */
  VLM_MODEL: z.string().default('deepseek-ai/DeepSeek-OCR'),
  /**
   * 是否向视觉模型发送 `enable_thinking`。
   *
   * **空（默认）= 不发送**，这是唯一对任何模型都安全的选择：
   * 实测 `deepseek-ai/DeepSeek-OCR` 收到该参数会直接 400
   * （`code 20015 ... current model does not support parameter enable_thinking`）。
   *
   * 仅当改用 Qwen3.5 / Qwen3-VL 等**混合思考模型**时才需要显式设为 `false`：
   * 实测 Qwen3.5-4B 默认会先"思考"，同一张图 completion token 209 → 1、耗时约 5.2s → 0.5s。
   * 注意 `reasoning_effort` 对 Qwen 系几乎无效（实测 207 → 197），必须用本参数。
   */
  VLM_ENABLE_THINKING: z.enum(['', 'true', 'false']).default(''),
  VLM_TIMEOUT_MS: z.coerce.number().int().default(90000),
  VLM_MAX_RETRY: z.coerce.number().int().min(0).max(10).default(2),

  /**
   * 语音转文字的实现选择：`cloud` = 硅基流动（默认）；`selfhost` = AI 侧车 faster-whisper。
   *
   * 切 `selfhost` 的前提：
   *   · `AI_SERVICE_URL` 已配置且侧车在跑 —— **未配置时回落 Mock**（X-Provider: mock，
   *     红线 10），与"配了才真"策略一致；
   *   · 侧车已安装 faster-whisper 并能访问 HuggingFace 下载权重（首次调用）。
   * selfhost 的收益是**逐句时间戳**（云端端点只回整段文本）与零按次计费；
   * 代价是 CPU 转写耗时（约音频时长的 0.1~1 倍），预算沿用 `ASR_TOTAL_BUDGET_MS`，
   * 默认 25s 对长音频偏紧 —— 频繁超时请调大（仍受"≤ 小程序超时 − 5s"断言约束）。
   */
  ASR_PROVIDER: z.enum(['cloud', 'selfhost']).default('cloud'),
  /**
   * 语音转文字模型。
   *
   * ⚠️ 实测：ASR 走 `POST /v1/audio/transcriptions`（multipart，OpenAI Whisper 风格），
   * **不是** `/chat/completions` —— 后者会返回 400 "Model does not exist"。
   * 实测 Qwen/Qwen3-ASR-1.7B 约 0.5s；FunAudioLLM/SenseVoiceSmall 同样可用但明显更慢。
   */
  ASR_MODEL: z.string().default('Qwen/Qwen3-ASR-1.7B'),
  /**
   * 单次 ASR 请求超时。
   *
   * ⚠️ **曾经是 120000（2 分钟）**，而实测成功耗时只有 **78~97ms** ——
   * 也就是说这个值比真实耗时大了三个数量级。后果是：供应商偶发挂起时
   * （实测约 35% 的调用会挂住，报 `The operation was aborted due to timeout`），
   * 用户要**干等两分钟**才看到失败，而且每次都照样消耗额度。
   *
   * 改成 20s 的依据：60 秒语音的转录实测在 3~6 秒量级，20s 已有 3 倍余量；
   * 超过 20s 还没返回的基本就是挂起，早失败早重试更划算。
   */
  ASR_TIMEOUT_MS: z.coerce.number().int().default(20000),
  /**
   * ASR **额外**重试次数（不含首次尝试）。默认 1 → 共 2 次尝试。
   *
   * 为什么要重试：挂起是**间歇性**的（同一次音频，第一次超时、第二次 78ms 成功），
   * 属于典型"重试即成功"的故障形态。不重试等于把 ~35% 的可用性直接丢掉。
   *
   * ⚠️ 语义与 `LLM_MAX_RETRY` **不同**：那个是"总尝试次数"，这个是"额外次数"。
   * 这里刻意不沿用 LLM 的写法 —— ASR 是单次短操作，把"1 次重试"写成 `MAX_RETRY=1`
   * 比写成 `MAX_ATTEMPTS=2` 更符合直觉（用户想的是"再试一次"）。
   */
  ASR_MAX_RETRY: z.coerce.number().int().min(0).max(3).default(1),
  /**
   * ASR **单次逻辑调用**的总时间预算（毫秒）。
   *
   * 同 `LLM_TOTAL_BUDGET_MS`：没有它时 `重试次数 × ASR_TIMEOUT_MS` 会累加，
   * 按默认值算 `2 × 20s = 40s`，已经超过小程序请求超时（30s）——
   * 前端早断了，后端还在打请求。
   *
   * 默认 25000：保证 `2 次尝试` 的最坏墙钟时间 **小于 30s**。
   */
  ASR_TOTAL_BUDGET_MS: z.coerce.number().int().min(1000).default(25000),

  /**
   * 向量化模型（语义检索 / RAG 用）。
   *
   * ⚠️ **`EMBEDDING_DIMENSION` 必须与模型真实维度一致** ——
   * 下游建向量表、算余弦相似度都依赖它，填错不会报错、只会静默算出错误结果。
   * 实测 `BAAI/bge-m3` = **1024 维**（单条 146ms）。
   * 换 `Qwen/Qwen3-Embedding-8B` 之类要同步改（那是 4096 维）。
   */
  EMBEDDING_MODEL: z.string().default('BAAI/bge-m3'),
  EMBEDDING_DIMENSION: z.coerce.number().int().positive().default(1024),
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().default(60000),
  EMBEDDING_MAX_RETRY: z.coerce.number().int().min(0).max(10).default(2),

  // ---------- 向量库 + RAG 检索（M4-06 校园知识库） ----------
  /**
   * 向量库实现：`qdrant`（自建，推荐）| `mock`（默认，进程内实现）。
   *
   * 为什么需要独立的向量库：本项目已拍板统一用 **MySQL 8**，而 MySQL
   * 既没有向量类型也没有 ANN 索引。把 1024 维向量存进 Json 列，
   * 检索只能全表捞出来在应用层算余弦 —— 几百条还行，上万条就是一次接口几十秒。
   * `KnowledgeDoc.embedding` 那个 Json 列是初版 schema 的过渡设计，
   * 已被本方案取代（字段保留但不写入，见 schema.prisma 的注释）。
   *
   * ⚠️ 默认 `mock` 而不是 `qdrant`：让**没部署向量库的机器也能起来**，
   * 检索会走 `mock-vector` 并被打上 `X-Provider: mock`（红线 10）。
   * 要用真检索必须显式改成 `qdrant` —— 反过来（默认 qdrant）会让
   * 所有开发机启动就报连不上。
   */
  VECTOR_DRIVER: z.enum(['mock', 'qdrant']).default('mock'),
  /** Qdrant 服务地址。自建默认 6333；Qdrant Cloud 填完整 https 地址 */
  QDRANT_URL: z.string().default('http://localhost:6333'),
  /** Qdrant 托管版必须填；自建通常留空（不带 api-key 头） */
  QDRANT_API_KEY: z.string().optional().default(''),
  /** 集合名。换 Embedding 模型时应换一个新集合名，而不是复用（维度不同无法共用） */
  QDRANT_COLLECTION: z.string().default('qz_knowledge'),
  QDRANT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
  /**
   * 地图服务驱动。
   *
   * `mock`（默认）走 `MockMapProvider`：距离按「直线 × 1.4」估算、坐标是 `(0, 0)`，
   * 响应会带 `X-Provider: mock` 并在界面亮"演示模式"角标（红线 10）。
   * 要用真实路线必须显式改成 `amap` **并**填 `AMAP_WEB_KEY`。
   */
  MAP_DRIVER: z.enum(['mock', 'amap']).default('mock'),
  /**
   * 高德**Web 服务**（WebService）key。
   *
   * ⚠️ **不是**「Web端(JS API)」的 key，**也不是**「微信小程序」的 key ——
   * 那两种在服务端调用会被拒（返回 `INVALID_USER_SCODE`，而报错信息里
   * 看不出是"key 类型选错了"，很容易以为是代码写错了）。
   * ⚠️ 它**只在服务端**使用，绝不能下发到小程序（前端明文 key 会被嗅探）。
   */
  AMAP_WEB_KEY: z.string().default(''),
  AMAP_TIMEOUT_MS: z.coerce.number().int().min(1000).default(8000),

  /**
   * 一次检索取回多少条切片。
   *
   * 不是越大越好：切片越多，塞给 LLM 的上下文越长、越贵、越容易被无关内容带偏。
   * 5 是"能覆盖一个问题的多个侧面"与"不淹没模型"之间的折中。
   */
  RAG_TOP_K: z.coerce.number().int().min(1).max(20).default(5),
  /**
   * 相似度下限（Cosine，0~1）。
   *
   * ⚠️ 它的作用是**让"检索不到"变成一件可说出口的事**：
   * 没有阈值时，即使知识库里完全没有相关内容，也会硬塞 5 条最不相关的切片给模型，
   * 模型再据此"编"出一个答案。有了阈值，命中为空就如实回答"知识库里没有相关内容"。
   */
  RAG_SCORE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.35),
  /** 单切片字符数（中文场景 1 字 ≈ 1 token 量级） */
  RAG_CHUNK_SIZE: z.coerce.number().int().min(100).max(2000).default(500),
  /** 相邻切片重叠字符数，防止一句话正好被切断而语义丢失 */
  RAG_CHUNK_OVERLAP: z.coerce.number().int().min(0).max(500).default(80),

  // 转换隔离服务
  CONVERT_SERVICE_URL: z.string().optional().default(''),
  CONVERT_SERVICE_TIMEOUT_MS: z.coerce.number().int().default(120000),

  /**
   * PDF 能力服务（services/pdf）。
   *
   * 引擎 PyMuPDF 是 AGPL-3.0，只能独立安装 + 子进程调用；
   * `PYMUPDF_BIN` 由**侧车自己**读取（它才是发起子进程的一方），
   * 这里只需要知道侧车的地址 —— 与 CONVERT_SERVICE_URL 同构。
   */
  PDF_SERVICE_URL: z.string().optional().default(''),
  PDF_SERVICE_TIMEOUT_MS: z.coerce.number().int().default(120000),
  /**
   * 文档解析引擎：`legacy` = PyMuPDF 取文本（默认）；`docling` = 版面/表格/阅读顺序理解（Markdown）。
   *
   * 切 `docling` 的前提：services/pdf 侧车已安装 docling 依赖
   * （pip install docling，MIT，见 services/pdf/requirements.txt）；
   * 首次解析会自动下载模型（约数百 MB）到 DOCLING_ARTIFACTS_PATH。
   * 依赖未装时侧车返回 501 与安装指引（红线 10），不会静默降级。
   */
  DOC_PARSER_PROVIDER: z.enum(['legacy', 'docling']).default('legacy'),
  /**
   * PDF 操作（合并/拆分/压缩）的引擎选择：`sidecar` = services/pdf（默认）；`stirling` = Stirling-PDF。
   *
   * ⚠️ 与 `DOC_PARSER_PROVIDER` 是**两个维度**，不要混：本变量只管 `PdfProvider`
   * 的实现选择（操作类），文档解析（docParse，解析类）始终走 services/pdf 侧车 ——
   * Stirling 社区版没有与 `DocParseProvider` 等价的稳定端点。
   * 选了 stirling 但 `STIRLING_SERVICE_URL` 为空时回落 sidecar 逻辑（"配了才真"）。
   */
  PDF_PROVIDER: z.enum(['sidecar', 'stirling']).default('sidecar'),
  /** Stirling-PDF 服务地址（自托管，社区版即可，如 http://localhost:8080）。留空 = 不启用 */
  STIRLING_SERVICE_URL: z.string().optional().default(''),
  /** Stirling-PDF 的 API Key（服务端启用 SECURITY_CUSTOMGLOBALAPIKEY 时才需要，默认留空） */
  STIRLING_API_KEY: z.string().optional().default(''),
  STIRLING_TIMEOUT_MS: z.coerce.number().int().default(120000),

  // ---------- 仓库解读（deepwiki-open，MIT，自托管部署） ----------
  /**
   * deepwiki-open 服务地址（自托管，如 http://localhost:8005）。留空 = 不启用。
   *
   * 未配置时 `explain_repository` 工具回落 `mock-repo`（产物通篇标注演示性质，
   * 红线 10），seed 里该工具保持 `planned`；部署并配置后才转 `active`。
   */
  DEEPWIKI_BASE_URL: z.string().optional().default(''),
  /**
   * 单次仓库解读请求超时（毫秒）。
   *
   * ⚠️ 文档生成是分钟级任务（远大于小程序 30s 请求超时），因此该工具
   * **必须** `sync: false` 走异步作业（与 generate_ppt 同类），由进度通道汇报；
   * 不要试图把这个值压进 30s —— 那只会把正常任务判成超时。
   */
  DEEPWIKI_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120000),
  /** 可选 Bearer 凭证（自托管实例开启了鉴权时才需要）；不配则不发 Authorization 头 */
  DEEPWIKI_API_KEY: z.string().optional().default(''),

  /**
   * 侧车（services/ai、services/media）的客户端超时。
   *
   * ⚠️ 两个值量级不同，**不要合并成一个**：
   *   · AI（抠图）—— 首次调用要加载 u2net 的 ONNX 权重（秒级），之后单张图秒级；
   *   · 媒体（转码/压缩）—— 分钟级。设成 120s 会让"正常的十分钟视频压缩"被判成超时。
   */
  AI_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120000),
  MEDIA_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(600000),
  /**
   * 人声分离（`/ai/separation`）单独的超时。
   *
   * 它与抠图（`AI_SERVICE_TIMEOUT_MS`，秒级）差三个数量级：Demucs 在 CPU 上
   * 大约要跑"音频时长的 1~3 倍"，一首 4 分钟的歌就是几分钟。
   * 复用 120s 会把**正常且最终会成功**的分离判成超时 —— 用户看到"处理超时"，
   * 会以为是文件有问题，而实际上只是这个值太小。
   */
  AI_SEPARATION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(900000),

  // ---------- 内容安全（M4-05，红线：必须走微信官方接口） ----------
  /**
   * `wechat` = 调微信内容安全 API（生产必须）；`mock` = 仅本地开发。
   *
   * ⚠️ 默认 `mock` 是为了让本地无凭证也能跑通链路，**但生产环境必须是 wechat**。
   * 这里的取舍是明确的：内容审核是合规义务，`mock` 只能做"明显脏词"的粗筛，
   * 无法替代官方接口的图片与变体识别。
   */
  MODERATION_DRIVER: z.enum(['mock', 'wechat']).default('mock'),
  /**
   * 微信内容安全场景值：1 资料 / 2 评论 / 3 论坛 / 4 社交日志。
   * 校园驿站的任务正文与评论属于「论坛」类，故默认 3。
   */
  MODERATION_SCENE: z.coerce.number().int().min(1).max(4).default(3),
  MODERATION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),
  /**
   * access_token 提前刷新窗口（秒）。token 有效期 7200s，
   * 踩在边界上刷新会遇到"刚拿到就过期"，留 5 分钟余量。
   */
  MODERATION_TOKEN_REFRESH_AHEAD_SEC: z.coerce.number().int().min(60).default(300),
  /**
   * 自建补充词库（逗号分隔）。
   *
   * 用途**仅限补充**官方接口覆盖不到的校园特定用语（如代考、代写、刷单的变体）。
   * 绝不作为主判据 —— 词库永远有漏网之鱼，而漏一次的代价是合规事故。
   */
  MODERATION_EXTRA_WORDS: z.string().optional().default(''),

  // ---------- 搜索（M4-07） ----------
  /**
   * `mysql` = MySQL FULLTEXT（需先跑索引迁移）；`mock` = 内存子串匹配。
   *
   * 默认 `mock`：切 `mysql` 前必须已经执行 FULLTEXT 索引迁移，
   * 否则查询会直接抛 SQL 错误 —— 让这个切换**显式发生**，
   * 而不是靠"看起来变了其实没变"的隐式默认值。
   */
  SEARCH_DRIVER: z.enum(['mock', 'mysql']).default('mock'),
  SEARCH_TIMEOUT_MS: z.coerce.number().int().min(1000).default(5000),

  // ---------- 短信（厂商未选型，先提供与厂商无关的网关适配器） ----------
  SMS_DRIVER: z.enum(['mock', 'http']).default('mock'),
  SMS_GATEWAY_URL: z.string().optional().default(''),
  SMS_GATEWAY_TOKEN: z.string().optional().default(''),
  /** 网关请求体的字段名。不同网关对手机号/模板/参数的命名各不相同，做成可配 */
  SMS_GATEWAY_PHONE_FIELD: z.string().default('phone'),
  SMS_GATEWAY_TEMPLATE_FIELD: z.string().default('templateCode'),
  SMS_GATEWAY_PARAMS_FIELD: z.string().default('params'),
  SMS_TIMEOUT_MS: z.coerce.number().int().min(1000).default(8000),

  // 限流与配额
  THROTTLE_TTL: z.coerce.number().int().default(60),
  THROTTLE_LIMIT: z.coerce.number().int().default(120),
  MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).default(2),

  // 日志
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('debug'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('pretty'),
  LOG_MASK_SENSITIVE: envBoolean(true),

  // 后台
  ADMIN_ORIGIN: z.string().default('http://localhost:5173'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  // ---------- 积分计费总开关（M1-06） ----------
  /**
   * 是否启用积分计费。
   *
   * `false`（**前期默认**）= 免费开放：不预扣、不结清、不退回，也不写积分流水，
   * 用户可免费使用全部工具。`true` = 按积分计费（M1-06 的完整三条路径）。
   *
   * 为什么做成环境开关而不是删代码：计费是"能力"而不是"阶段性的临时代码"，
   * 删掉会连带丢掉流水、幂等、对账与三条路径的测试；而它只在 BillingService 一个地方生效，
   * 关掉即彻底不影响业务。将来要收费，改这一个变量即可，**无需改代码、无需改数据**。
   */
  BILLING_ENABLED: envBoolean(false),

  // 业务参数
  PLATFORM_FEE_RATE: z.coerce.number().min(0).max(1).default(0.05),
  PLATFORM_FEE_CAP_CENTS: z.coerce.number().int().min(0).default(2000),
  ORDER_PAY_TIMEOUT_MINUTES: z.coerce.number().int().default(30),
  ORDER_AUTO_ACCEPT_DAYS: z.coerce.number().int().default(7),
  UPLOAD_MAX_IMAGE_MB: z.coerce.number().int().default(20),
  UPLOAD_MAX_VIDEO_MB: z.coerce.number().int().default(500),
  UPLOAD_MAX_DOC_MB: z.coerce.number().int().default(100),
  FILE_RETENTION_DAYS: z.coerce.number().int().default(30),
});

export type AppEnv = z.infer<typeof EnvSchema>;

/** 以输入对象为键的记忆化缓存，避免 validate 与 load 重复解析同一份 env */
const validatedCache = new WeakMap<object, AppEnv>();

/**
 * 跨字段约束：**单次超时不得大于总预算**。
 *
 * ## 为什么必须在启动期拦下（2026-09-18 实测踩坑）
 *
 * `TimeBudget.attemptTimeout()` 取「单次超时」与「剩余预算」的较小值，
 * 所以 `单次超时 > 总预算` 时，**第一次尝试就会吃掉全部预算**：
 * 等它超时回来，`canAttempt()` 已为 false —— 既不重试、也不降级。
 * 用户看到的是"AI 服务繁忙"，而真实原因只是**一次本可靠重试救回的连接挂起**。
 *
 * 实测指纹：作业耗时 **45.028s**（= 总预算）且日志里**没有**降级记录。
 * ASR 侧此前已按这个约束配好（20s ≤ 25s），LLM 侧漏了（60s > 45s）。
 */
function assertTimeoutWithinBudget(env: AppEnv): void {
  const pairs = [
    {
      per: 'LLM_TIMEOUT_MS',
      perMs: env.LLM_TIMEOUT_MS,
      total: 'LLM_TOTAL_BUDGET_MS',
      totalMs: env.LLM_TOTAL_BUDGET_MS,
    },
    {
      per: 'ASR_TIMEOUT_MS',
      perMs: env.ASR_TIMEOUT_MS,
      total: 'ASR_TOTAL_BUDGET_MS',
      totalMs: env.ASR_TOTAL_BUDGET_MS,
    },
  ];
  const bad = pairs.filter((p) => p.perMs > p.totalMs);
  if (!bad.length) return;

  const lines = bad
    .map(
      (p) =>
        `  - ${p.per}(${p.perMs}ms) > ${p.total}(${p.totalMs}ms)：单次超时会吃掉全部预算，重试与降级都会失效`,
    )
    .join('\n');
  throw new Error(`环境变量校验失败，请检查 .env：\n${lines}`);
}

/**
 * 跨端约束：**服务端总预算必须小于客户端请求超时**。
 *
 * ## 这个断言拦的是什么（A2 超时预算倒挂）
 *
 * 小程序 `rawRequest` 默认 30s 超时（`apps/mp/utils/request.ts`）。
 * 若服务端 `LLM_TOTAL_BUDGET_MS` 比它大，就会出现一种**极难排查**的现象：
 *
 * ```
 * 用户视角：点了生成 → 30 秒后提示"请求超时 / 网络异常" → 以为失败了
 * 服务端：请求仍在跑，45 秒时才刚跑完 → 产物落库、还扣了费
 * ```
 *
 * 用户看到失败，账上却少了钱、文件里还多了个产物 —— 这是最坏的一类不一致：
 * **客户端判失败、服务端判成功**，两边谁都不知道对方怎么想。
 *
 * ## 为什么留 5 秒余量而不是"小于等于"
 *
 * 服务端预算耗尽到返回响应之间还有序列化、鉴权、网络往返等开销。
 * 贴着上限配（如预算 29s / 超时 30s）会让"服务端刚好跑完"的请求仍在客户端超时，
 * 因此要求服务端至少留 5 秒给响应回程。
 *
 * ## 为什么不直接把客户端超时调大
 *
 * 那是把问题推给用户（更长的白等），而不是修问题。正确方向是让服务端的最坏耗时
 * 落在用户可接受的等待内；确需更长时应把工具改为异步（`sync: false`），
 * 由进度通道汇报，而不是让一次 HTTP 请求挂着。
 */
function assertBudgetWithinClientTimeout(env: AppEnv): void {
  /** 小程序 `rawRequest` 的默认超时，改这里必须同步改 request.ts */
  const CLIENT_TIMEOUT_MS = 30000;
  /** 给响应回程留的余量 */
  const HEADROOM_MS = 5000;
  const limit = CLIENT_TIMEOUT_MS - HEADROOM_MS;

  const pairs = [
    { name: 'LLM_TOTAL_BUDGET_MS', value: env.LLM_TOTAL_BUDGET_MS },
    { name: 'ASR_TOTAL_BUDGET_MS', value: env.ASR_TOTAL_BUDGET_MS },
  ];
  // 未启用 ASR（预算为 0 或未配）时跳过，避免对关掉的功能报错
  const bad = pairs.filter((p) => p.value > 0 && p.value > limit);
  if (!bad.length) return;

  const lines = bad
    .map(
      (p) =>
        `  - ${p.name}(${p.value}ms) 大于客户端超时余量(${limit}ms)：` +
        '用户在客户端会先看到失败，而服务端仍在跑并可能落库扣费',
    )
    .join('\n');
  throw new Error(
    `环境变量校验失败，请检查 .env：\n${lines}\n` +
      `  客户端超时 ${CLIENT_TIMEOUT_MS}ms（apps/mp/utils/request.ts），` +
      `需留 ${HEADROOM_MS}ms 回程余量；` +
      '要么调小预算，要么把该工具改为异步（sync: false）',
  );
}
/**
 * 校验环境变量；失败时抛出包含全部缺失/非法变量名的错误。
 */
export function validateEnv(raw: Record<string, unknown>): AppEnv {
  const cached = validatedCache.get(raw);
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`环境变量校验失败，请检查 .env：\n${issues}`);
  }
  assertTimeoutWithinBudget(parsed.data);
  assertBudgetWithinClientTimeout(parsed.data);
  validatedCache.set(raw, parsed.data);
  return parsed.data;
}

/**
 * 取已校验的环境变量快照。
 * ConfigModule 会先把 .env 注入 process.env，再调用 validate / load，
 * 因此这里读到的就是 dotenv 合并后的结果（同一对象 → 命中缓存，不重复解析）。
 */
export function getValidatedEnv(): AppEnv {
  return validateEnv(process.env as unknown as Record<string, unknown>);
}
