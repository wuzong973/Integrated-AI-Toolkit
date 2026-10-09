import { Injectable } from '@nestjs/common';
import type { RealProviderOverrides } from '@qz/core';

import type { AppConfig } from '../../common/config/configuration';
import { AppLogger } from '../../common/logger/logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

import { SiliconflowAsrProvider } from './audio/asr.provider';
import { SelfhostAsrProvider } from './audio/selfhost-asr.provider';
import { HttpConvertProvider } from './convert/http-convert.provider';
import { SiliconflowEmbeddingProvider } from './embedding/siliconflow-embedding.provider';
import { OpenAiCompatibleLlmProvider } from './llm/openai-compatible.provider';
import { AmapMapProvider } from './map/amap-map.provider';
import { DoclingDocParseProvider } from './pdf/docling.provider';
import { HttpDocParseProvider, HttpPdfProvider } from './pdf/http-pdf.provider';
import { StirlingPdfProvider } from './pdf/stirling.provider';
import { WechatModerationProvider } from './moderation/wechat-moderation.provider';
import { VlmOcrProvider } from './ocr/vlm-ocr.provider';
import { SelfhostOcrProvider } from './ocr/selfhost-ocr.provider';
import { PptxGenJsProvider } from './ppt/pptxgenjs.provider';
import { DeepWikiProvider } from './repo/deepwiki.provider';
import { RedisStreamQueueProvider } from './queue/redis-stream-queue.provider';
import { MysqlFulltextSearchProvider } from './search/mysql-fulltext.provider';
import { SidecarAudioProvider } from './sidecar/sidecar-audio.provider';
import { SidecarClient } from './sidecar/sidecar.client';
import { SidecarImageProvider } from './sidecar/sidecar-image.provider';
import { SidecarVideoProvider } from './sidecar/sidecar-video.provider';
import { HttpSmsProvider } from './sms/http-sms.provider';
import { LocalStorageProvider } from './storage/local-storage.provider';
import { MinioStorageProvider } from './storage/minio-storage.provider';
import { QdrantVectorProvider } from './vector/qdrant-vector.provider';

/** 队列流名前缀与消费组名的默认值（与 deployed 环境的 Redis 键空间约定一致） */
const QUEUE_STREAM_PREFIX = 'qz:queue';
const QUEUE_GROUP = 'workers';

/**
 * 真实 Provider 装配（任务清单 M0-08）
 *
 * 设计说明：
 * - 这里只装配"当前已实现"的真实 Provider；
 * - 未实现的保持 undefined，createProviders 会自动回退到 Mock（并被打上 mock 标记）；
 * - 因此即使只有部分能力就绪，系统也能完整启动（红线 9 的价值）。
 */
@Injectable()
export class RealProviderFactory {
  constructor(
    private readonly redis: RedisService,
    private readonly logger: AppLogger,
    private readonly prisma: PrismaService,
  ) {}

  build(cfg: AppConfig): RealProviderOverrides {
    const overrides: RealProviderOverrides = {};

    /**
     * 图片：**本地 Sharp + AI 侧车抠图**的组合。
     *
     * 压缩 / 转格式 / 增强留在进程内（纯 CPU、毫秒级，没必要走网络），
     * 只有抠图转发到 `services/ai`（rembg 需要 ONNX 模型）。
     * 侧车未启动时抠图会抛带指引的错误，不会返回原图冒充结果。
     */
    overrides.image = new SidecarImageProvider(
      this.buildSidecar(cfg.ai.serviceUrl, cfg.ai.timeoutMs, 'ai'),
      cfg.ai.rembgModel,
    );

    /**
     * 音视频：全部交给 `services/media`（FFmpeg 是系统级二进制，必须外置）。
     *
     * 注意**不要**在这里探测侧车是否在跑 —— 与 Redis / Qdrant 同样的理由：
     * 启动期的可用性竞态不可靠（侧车可能比 API 晚起、也可能中途重启）。
     * 真连不上时由 `SidecarClient` 抛出"服务不可用/超时"，
     * 而且这两种情况的文案是分开的（一个要拉起服务，一个要考虑加大超时）。
     */
    overrides.video = new SidecarVideoProvider(
      this.buildSidecar(cfg.ai.mediaServiceUrl, cfg.ai.mediaTimeoutMs, 'media'),
      // 分享图渲染（Mermaid / markmap → PNG）是媒体侧车的增量能力：
      // RENDER_PROVIDER=playwright 才真的打侧车，否则 renderDiagram 显式抛"未启用"
      cfg.ai.renderEnabled,
    );

    // LLM：仅在配置了 API Key 时启用；否则回退 Mock。
    // 传入 logger 是为了让"主模型过载 → 降级到备用模型"这件事在服务端日志里可见 ——
    // 否则降级是静默的，运维根本不知道主模型已经不可用了。
    if (cfg.llm.enabled) {
      overrides.llm = new OpenAiCompatibleLlmProvider(cfg.llm, this.logger);
    }

    /**
     * 地图 / 位置服务（高德 **Web 服务**）。
     *
     * 仅在 `MAP_DRIVER=amap` **且** `AMAP_WEB_KEY` 非空时启用，否则回退 `mock-map`
     * 并被打上 mock 标记 —— 与 llm / ocr 同样的"配了才真、没配显式可辨"策略。
     *
     * 传 logger 是为了让"key 无效 / key 类型选错 / 配额用尽"在服务端日志里可见：
     * 这三者对用户都表现为"地图服务不可用"，**只有日志能区分**（高德把这三种
     * 失败都写在 HTTP 200 的响应体里）。
     */
    if (cfg.map.enabled) {
      overrides.map = new AmapMapProvider(cfg.map, this.logger);
    }

    // PPT：PptxGenJS 为纯 JS 实现，无需外部依赖，始终启用
    overrides.ppt = new PptxGenJsProvider();

    /**
     * OCR：默认硅基流动 VLM（deepseek-ai/DeepSeek-OCR）；
     * `OCR_PROVIDER=selfhost` 时转发到 AI 侧车（PaddleOCR）。
     * 两者都遵循"配了才真、没配显式可辨"策略（红线 10）。
     */
    overrides.ocr = this.buildOcr(cfg);

    /**
     * 音频：**只要有一个后端可用就装配**。
     *
     * 此前条件是 `cfg.asr.enabled`，那等于把"有没有 ASR Key"当成了整个音频族的开关 ——
     * 而格式转换 / 裁剪 / 降噪 / 人声分离**根本不需要 ASR**，它们只依赖侧车。
     * 后果是"没配 ASR Key 的部署里，连降噪和分离也一起消失"：
     * 把一个能力的开关错接到了另一个能力上，而且从界面上完全看不出来。
     */
    if (hasAnyAudioBackend(cfg)) {
      overrides.audio = new SidecarAudioProvider(
        this.buildAsrDelegate(cfg),
        this.buildSidecar(cfg.ai.mediaServiceUrl, cfg.ai.mediaTimeoutMs, 'media'),
        // 分离用独立客户端：Demucs 是分钟级，超时不能和抠图（秒级）共用
        this.buildSidecar(cfg.ai.serviceUrl, cfg.ai.separationTimeoutMs, 'ai'),
      );
    }

    /**
     * 向量化：硅基流动 `BAAI/bge-m3`（与 OCR / 语音共用同一 Key）。
     *
     * 消费方是 `KnowledgeModule` 的 RAG 链路（切片入库 / 检索 / 带引用回答，M4-06）。
     * 在此之前它只服务于 `/health`，是"接了但没人用"的状态 —— 现在这条链路补上了。
     */
    if (cfg.embedding.enabled) {
      overrides.embedding = new SiliconflowEmbeddingProvider(cfg.embedding);
    }

    /**
     * 向量库：Qdrant（自建）。仅在 `VECTOR_DRIVER=qdrant` 时启用，
     * 否则保持 undefined 回退 `MockVectorProvider` 并被打上 mock 标记
     * —— 与 llm / ocr 同样的"配了才真、没配显式可辨"策略（红线 10）。
     *
     * 传 logger 是为了让"集合不存在、已自动创建"与"集合维度不一致"
     * 这类事件在服务端日志里可见 —— 后者一旦发生，检索结果会**静默变成噪音**。
     */
    if (cfg.vector.enabled) {
      overrides.vector = new QdrantVectorProvider(cfg.vector, this.logger);
    }

    overrides.storage = this.buildStorage(cfg);
    overrides.queue = this.buildQueue(cfg);

    /**
     * 文档转换：**独立部署的 GPL/AGPL 引擎**（ADR-05）。
     *
     * 只在 `CONVERT_SERVICE_URL` 非空时装配；未配置则保持 Mock
     * —— 但那个 Mock **故意抛错而不是返回原文件**（见 MockConvertProvider），
     * 因为"给用户一个后缀不对、打不开的文件"比报错糟得多。
     */
    if (cfg.convert.enabled) {
      overrides.convert = new HttpConvertProvider(
        this.buildSidecar(cfg.convert.serviceUrl, cfg.convert.timeoutMs, 'convert'),
      );
    }

    /**
     * PDF 能力：两个互相独立的维度（详见 config.types.ts 的 pdf 段注释）——
     *   · 操作类（`PdfProvider`，合并/拆分/压缩）由 `PDF_PROVIDER` 选引擎；
     *   · 解析类（`docParse`）始终走 services/pdf 侧车，由 `DOC_PARSER_PROVIDER` 选引擎。
     */
    this.buildPdf(cfg, overrides);

    /**
     * 内容安全：只在 `MODERATION_DRIVER=wechat` **且 appid + secret 齐备**时装配。
     *
     * 注意与其它 Provider 相反的策略：这里未配置就退回 Mock，
     * 而 Mock 用的是**内置词库**（`CAMPUS_LEXICON`），
     * 它拦得住"代考/刷单"这类字面固定的词，但挡不住变体与图片。
     *
     * 所以 mock-moderation 上线前必须去掉 —— 它是合规缺口，不是降级优化。
     * `/health` 的 `mockProviders` 里能看到它，就是给运维的最后一道提醒。
     */
    if (cfg.moderation.enabled) {
      overrides.moderation = new WechatModerationProvider(cfg.moderation, this.logger);
    }

    /**
     * 仓库解读：deepwiki-open（MIT，自托管，只调 REST）。
     *
     * 仅在 `DEEPWIKI_BASE_URL` 非空时装配；未配置则保持 undefined
     * 回落 `MockRepoProvider`（产物通篇标注演示性质，红线 10）——
     * 与 convert / pdf 同样的"配了才真"策略。
     * seed 里的 `explain_repository` 依赖此开关同步 planned ↔ active。
     */
    if (cfg.repo.enabled) {
      overrides.repo = new DeepWikiProvider(cfg.repo, this.logger);
    }

    this.buildSearchAndSms(cfg, overrides);

    return overrides;
  }

  /**
   * 搜索 + 短信：**纯粹是因为 `build()` 的圈复杂度超了上限才拆出来的**，
   * 语义上它们仍属于"按配置装配真实 Provider"的同一段流程。
   *
   * 拆分的取舍：把这两块留在 `build()` 里会让它的 `if` 数达到 9 个、
   * 复杂度 11（上限 10）而 lint 报错。相比放宽容错规则，拆成语义完整的小方法更好 ——
   * `buildPdf` / `buildSidecar` 已经是同样的做法。
   */
  private buildSearchAndSms(cfg: AppConfig, overrides: RealProviderOverrides): void {
    /**
     * 搜索：`SEARCH_DRIVER=mysql` 时装配 MySQL FULLTEXT（M4-07）。
     *
     * ⚠️ 切换前必须已执行 `search_index` 表的迁移，否则查询会失败 ——
     * 这里不主动探测表是否存在（启动期探测同样不可靠），
     * 由 Provider 在真实查询失败时把"表不存在"翻译成"请先跑迁移"的明确提示。
     */
    if (cfg.search.driver === 'mysql') {
      overrides.search = new MysqlFulltextSearchProvider(
        this.prisma,
        { timeoutMs: cfg.search.timeoutMs },
        this.logger,
      );
    }

    /** 短信：服务商未选型，先按可配置的 HTTP 网关装配（见 HttpSmsProvider 的说明） */
    if (cfg.sms.enabled) {
      overrides.sms = new HttpSmsProvider(cfg.sms, this.logger);
    }
  }

  /**
   * PDF 能力装配 —— 两个互相独立的维度：
   *
   *   · **操作类**（合并/拆分/压缩，`PdfProvider`）：`PDF_PROVIDER` 选引擎。
   *     `stirling` 且 `STIRLING_SERVICE_URL` 非空才装 Stirling；否则回落 sidecar 逻辑
   *     （选了 stirling 却没填地址属于半截配置，按未配置处理 —— 与"配了才真"一致）。
   *   · **解析类**（`docParse`）：与 `PDF_PROVIDER` 无关，始终走 services/pdf 侧车
   *     （Stirling 社区版没有稳定的解析端点），由 `DOC_PARSER_PROVIDER` 选 legacy/docling。
   *     `PDF_SERVICE_URL` 未配置时 docParse 回落 Mock，保持"配了才真"。
   *
   * 未配置侧车 URL 时 `MockPdfProvider` 故意抛错（不返回假产物），
   * `MockDocParseProvider` 返回演示文本 —— 降级方式刻意不同（见 core 的 mock 实现）。
   */
  private buildPdf(cfg: AppConfig, overrides: RealProviderOverrides): void {
    const pdfSidecar = cfg.pdf.enabled
      ? this.buildSidecar(cfg.pdf.serviceUrl, cfg.pdf.timeoutMs, 'pdf')
      : undefined;

    if (cfg.pdf.provider === 'stirling' && cfg.pdf.stirling.serviceUrl.trim()) {
      // 配置侧叫 serviceUrl（跟环境变量对齐），Provider 构造参数叫 baseUrl（跟其他 HTTP Provider 对齐）
      const { serviceUrl, ...rest } = cfg.pdf.stirling;
      overrides.pdf = new StirlingPdfProvider({ baseUrl: serviceUrl, ...rest });
    } else if (pdfSidecar) {
      overrides.pdf = new HttpPdfProvider(pdfSidecar);
    }

    if (pdfSidecar) {
      overrides.docParse =
        cfg.pdf.driver === 'docling'
          ? new DoclingDocParseProvider(pdfSidecar)
          : new HttpDocParseProvider(pdfSidecar);
    }
  }

  /**
   * OCR 实现选择（`OCR_PROVIDER`）。
   *
   * ⚠️ selfhost 需要 AI 侧车在跑：`AI_SERVICE_URL` 未配置时**回落 Mock**并打标
   * —— 与"配了才真"一致；探测侧车是否活着是启动期竞态，不可靠（见 overrides.video）。
   */
  private buildOcr(cfg: AppConfig): RealProviderOverrides['ocr'] {
    if (cfg.vlm.driver === 'selfhost') {
      return cfg.ai.enabled ? new SelfhostOcrProvider(cfg) : undefined;
    }
    return cfg.vlm.enabled ? new VlmOcrProvider(cfg.vlm) : undefined;
  }

  /**
   * ASR 委托实现选择（`ASR_PROVIDER`）。
   *
   * `cloud` 看有没有硅基流动 Key；`selfhost` 看 AI 侧车地址是否已配置
   * （未配置回落 Mock，与"配了才真"一致）。超时量级的差异见 SelfhostAsrProvider。
   */
  private buildAsrDelegate(
    cfg: AppConfig,
  ): SiliconflowAsrProvider | SelfhostAsrProvider | undefined {
    if (cfg.asr.driver === 'selfhost') {
      return cfg.ai.enabled ? new SelfhostAsrProvider(cfg) : undefined;
    }
    return cfg.asr.enabled ? new SiliconflowAsrProvider(cfg.asr) : undefined;
  }

  /** 侧车客户端的统一构造：三个服务共用同一套超时/错误语义 */
  private buildSidecar(baseUrl: string, timeoutMs: number, label: string): SidecarClient {
    return new SidecarClient({ baseUrl, timeoutMs }, label, this.logger);
  }

  /**
   * 队列装配（任务清单 M1-04）。
   *
   * `redis-stream` —— 真实实现。Redis 不可用时由 Provider 自身退化为进程内执行，
   *   并把降级状态暴露到 /health，因此这里不需要先探测 Redis 是否在跑
   *   （启动期的可用性竞态不可靠 —— Redis 可能比 API 晚起，也可能中途重启）。
   * `rabbitmq` —— 未实现，保持 undefined 回退 Mock 并打标（红线 9：
   *   宁可显示"未接入"，也不假装支持）。
   */
  private buildQueue(cfg: AppConfig): RealProviderOverrides['queue'] {
    if (cfg.redis.queueDriver !== 'redis-stream') return undefined;

    return new RedisStreamQueueProvider(this.redis, this.logger, {
      streamPrefix: QUEUE_STREAM_PREFIX,
      group: QUEUE_GROUP,
      concurrency: cfg.queue.concurrency,
      maxAttempts: cfg.queue.maxAttempts,
      claimIdleMs: cfg.queue.claimIdleMs,
    });
  }

  /**
   * 对象存储装配。
   *   local —— 本地文件系统，**开发默认**，不依赖外部服务（MinIO 已停止分发）
   *   minio —— S3 协议，需自建或第三方 S3 兼容服务
   *   oss/cos —— 未实现：S3 兼容层在分片与签名细节上有差异，
   *              未实测前不装配，保持 Mock 并打标（红线 9）
   */
  private buildStorage(cfg: AppConfig): RealProviderOverrides['storage'] {
    const s = cfg.storage;

    if (s.driver === 'local') {
      return new LocalStorageProvider({
        baseDir: s.localDir,
        // 签名 URL 指回本服务；配了 CDN/公网域名则优先用它
        baseUrl: s.publicBaseUrl || `http://localhost:${cfg.port}${cfg.apiPrefix}`,
        secret: cfg.jwt.secret,
        presignExpire: s.presignExpire,
      });
    }

    if (s.driver === 'minio' && s.accessKey && s.secretKey) {
      return new MinioStorageProvider({
        endpoint: s.endpoint,
        region: s.region,
        bucket: s.bucket,
        accessKey: s.accessKey,
        secretKey: s.secretKey,
        presignExpire: s.presignExpire,
      });
    }

    return undefined;
  }
}

/**
 * 音频族是否有任一后端可用。
 *
 * 抽成函数不只是为了压 `build()` 的圈复杂度：这个判断本身表达了一条设计意图 ——
 * **音频的可用性不取决于 ASR Key**（转换 / 裁剪 / 降噪 / 人声分离都不需要它）。
 * 写在 `build()` 里时它看起来像"顺手加的条件"，抽出来才有名字。
 */
function hasAnyAudioBackend(cfg: AppConfig): boolean {
  return cfg.asr.enabled || cfg.ai.mediaEnabled || cfg.ai.enabled;
}
