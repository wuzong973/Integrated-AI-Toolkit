import type { AppEnv } from './env.schema';

/**
 * 配置装配（任务清单 M0-05）
 * 纪律：业务代码通过 ConfigService 读取配置，禁止直接读 process.env。
 *
 * 类型定义与解析实现**分开放**：本文件只声明"配置长什么样"，
 * 解析逻辑在 `configuration.ts`（单文件 ≤300 行红线，见 .eslintrc.cjs）。
 */
export interface AppConfig {
  env: AppEnv['NODE_ENV'];
  port: number;
  apiPrefix: string;
  version: string;
  providerMode: AppEnv['PROVIDER_MODE'];

  db: { url: string; shadowUrl: string; poolMax: number };
  redis: { url: string; queueDriver: AppEnv['QUEUE_DRIVER'] };

  queue: {
    /** 单队列并发数（QUEUE_WORKER_CONCURRENCY） */
    concurrency: number;
    /** 最大投递次数，超过进死信 */
    maxAttempts: number;
    /** 认领空闲阈值（毫秒）：Worker 强杀后任务多久重回队列 */
    claimIdleMs: number;
    /** queued 超过该时长即视为投递丢失，重新投递 */
    orphanQueuedMs: number;
  };

  storage: {
    driver: AppEnv['STORAGE_DRIVER'];
    /** local 驱动的落盘目录 */
    localDir: string;
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    presignExpire: number;
    publicBaseUrl: string;
  };

  jwt: { secret: string; accessExpire: string; refreshExpire: string };

  wechat: {
    appid: string;
    secret: string;
    code2SessionUrl: string;
    templates: { task: string; order: string; job: string };
    /**
     * 是否**强制**走开发模式的伪 openid（即使已配好真实 AppSecret）。
     *
     * 为什么要跟 `secret` 解耦：本地自测与端到端脚本都用假 code 登录，
     * 而一旦填了真 Secret，假 code 会被微信拒（`40029`）—— 于是"配好了反而没法验证"。
     * ⚠️ `NODE_ENV=production` 时**强制失效**（见 `WechatService.useDevLogin`）。
     */
    devLogin: boolean;
    /**
     * 是否接受**测试夹具 code**（`qz-dev:` 前缀）换取伪 openid。
     *
     * 为什么还要有它：`verify:*` 端到端脚本靠假 code 登录取 token，而 `devLogin`
     * 一旦关掉（= 真实微信登录接通）这些脚本就全停在 `❌ 登录（HTTP 401）`。
     * 用前缀而不是用开关，是为了让「真实登录」和「脚本能跑」**同时成立**：
     * 小程序传来的真实 code 不含冒号，永远不会误入这条通道。
     * ⚠️ 仅非生产生效；比 `devLogin`（任意 code 都能登录）窄得多。
     */
    fixtureLogin: boolean;
  };

  wechatPay: {
    mchid: string;
    serialNo: string;
    privateKeyPath: string;
    apiv3Key: string;
    notifyUrl: string;
    /** 是否已完整配置（未配置则降级为 MockPayProvider） */
    enabled: boolean;
  };

  llm: {
    driver: AppEnv['LLM_DRIVER'];
    baseUrl: string;
    apiKey: string;
    models: { intent: string; generate: string; plan: string };
    timeoutMs: number;
    /**
     * **单次逻辑调用**的总时间预算（毫秒），覆盖"所有模型 × 所有重试 × 所有退避"的总和。
     *
     * 不加这个上限时，超时是乘法放大的：`模型数 × (重试次数 × timeoutMs + 退避)`，
     * 按默认值算最坏 **370 秒**，而小程序请求超时只有 30 秒 ——
     * 前端早已断开，后端还在打满供应商配额。详见 `env.schema.ts` 的注释。
     */
    totalBudgetMs: number;
    maxRetry: number;
    /**
     * 降级模型列表（可选，来自 `LLM_FALLBACK_MODELS`）。
     * 主模型重试耗尽后按顺序再试，用于扛住免费档的 `429 + code 1305` 过载。
     */
    fallbackModels: string[];
    /**
     * 推理深度。**为空表示不发送该字段**。
     *
     * ⚠️ 取值是实测得出的：智谱 GLM flash 系列只认 `low` / `high` / `max`，
     * 传 `medium` / `minimal` 会被 400 拒绝（`code 1210`）。
     * 因此这里**刻意不含 medium** —— 让配置错误在启动时就暴露。
     */
    reasoningEffort: '' | 'low' | 'high' | 'max';
    /**
     * 是否**允许**发送 `thinking:{type:'disabled'}`。
     * ⚠️ 语义是"允不允许发参数"，不是"要不要思考" —— 关不关由调用方
     * （`LlmCallOptions.disableThinking`）决定。换到不兼容端点时设
     * `LLM_DISABLE_THINKING=false` 即可。
     */
    disableThinking: boolean;
    /** 是否已配置 Key（未配置则降级为 MockLlmProvider） */
    enabled: boolean;
  };

  ai: {
    serviceUrl: string;
    mediaServiceUrl: string;
    rembgModel: string;
    vocalSeparationEngine: AppEnv['VOCAL_SEPARATION_ENGINE'];
    whisperModel: string;
    gpuConcurrency: number;
    /**
     * 侧车连通参数。
     *
     * `timeoutMs` 两个服务的量级完全不同，**不能共用一个值**：
     *   · ai（抠图）—— 单张图秒级，120s 足够；
     *   · media（转码/压缩）—— 分钟级，600s 才合理。
     * 用 120s 卡转码会让"正常的十分钟视频压缩"被判成超时失败。
     */
    timeoutMs: number;
    mediaTimeoutMs: number;
    /**
     * 人声分离的超时（第三个量级）。
     *
     * 与抠图（秒级）、媒体转码（分钟级）都不同：Demucs 在 CPU 上要跑
     * "音频时长的 1~3 倍"，所以必须独立配置，否则会被前两者的值误判成超时。
     */
    separationTimeoutMs: number;
    /** AI 侧车是否已配置地址（未配置则抠图能力明确不可用，不回退假实现） */
    enabled: boolean;
    /** 媒体侧车是否已配置地址 */
    mediaEnabled: boolean;
    /**
     * 分享图渲染（Mermaid / markmap → PNG）是否开启。
     *
     * 由 `RENDER_PROVIDER` 决定：`playwright` = media 侧车截图出图；
     * `mock`（默认）= 不渲染、不新增产物，`generate_mindmap` 只交付文本产物。
     * 开启前提：媒体侧车已安装 playwright + chromium + 中文字体（requirements.txt 有指引）。
     */
    renderEnabled: boolean;
  };

  /**
   * 内容安全（M4-05）—— **必须走微信内容安全 API**，不能用 LLM 提示词代替。
   *
   * 设计文档把这一条列为红线，原因是 LLM 的判断是概率性的、可被绕过的，
   * 而内容安全是**合规义务**：出事时要能拿出"我们调用了官方接口"的证据。
   * 自建词库只作为**补充**（校园场景的特定用语官方词库覆盖不到），
   * 不作为主判据，也绝不能替代官方接口。
   */
  moderation: {
    driver: AppEnv['MODERATION_DRIVER'];
    /** 复用微信小程序的 AppID / Secret（内容安全接口同一套凭证） */
    appid: string;
    secret: string;
    /** 场景值：1 资料 / 2 评论 / 3 论坛 / 4 社交日志 */
    scene: number;
    timeoutMs: number;
    /** access_token 有效期 7200s，提前这么久刷新，避免边界上用到过期 token */
    tokenRefreshAheadSec: number;
    /** 自建补充词库（逗号分隔，来自 MODERATION_EXTRA_WORDS） */
    extraWords: string[];
    /** appid + secret 齐备时为 true；否则降级为词库模式并打 mock 标 */
    enabled: boolean;
  };

  /**
   * 搜索（M4-07）。
   *
   * 选型结论：**MySQL FULLTEXT 起步**（零新组件，ADR-13 已经因为改用 MySQL
   * 而把全文检索定为 FULLTEXT 路线）。Meilisearch / ES 留作后续替换 ——
   * 接口不变，只换 driver。
   *
   * ⚠️ 默认 `mock`：`mysql` 需要先跑 FULLTEXT 索引迁移（见
   * `apps/api/prisma/migrations/` 的 `*_add_fulltext_indexes`）。
   * 没跑迁移就切 mysql 会直接抛 SQL 错误，所以开关必须显式。
   */
  search: {
    driver: AppEnv['SEARCH_DRIVER'];
    /** 单次检索超时（全表 LIKE 的兜底保护） */
    timeoutMs: number;
  };

  /**
   * 短信（M1-09 的依赖）。
   *
   * ⚠️ 服务商**尚未选型**。这里只提供与厂商无关的 HTTP 网关适配器：
   * 阿里云 / 腾讯云需要各自带签名的适配器，届时在同一接口下新增实现即可，
   * 业务代码不用改。
   */
  sms: {
    driver: AppEnv['SMS_DRIVER'];
    /** 通用 HTTP 网关：POST JSON，字段名可配 */
    gatewayUrl: string;
    /** 网关鉴权用的 Bearer Token（留空表示网关不校验） */
    gatewayToken: string;
    /** 网关请求体里的字段名映射 */
    fields: { phone: string; template: string; params: string };
    timeoutMs: number;
    /** 网关地址非空时为 true；否则保持 mock-sms 并在 /health 打标 */
    enabled: boolean;
  };

  /**
   * 视觉多模态（OCR / 图片理解）。
   * 与 `llm` 完全独立：`OpenAiCompatibleLlmProvider` 的 content 是 string，
   * 表达不了图像的多段 content，所以必须单开一条链路。
   */
  vlm: {
    /**
     * 实现选择：`cloud` = 硅基流动 VLM（默认）；`selfhost` = AI 侧车 PaddleOCR。
     * selfhost 要求 `AI_SERVICE_URL` 已配置且侧车依赖已装（services/ai/requirements.txt），
     * 未配置地址时回落 MockOcrProvider 并打 mock 标（"配了才真"，红线 10）。
     */
    driver: 'cloud' | 'selfhost';
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    maxRetry: number;
    /**
     * 是否向视觉模型发送 `enable_thinking`。
     * `undefined` = 不发送（默认，对任何模型都安全）；
     * 仅混合思考模型（Qwen3.5 / Qwen3-VL）需显式设 false 以关闭推理。
     */
    enableThinking: boolean | undefined;
    /** 是否已配置 Key（未配置则降级为 MockOcrProvider） */
    enabled: boolean;
  };

  /** 语音转文字（默认硅基流动 `/audio/transcriptions`，`selfhost` 走 AI 侧车 faster-whisper） */
  asr: {
    /**
     * 实现选择：`cloud` = 硅基流动（默认）；`selfhost` = AI 侧车 faster-whisper。
     * selfhost 要求 `AI_SERVICE_URL` 已配置，未配置时回落 Mock（"配了才真"，红线 10）。
     */
    driver: 'cloud' | 'selfhost';
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    /** 额外重试次数（不含首次）。挂起是间歇性的，重试即成功，见 env.schema 注释 */
    maxRetry: number;
    /** 单次逻辑调用的总预算，保证 `重试 × timeoutMs` 不超出小程序请求超时 */
    totalBudgetMs: number;
    enabled: boolean;
  };

  /**
   * 向量化 —— 硅基流动 `/embeddings`（与 OCR / 语音共用同一 Key）。
   * 消费方是 `KnowledgeModule`（M4-06 校园知识库）：灌库切片与检索查询都要向量化。
   */
  embedding: {
    baseUrl: string;
    apiKey: string;
    model: string;
    /** 向量维度，必须与模型真实维度一致（bge-m3 = 1024） */
    dimension: number;
    timeoutMs: number;
    maxRetry: number;
    enabled: boolean;
  };

  /**
   * 向量库（RAG 检索，M4-06）。
   *
   * 与 `embedding` 是**两件事**：embedding 负责"文本 → 向量"，
   * vector 负责"向量存哪儿、怎么找最近的"。前者是模型服务，后者是数据库。
   * 分开配置才能单独替换任意一侧（如换 Embedding 模型但继续用同一个 Qdrant）。
   */
  vector: {
    driver: 'mock' | 'qdrant';
    url: string;
    apiKey: string;
    collection: string;
    timeoutMs: number;
    /** driver === 'qdrant' 时为 true；否则回退 mock-vector 并打标（红线 10） */
    enabled: boolean;
  };

  /**
   * 地图 / 位置服务（高德 Web 服务）。
   *
   * ⚠️ `key` 只存在于服务端。小程序端**不需要**任何地图 key ——
   * 微信 `<map>` 组件本身就是腾讯地图，零 key。
   */
  map: {
    driver: 'mock' | 'amap';
    /** 高德 Web 服务 key（**不是** Web端 JS API / 小程序的 key） */
    key: string;
    timeoutMs: number;
    /** driver === 'amap' **且** key 非空时为 true；否则回退 mock-map 并打标（红线 10） */
    enabled: boolean;
  };

  /** RAG 检索与切片参数 */
  rag: {
    /** 一次检索取回多少条切片 */
    topK: number;
    /** 相似度下限，低于它的切片一律不送进模型（避免"检索不到却硬答"） */
    scoreThreshold: number;
    /** 单切片字符数 */
    chunkSize: number;
    /** 相邻切片的重叠字符数（防止一句话被切断而语义丢失） */
    chunkOverlap: number;
  };

  convert: { serviceUrl: string; timeoutMs: number; enabled: boolean };

  /**
   * 仓库解读服务（deepwiki-open，MIT，自托管部署，只调 REST）。
   *
   * 与 `convert` 同一套"配了才真"纪律：`DEEPWIKI_BASE_URL` 为空时
   * `enabled` 为 false → 回退 `MockRepoProvider`（产物通篇标注演示性质），
   * seed 里的 `explain_repository` 保持 `planned`；
   * 部署并配置后 Provider 转真、seed 才转 `active`。
   */
  repo: { baseUrl: string; timeoutMs: number; apiKey: string; enabled: boolean };

  /**
   * PDF 能力服务。
   *
   * 与 `convert` 同一套纪律：AGPL 引擎必须独立部署，
   * `serviceUrl` 为空时 `enabled` 为 false → 回退 `MockPdfProvider`（它故意抛错）。
   *
   * ⚠️ 这里有两个**互相独立**的维度，不要混：
   *   · `provider`（`PDF_PROVIDER`）—— **操作类**（合并/拆分/压缩，`PdfProvider`）的实现选择：
   *     sidecar = services/pdf（默认）；stirling = Stirling-PDF（自托管，MIT 主许可，只调 REST）。
   *   · `driver`（`DOC_PARSER_PROVIDER`）—— **解析类**（`docParse`）的引擎选择：
   *     legacy = PyMuPDF 取文本，docling = 版面/表格/阅读顺序理解（MIT 引擎，输出 Markdown）。
   * docParse 始终走 services/pdf 侧车 —— Stirling 社区版没有与 `DocParseProvider`
   * 等价的稳定端点，所以解析能力不随 `provider` 切换。
   */
  pdf: {
    /** services/pdf 侧车地址（`PDF_SERVICE_URL`）；`enabled` 只看它是否非空 */
    serviceUrl: string;
    timeoutMs: number;
    enabled: boolean;
    driver: 'legacy' | 'docling';
    provider: 'sidecar' | 'stirling';
    /** Stirling-PDF 连接参数；`provider === 'stirling'` 且 `stirling.serviceUrl` 非空时生效 */
    stirling: { serviceUrl: string; apiKey: string; timeoutMs: number };
  };

  throttle: { ttl: number; limit: number };
  maxConcurrentRuns: number;

  billing: {
    /**
     * 积分计费总开关。`false` = 免费开放（前期默认），`true` = 按积分计费。
     *
     * 注意：`false` 时**作业的 `cost` 字段仍记录工具标价**（用于审计
     * "免费期让利了多少"），只是不发生任何积分变动。详见 docs/dev/BILLING-MODES.md。
     */
    enabled: boolean;
  };

  log: { level: AppEnv['LOG_LEVEL']; format: AppEnv['LOG_FORMAT']; maskSensitive: boolean };

  adminOrigin: string;
  corsOrigins: string[];

  business: {
    platformFeeRate: number;
    platformFeeCapCents: number;
    orderPayTimeoutMinutes: number;
    orderAutoAcceptDays: number;
    uploadMaxImageMb: number;
    uploadMaxVideoMb: number;
    uploadMaxDocMb: number;
    fileRetentionDays: number;
  };
}
