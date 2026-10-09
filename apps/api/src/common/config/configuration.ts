import type { AppConfig } from './config.types';
import type { AppEnv } from './env.schema';
import { anchorToAppRoot } from './paths';

// 路径解析（APP_ROOT / anchorToAppRoot / ENV_FILE_PATHS）已移至 ./paths.ts
// —— "把相对路径锚定成绝对路径"是一个独立关注点，且自带一段踩坑史，单独成文件更清楚。

/**
 * 配置装配（任务清单 M0-05）
 * 纪律：业务代码通过 ConfigService 读取配置，禁止直接读 process.env。
 *
 * `AppConfig` 类型定义已移至 `./config.types.ts`，这里原样再导出，
 * 既有 `import { AppConfig } from './configuration'` 的调用方无需改动。
 */
export type { AppConfig } from './config.types';

export function buildConfig(env: AppEnv): AppConfig {
  return {
    env: env.NODE_ENV,
    port: env.PORT,
    apiPrefix: env.API_PREFIX,
    version: env.APP_VERSION,
    providerMode: env.PROVIDER_MODE,
    db: buildDb(env),
    redis: { url: env.REDIS_URL, queueDriver: env.QUEUE_DRIVER },
    queue: {
      concurrency: env.QUEUE_WORKER_CONCURRENCY,
      maxAttempts: env.QUEUE_MAX_ATTEMPTS,
      claimIdleMs: env.QUEUE_CLAIM_IDLE_MS,
      orphanQueuedMs: env.QUEUE_ORPHAN_QUEUED_MS,
    },
    storage: buildStorage(env),
    jwt: {
      secret: env.JWT_SECRET,
      accessExpire: env.JWT_ACCESS_EXPIRE,
      refreshExpire: env.JWT_REFRESH_EXPIRE,
    },
    wechat: buildWechat(env),
    wechatPay: buildWechatPay(env),
    llm: buildLlm(env),
    vlm: buildVlm(env),
    asr: buildAsr(env),
    embedding: buildEmbedding(env),
    vector: buildVector(env),
    map: buildMap(env),
    rag: {
      topK: env.RAG_TOP_K,
      scoreThreshold: env.RAG_SCORE_THRESHOLD,
      chunkSize: env.RAG_CHUNK_SIZE,
      chunkOverlap: env.RAG_CHUNK_OVERLAP,
    },
    ai: {
      serviceUrl: env.AI_SERVICE_URL,
      mediaServiceUrl: env.MEDIA_SERVICE_URL,
      rembgModel: env.REMBG_MODEL,
      vocalSeparationEngine: env.VOCAL_SEPARATION_ENGINE,
      whisperModel: env.WHISPER_MODEL,
      gpuConcurrency: env.GPU_CONCURRENCY,
      timeoutMs: env.AI_SERVICE_TIMEOUT_MS,
      mediaTimeoutMs: env.MEDIA_SERVICE_TIMEOUT_MS,
      separationTimeoutMs: env.AI_SEPARATION_TIMEOUT_MS,
      enabled: !!env.AI_SERVICE_URL.trim(),
      mediaEnabled: !!env.MEDIA_SERVICE_URL.trim(),
      // 分享图渲染：RENDER_PROVIDER=playwright 且媒体侧车地址已配置才开启（"配了才真"）
      renderEnabled: env.RENDER_PROVIDER === 'playwright' && !!env.MEDIA_SERVICE_URL.trim(),
    },
    moderation: buildModeration(env),
    search: { driver: env.SEARCH_DRIVER, timeoutMs: env.SEARCH_TIMEOUT_MS },
    sms: buildSms(env),
    convert: buildConvert(env),
    repo: buildRepo(env),
    pdf: buildPdf(env),
    throttle: { ttl: env.THROTTLE_TTL, limit: env.THROTTLE_LIMIT },
    maxConcurrentRuns: env.MAX_CONCURRENT_RUNS,
    billing: { enabled: env.BILLING_ENABLED },
    log: { level: env.LOG_LEVEL, format: env.LOG_FORMAT, maskSensitive: env.LOG_MASK_SENSITIVE },
    adminOrigin: env.ADMIN_ORIGIN,
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
    business: buildBusiness(env),
  };
}

// ---------- 各分组构造（把长函数拆开，便于阅读与单测） ----------

function buildDb(env: AppEnv): AppConfig['db'] {
  return { url: env.DATABASE_URL, shadowUrl: env.SHADOW_DATABASE_URL, poolMax: env.DB_POOL_MAX };
}

function buildStorage(env: AppEnv): AppConfig['storage'] {
  return {
    driver: env.STORAGE_DRIVER,
    // ⚠️ 必须锚定，不能用裸相对路径 —— 否则存储根随 process.cwd() 漂移，
    // 表现为"文件在磁盘上、数据库也有记录，下载却 404"（详见文件头注释）。
    localDir: anchorToAppRoot(env.LOCAL_STORAGE_DIR),
    endpoint: env.STORAGE_ENDPOINT,
    region: env.STORAGE_REGION,
    bucket: env.STORAGE_BUCKET,
    accessKey: env.STORAGE_ACCESS_KEY,
    secretKey: env.STORAGE_SECRET_KEY,
    presignExpire: env.STORAGE_PRESIGN_EXPIRE,
    publicBaseUrl: env.STORAGE_PUBLIC_BASE_URL ?? '',
  };
}

function buildWechat(env: AppEnv): AppConfig['wechat'] {
  // ⚠️ 生产环境**强制关闭**开发登录：即使误配了 `WECHAT_DEV_LOGIN=true` 也不生效，
  //    否则线上任何人都能拿一个假 code 直接登录（伪 openid 是 code 的哈希，可预测）。
  const devLogin = env.WECHAT_DEV_LOGIN && env.NODE_ENV !== 'production';
  return {
    appid: env.WECHAT_APPID,
    secret: env.WECHAT_SECRET ?? '',
    code2SessionUrl: env.WECHAT_CODE2SESSION_URL,
    templates: {
      task: env.WECHAT_SUBSCRIBE_TEMPLATE_TASK ?? '',
      order: env.WECHAT_SUBSCRIBE_TEMPLATE_ORDER ?? '',
      job: env.WECHAT_SUBSCRIBE_TEMPLATE_JOB ?? '',
    },
    devLogin,
    // 测试夹具通道：与 devLogin 同理，生产一律关闭。
    fixtureLogin: env.NODE_ENV !== 'production',
  };
}

/** 支付能力是否就绪（未就绪则降级为 MockPayProvider，ADR-04） */
function buildWechatPay(env: AppEnv): AppConfig['wechatPay'] {
  const enabled = !!(
    env.WECHAT_PAY_MCHID &&
    env.WECHAT_PAY_APIV3_KEY &&
    env.WECHAT_PAY_PRIVATE_KEY_PATH
  );
  return {
    mchid: env.WECHAT_PAY_MCHID ?? '',
    serialNo: env.WECHAT_PAY_SERIAL_NO ?? '',
    privateKeyPath: env.WECHAT_PAY_PRIVATE_KEY_PATH ?? '',
    apiv3Key: env.WECHAT_PAY_APIV3_KEY ?? '',
    notifyUrl: env.WECHAT_PAY_NOTIFY_URL ?? '',
    enabled,
  };
}

/** LLM 是否就绪（未配置 Key 则降级为 MockLlmProvider） */
function buildLlm(env: AppEnv): AppConfig['llm'] {
  const enabled = env.LLM_DRIVER === 'openai-compatible' && !!env.LLM_API_KEY;
  return {
    driver: env.LLM_DRIVER,
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY ?? '',
    models: {
      intent: env.LLM_MODEL_INTENT,
      generate: env.LLM_MODEL_GENERATE,
      plan: env.LLM_MODEL_PLAN,
    },
    timeoutMs: env.LLM_TIMEOUT_MS,
    totalBudgetMs: env.LLM_TOTAL_BUDGET_MS,
    maxRetry: env.LLM_MAX_RETRY,
    // 逗号分隔 → 数组；去空白、去重、剔除与主模型重名的（避免白试一次）
    fallbackModels: [
      ...new Set(
        (env.LLM_FALLBACK_MODELS ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ],
    reasoningEffort: env.LLM_REASONING_EFFORT,
    disableThinking: env.LLM_DISABLE_THINKING,
    enabled,
  };
}

/**
 * 视觉多模态（OCR / 图片理解）是否就绪。
 *
 * 与 LLM 相互独立：未配 Key 时降级为 MockOcrProvider 并打 mock 标记（红线 9），
 * 不影响文本能力 —— 两者可以只配其中一个。
 */
function buildVlm(env: AppEnv): AppConfig['vlm'] {
  return {
    driver: env.OCR_PROVIDER,
    baseUrl: env.SILICONFLOW_BASE_URL,
    apiKey: env.SILICONFLOW_API_KEY ?? '',
    model: env.VLM_MODEL,
    timeoutMs: env.VLM_TIMEOUT_MS,
    maxRetry: env.VLM_MAX_RETRY,
    // '' → undefined（不发送该参数）；'true'/'false' → 布尔
    enableThinking: env.VLM_ENABLE_THINKING === '' ? undefined : env.VLM_ENABLE_THINKING === 'true',
    enabled: !!env.SILICONFLOW_API_KEY,
  };
}

/** 语音转文字是否就绪（与 vlm 共用硅基流动凭证，未配 Key 则降级为 Mock） */
function buildAsr(env: AppEnv): AppConfig['asr'] {
  return {
    driver: env.ASR_PROVIDER,
    baseUrl: env.SILICONFLOW_BASE_URL,
    apiKey: env.SILICONFLOW_API_KEY ?? '',
    model: env.ASR_MODEL,
    timeoutMs: env.ASR_TIMEOUT_MS,
    maxRetry: env.ASR_MAX_RETRY,
    totalBudgetMs: env.ASR_TOTAL_BUDGET_MS,
    enabled: !!env.SILICONFLOW_API_KEY,
  };
}

/** 向量化是否就绪（与 vlm / asr 共用硅基流动凭证，未配 Key 则降级为 Mock） */
function buildEmbedding(env: AppEnv): AppConfig['embedding'] {
  return {
    baseUrl: env.SILICONFLOW_BASE_URL,
    apiKey: env.SILICONFLOW_API_KEY ?? '',
    model: env.EMBEDDING_MODEL,
    dimension: env.EMBEDDING_DIMENSION,
    timeoutMs: env.EMBEDDING_TIMEOUT_MS,
    maxRetry: env.EMBEDDING_MAX_RETRY,
    enabled: !!env.SILICONFLOW_API_KEY,
  };
}

/**
 * 向量库是否就绪。
 *
 * `VECTOR_DRIVER=qdrant` 才启用真实实现；`mock`（默认）保持 `mock-vector`。
 *
 * ⚠️ 这里**不探测 Qdrant 是否真的在跑** —— 与 Redis 队列同样的理由：
 * 启动期的可用性竞态不可靠（Qdrant 可能比 API 晚起，也可能中途重启）。
 * 连不上时由 `QdrantVectorProvider` 抛出带可执行提示的错误，
 * 而不是让整个服务起不来。
 */
function buildVector(env: AppEnv): AppConfig['vector'] {
  return {
    driver: env.VECTOR_DRIVER,
    url: env.QDRANT_URL,
    apiKey: env.QDRANT_API_KEY ?? '',
    collection: env.QDRANT_COLLECTION,
    timeoutMs: env.QDRANT_TIMEOUT_MS,
    enabled: env.VECTOR_DRIVER === 'qdrant',
  };
}

/**
 * 地图服务是否就绪。
 *
 * ⚠️ **两个条件都要满足**：`MAP_DRIVER=amap` **且** `AMAP_WEB_KEY` 非空。
 * 只改 driver 忘了填 key 的话，会得到一个"看起来已启用、但每次调用都失败"的
 * Provider —— 用户看到的是"地图服务不可用"，而真正的原因是没配 key，
 * 这种"配置错伪装成服务故障"是最难排查的一类（见 ERROR-TRIAGE）。
 *
 * 与 Qdrant 同理：这里**不探测高德是否可达**，连不上时由 Provider 抛
 * `MapServiceUnavailable`，而不是让整个服务起不来。
 */
function buildMap(env: AppEnv): AppConfig['map'] {
  return {
    driver: env.MAP_DRIVER,
    key: env.AMAP_WEB_KEY,
    timeoutMs: env.AMAP_TIMEOUT_MS,
    enabled: env.MAP_DRIVER === 'amap' && env.AMAP_WEB_KEY.length > 0,
  };
}

/** 文档转换隔离服务（文档 2.5：AGPL/GPL 必须独立部署） */ function buildConvert(
  env: AppEnv,
): AppConfig['convert'] {
  const url = env.CONVERT_SERVICE_URL ?? '';
  return {
    serviceUrl: url,
    timeoutMs: env.CONVERT_SERVICE_TIMEOUT_MS,
    enabled: !!url,
  };
}

/**
 * 仓库解读服务（deepwiki-open，MIT，自托管）。
 *
 * `enabled` 只看 `DEEPWIKI_BASE_URL` 是否非空（"配了才真"，与 convert 同构）：
 * 未配置时 RealProviderFactory 不装配 DeepWikiProvider，
 * 回落 `MockRepoProvider` 并被打上 mock 标记。
 */
function buildRepo(env: AppEnv): AppConfig['repo'] {
  const baseUrl = env.DEEPWIKI_BASE_URL ?? '';
  return {
    baseUrl,
    timeoutMs: env.DEEPWIKI_TIMEOUT_MS,
    apiKey: env.DEEPWIKI_API_KEY ?? '',
    enabled: !!baseUrl.trim(),
  };
}

/**
 * PDF 能力服务。
 *
 * `enabled` 只看侧车 URL 是否配置 —— 侧车起来但引擎（PyMuPDF）没装时，
 * 侧车的 /health 会如实标 `engineAvailable: false`，工具调用会拿到
 * "PDF 引擎未安装"的明确提示，而不是静默降级。
 *
 * `provider`（操作类引擎选择）与 `driver`（解析类引擎选择）是两个独立维度，
 * 语义见 config.types.ts 的 pdf 段注释。
 */
function buildPdf(env: AppEnv): AppConfig['pdf'] {
  const url = env.PDF_SERVICE_URL ?? '';
  return {
    serviceUrl: url,
    timeoutMs: env.PDF_SERVICE_TIMEOUT_MS,
    enabled: !!url,
    driver: env.DOC_PARSER_PROVIDER,
    provider: env.PDF_PROVIDER,
    stirling: {
      serviceUrl: env.STIRLING_SERVICE_URL ?? '',
      apiKey: env.STIRLING_API_KEY ?? '',
      timeoutMs: env.STIRLING_TIMEOUT_MS,
    },
  };
}

/**
 * 内容安全（M4-05）。
 *
 * `enabled` 的判据是 **appid + secret 齐备**，而不是"driver 配成了 wechat"：
 * 只把 driver 改成 wechat 但没填凭证，是最容易发生的一种误配 ——
 * 那时服务会"配置看起来是对的、每次审核都失败"。用凭证齐备作为判据，
 * 这种情况会退回 mock + 打标，而不是让整条发布链路挂掉。
 */
function buildModeration(env: AppEnv): AppConfig['moderation'] {
  const appid = env.WECHAT_APPID;
  const secret = env.WECHAT_SECRET ?? '';
  return {
    driver: env.MODERATION_DRIVER,
    appid,
    secret,
    scene: env.MODERATION_SCENE,
    timeoutMs: env.MODERATION_TIMEOUT_MS,
    tokenRefreshAheadSec: env.MODERATION_TOKEN_REFRESH_AHEAD_SEC,
    extraWords: env.MODERATION_EXTRA_WORDS.split(',')
      .map((w) => w.trim())
      .filter(Boolean),
    enabled: env.MODERATION_DRIVER === 'wechat' && !!appid && !!secret,
  };
}

/** 短信网关（厂商未选型，先提供与厂商无关的 HTTP 适配器） */
function buildSms(env: AppEnv): AppConfig['sms'] {
  const url = env.SMS_GATEWAY_URL ?? '';
  return {
    driver: env.SMS_DRIVER,
    gatewayUrl: url,
    gatewayToken: env.SMS_GATEWAY_TOKEN ?? '',
    fields: {
      phone: env.SMS_GATEWAY_PHONE_FIELD,
      template: env.SMS_GATEWAY_TEMPLATE_FIELD,
      params: env.SMS_GATEWAY_PARAMS_FIELD,
    },
    timeoutMs: env.SMS_TIMEOUT_MS,
    enabled: env.SMS_DRIVER === 'http' && !!url,
  };
}

function buildBusiness(env: AppEnv): AppConfig['business'] {
  return {
    platformFeeRate: env.PLATFORM_FEE_RATE,
    platformFeeCapCents: env.PLATFORM_FEE_CAP_CENTS,
    orderPayTimeoutMinutes: env.ORDER_PAY_TIMEOUT_MINUTES,
    orderAutoAcceptDays: env.ORDER_AUTO_ACCEPT_DAYS,
    uploadMaxImageMb: env.UPLOAD_MAX_IMAGE_MB,
    uploadMaxVideoMb: env.UPLOAD_MAX_VIDEO_MB,
    uploadMaxDocMb: env.UPLOAD_MAX_DOC_MB,
    fileRetentionDays: env.FILE_RETENTION_DAYS,
  };
}

function parseCorsOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
