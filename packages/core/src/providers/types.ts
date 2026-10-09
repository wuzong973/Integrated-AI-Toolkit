/**
 * Provider 抽象层接口定义（文档 1.6，红线 9）
 * 纪律：业务代码只依赖接口，不直接依赖任何第三方 SDK。
 *       开发期用 Mock 实现，上线时替换真实实现，业务代码零改动。
 */
import type { DocConvertProvider } from './doc-convert.types';
import type { MapProvider } from './map.types';
import type { ModerationProvider } from './moderation.types';
import type { PayProvider } from './pay.types';
import type { PdfProvider } from './pdf.types';
import type { PptChartSpec } from './ppt.types';
import type { RepoProvider } from './repo.types';
import type { VectorProvider } from './vector.types';
export * from './ppt.types';

// 按能力域拆出去的类型在这里继续对外可见（`providers/index.ts` 也会 export *）
export type { DocConvertInput, DocConvertProvider, DocConvertResult } from './doc-convert.types';
export type { ModerationProvider, ModerationRequest, ModerationResult } from './moderation.types';
export type {
  PdfCompressInput,
  PdfFileInput,
  PdfMergeInput,
  PdfProvider,
  PdfResult,
  PdfSplitInput,
} from './pdf.types';
export type { PayCallbackPayload, PayProvider, PrepayInput, PrepayResult } from './pay.types';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /**
   * 工具结果消息要回填**发起它的那次调用 id**。
   *
   * ⚠️ 少了它，模型会看到一条"来历不明的工具结果"，
   * 在 OpenAI 兼容协议下这属于格式错误 —— 有的服务商直接 400，
   * 有的（更糟）会忽略整条消息，于是模型拿着旧上下文继续编。
   */
  toolCallId?: string;
  name?: string;
  /**
   * **assistant 消息里**模型发起的工具调用。
   *
   * 这是多轮工具调用的必需字段：协议要求把"模型请求调用某工具"这件事
   * 原样带回下一轮，模型才知道自己刚才发过什么请求、将要收到的是哪个结果。
   * 不带上它，模型每一轮都会**重复发起同一个调用**（它不知道上次已经被满足）。
   */
  toolCalls?: LlmToolCall[];
}

export interface LlmToolSpec {
  name: string;
  description: string;
  /** JSON Schema */
  parameters: Record<string, unknown>;
}

export interface LlmCallOptions {
  /** 模型档位（文档 6.10.2 模型分级） */
  tier?: 'intent' | 'generate' | 'plan';
  tools?: LlmToolSpec[];
  /** 要求返回 JSON，配合 JSON Schema 校验 */
  jsonSchema?: Record<string, unknown>;
  temperature?: number;
  /**
   * 核采样阈值（0-1）。截掉概率长尾，与 `temperature` 配合才构成完整的"稳"。
   *
   * 取值口径见 `sampling.ts` 的档位表 —— 调用方应通过 `sampling(档位)` 取参数，
   * 而不是各自写数字（散落的字面量正是 Q9 要修的问题）。
   */
  topP?: number;
  maxTokens?: number;
  /** 是否流式 */
  stream?: boolean;
  /**
   * 请求端点**关闭思考**（智谱 GLM 的 `thinking: { type: 'disabled' }`）。
   *
   * 与 `reasoning_effort` 不是一回事：那个是"把推理降档"，效果**强依赖任务复杂度** ——
   * 极简任务（"只回复两个字"）实测能从 112 token 降到 3；但复杂生成任务（思维导图）
   * **压不住**，reasoning 仍占 token 的 60~75%，`generate_mindmap` 因此耗时在 30s
   * 超时线上下波动、时通时不通。这个是"直接关掉"，实测 reasoning 归零。
   *
   * 实测效果（同一 prompt）：耗时 23.6s → **3.6s**、`completion_tokens` 2016 → **314**，
   * 产物质量不降反升（更精炼，无冗余铺陈）。
   *
   * ⚠️ 这是**服务商特有参数**。换到不支持的端点若报 400，把 `LLM_DISABLE_THINKING`
   * 设为 `false` 即可（Provider 侧会跳过发送），无需改代码。
   */
  disableThinking?: boolean;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmResponse {
  content: string;
  toolCalls?: LlmToolCall[];
  /** 用量统计（成本看板用） */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  model?: string;
  /**
   * 结束原因（OpenAI 兼容协议的 `finish_reason`）。
   *
   * `length` 表示**被 max_tokens 截断了** —— 内容不完整，但 HTTP 是 200，
   * 看起来完全正常。调用方据此决定"重试 / 续写 / 如实标注"，
   * 而不是把半截内容当成完整结果交付（Q8）。
   */
  finishReason?: string;
}

export interface LlmProvider {
  readonly name: string;
  chat(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmResponse>;
  /** 结构化输出：要求模型返回符合 schema 的 JSON 并做校验 */
  structured<T>(messages: LlmMessage[], schema: unknown, options?: LlmCallOptions): Promise<T>;
  /** 流式输出（SSE / WebSocket 分片推给前端） */
  chatStream?(
    messages: LlmMessage[],
    options: LlmCallOptions,
    onChunk: (delta: string) => void,
  ): Promise<LlmResponse>;
}

export interface EmbeddingProvider {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
  readonly dimension: number;
}

// 向量库相关接口（VectorPoint / VectorMatch / VectorProvider）见 ./vector.types.ts。
// 本文件已接近 300 行上限，且这组概念相对独立，故单独成文件后在此原样再导出，
// 使用方从 `@qz/core` 拿到的类型集合不变。
export type { VectorMatch, VectorPoint, VectorProvider } from './vector.types';

// 地图 / 位置服务的类型**不在这里再导出**：本文件已贴着 300 行上限，
// 再塞一个 8 行的 re-export 块就会超。改由 `providers/index.ts` 直接
// `export * from './map.types'` —— 对外可见的路径不变（`@qz/core` 照旧）。
// 坐标一律 GCJ-02、单位米/秒，见 ./map.types.ts 文件头。

// ==================== 存储 ====================
export interface PresignResult {
  /** 上传地址 */
  uploadUrl: string;
  /** 上传所需的表单字段/请求头 */
  headers: Record<string, string>;
  /** 对象键（确认上传时回传） */
  objectKey: string;
  /** 签名过期时间（秒） */
  expiresIn: number;
}

export interface StorageProvider {
  readonly name: string;
  /** 生成直传签名（文档 ADR-04：后端只签发，不中转二进制） */
  presignPut(objectKey: string, contentType: string, expiresIn?: number): Promise<PresignResult>;
  /** 生成下载签名 URL */
  presignGet(objectKey: string, expiresIn?: number): Promise<string>;
  putObject(objectKey: string, body: Buffer, contentType: string): Promise<void>;
  getObject(objectKey: string): Promise<Buffer>;
  deleteObject(objectKey: string): Promise<void>;
  /** 对象是否存在 */
  exists(objectKey: string): Promise<boolean>;
}

// ==================== OCR ====================
export interface OcrBlock {
  text: string;
  /** 四角坐标 [[x,y] x4]，可用于版面还原 */
  box?: [number, number][];
  confidence?: number;
}
export interface OcrResult {
  blocks: OcrBlock[];
  fullText: string;
  language?: string;
}
export interface OcrProvider {
  readonly name: string;
  recognize(file: Buffer, opts?: { lang?: string }): Promise<OcrResult>;
}

// ==================== PPT ====================
/**
 * 幻灯片版式（PPT 视觉改造）。
 *
 * 为什么收成字面量联合而不是自由字符串：渲染器要按版式分发绘制逻辑，
 * 自由字符串会让"拼错的版式"静默回落成默认样式 —— 作者以为生效了，
 * 用户拿到的还是一堆同构页。全部可选、缺省 `bullets`，
 * 只传 `{title, bullets}` 的旧调用行为不变（向后兼容）。
 */
export type PptSlideLayout = 'bullets' | 'section' | 'twoCol' | 'stat' | 'quote' | 'chart';



export interface PptSlideSpec {
  title: string;
  bullets?: string[];
  notes?: string;
  /** 版式；缺省或数据不足时由渲染器按内容推导并降级（如 points>4 自动走 twoCol） */
  layout?: PptSlideLayout;
  /** 原生图表（保证可编辑，不用贴图） */
  chart?: PptChartSpec;
  imageUrl?: string;
  /** `layout:'stat'` 的数据：超大数字 + 一句话说明。value 含数字时渲染器自动补"AI 估算"脚注（红线 10） */
  stat?: { value: string; label: string };
  /** `layout:'quote'` 的数据：大字引言 + 可选署名 */
  quote?: { text: string; by?: string };
  /** `layout:'section'` 的节序号（两位补零显示）；缺省时渲染器按章节页出现顺序自增 */
  sectionNo?: number;
}
export interface PptRenderInput {
  title: string;
  subtitle?: string;
  template?: string;
  /**
   * 视觉风格。**PPT 改造后渲染器真的按它取色** —— 此前这个字段被执行器传入、
   * 被渲染器忽略，五档风格画出来一模一样。未匹配回落 `business`。
   */
  style?: 'business' | 'tech' | 'fresh' | 'academic' | 'chinese';
  slides: PptSlideSpec[];
  /** 页脚署名，缺省"青智校园 · AI 生成" */
  footerLabel?: string;
}
export interface PptRenderResult {
  /** 生成的 .pptx 二进制 */
  buffer: Buffer;
  pageCount: number;
}
export interface PptProvider {
  readonly name: string;
  /** 必须真实产出可打开的 .pptx（文档 6.5.2） */
  render(input: PptRenderInput): Promise<PptRenderResult>;
  /** 可用的模板清单 */
  listTemplates(): Promise<{ id: string; name: string; thumbnail?: string }[]>;
}

// ==================== 文档 ====================
export interface DocSection {
  heading: string;
  level: 1 | 2 | 3;
  paragraphs?: string[];
  bullets?: string[];
  table?: { headers: string[]; rows: string[][] };
}
export interface DocRenderInput {
  title: string;
  meta?: Record<string, string>;
  sections: DocSection[];
}
export interface DocProvider {
  readonly name: string;
  /** 渲染为 docx */
  renderDocx(input: DocRenderInput): Promise<Buffer>;
  /** 渲染为 markdown */
  renderMarkdown(input: DocRenderInput): Promise<string>;
}

// ==================== 图片 ====================
export interface ImageCompressInput {
  buffer: Buffer;
  quality?: number;
  targetSizeBytes?: number;
  format?: 'jpeg' | 'png' | 'webp';
}
export interface ImageConvertInput {
  buffer: Buffer;
  format: 'jpeg' | 'png' | 'webp';
}
export interface ImageProvider {
  readonly name: string;
  /**
   * 压缩。
   *
   * `targetMet` 表示"目标体积是否真的达成"：传了 `targetSizeBytes` 时可能压不到，
   * 调用方必须据此如实告知用户，而不是一律报成功（否则就是"成功但结果不对"）。
   */
  compress(input: ImageCompressInput): Promise<{
    buffer: Buffer;
    ratio: number;
    targetMet: boolean;
  }>;
  convert(input: ImageConvertInput): Promise<Buffer>;
  /** 抠图：必须走白名单模型（文档 2.8.4） */
  removeBackground(buffer: Buffer): Promise<Buffer>;
  /**
   * 增强：锐化 + 提饱和。`strength` 0-100，0 表示不做任何处理。
   *
   * ⚠️ 这里**没有**放大倍数参数：当前两个实现都不做超分，
   * 保留一个被忽略的 `scale` 会让"图片增强"对外承诺它做不到的事。
   * 超分模型部署后应单开能力，而不是在这里补参数。
   */
  enhance(buffer: Buffer, strength?: number): Promise<Buffer>;
  /** 授权内容修复（需前置版权声明，文档 6.7.2） */
  inpaint(buffer: Buffer, mask: Buffer): Promise<Buffer>;
}

// ==================== 视频 ====================
export interface VideoInfo {
  durationSec: number;
  width: number;
  height: number;
  bitrate: number;
  sizeBytes: number;
  format: string;
}
/**
 * 图表渲染入参（Mermaid / markmap 源码 → PNG 分享图）。
 * ⚠️ 本文件贴着 300 行上限，故压成单行：kind 图表语法；code 源码（mermaid 传
 * Mermaid 代码，markmap 传 Markdown 层级列表）。再加类型请拆到独立 `.types.ts`。
 */
export type DiagramRenderRequest = { kind: 'mermaid' | 'markmap'; code: string };
export interface VideoProvider {
  readonly name: string;
  probe(buffer: Buffer): Promise<VideoInfo>;
  /** 压缩到目标体积（按体积反推码率，文档 7.4.1） */
  compress(buffer: Buffer, targetSizeBytes?: number, crf?: number): Promise<Buffer>;
  convert(buffer: Buffer, format: 'mp4' | 'webm' | 'gif'): Promise<Buffer>;
  cut(buffer: Buffer, startSec: number, endSec: number): Promise<Buffer>;
  /** 烧录字幕 */
  burnSubtitle(buffer: Buffer, srt: string): Promise<Buffer>;
  /**
   * 图表渲染：Mermaid / markmap → PNG（分享图）。
   *
   * 放在"视频"接口看似越界，实则与 TTS 放在 AudioProvider 是同一条取舍：
   * 它同属媒体侧车的重依赖能力（playwright + chromium），且调用方拿到的同样是 Buffer。
   * 语义见 `DiagramRenderRequest`；未开启渲染时实现必须**抛错**而不是返回空图 ——
   * 调用方（思维导图工具）据此跳过分享图、只交付文本产物。
   */
  renderDiagram(req: DiagramRenderRequest): Promise<Buffer>;
}

// ==================== 音频 ====================
/** 人声分离产出的一条轨道 */
export interface AudioStem {
  /** 轨道名：`vocals` / `accompaniment` / `drums` / `bass` / `other` */
  name: string;
  data: Buffer;
}

export interface AudioProvider {
  readonly name: string;
  convert(buffer: Buffer, format: 'mp3' | 'wav' | 'aac' | 'flac'): Promise<Buffer>;
  /**
   * 裁剪 `[startSec, endSec)` 的一段。
   *
   * 与视频裁剪（`VideoProvider.cut`）分开定义，是刻意的：
   * 音频要的是**保留原始音质**，实现上必须能走"同容器流复制"，
   * 而视频裁剪的产物是 .mp4 —— 把音频塞进去会得到"能播但后缀不对"的文件。
   */
  cut(buffer: Buffer, startSec: number, endSec: number): Promise<Buffer>;
  /**
   * 降噪。
   *
   * `strength` 是**用户在界面上选的档位**（轻/中/强），不是引擎参数 ——
   * 把"afftdn 的 nr 应该填几"这类引擎细节留在实现里，接口只表达用户意图。
   */
  denoise(buffer: Buffer, strength?: 'light' | 'medium' | 'strong'): Promise<Buffer>;
  /**
   * 人声/伴奏分离（文档 2.6：首选 Demucs）。
   *
   * `stems=2` → `vocals` + `accompaniment`；`stems=4` → `vocals`/`drums`/`bass`/`other`。
   *
   * 返回**数组**而不是 `{ vocals, accompaniment }` 固定字段：4 轨是产品已暴露的选项
   *（见 `tool-input-schemas` 的 `stems`），固定两个字段会让 4 轨的结果无处安放。
   */
  separateVocals(buffer: Buffer, stems: 2 | 4): Promise<AudioStem[]>;
  /** 语音转文字（含时间戳） */
  speechToText(
    buffer: Buffer,
    opts?: { language?: string },
  ): Promise<{
    text: string;
    segments: { start: number; end: number; text: string }[];
  }>;
  /**
   * 文本转语音（TTS）。
   *
   * 与同接口其他方法**方向相反**：那些都是"音频进、音频出"，这个是"文本进、音频出"。
   * 仍放在这里而不新开接口，是因为它同属音频能力、共用同一个媒体侧车，
   * 调用方拿到的也同样是 `Buffer`。
   *
   * ⚠️ 它与 `speechToText` 互为逆操作 —— 两者合起来才是"听说闭环"。
   */
  textToSpeech(text: string, voice?: string): Promise<Buffer>;
}

// ==================== 文档解析 ====================
export interface ParsedDocument {
  text: string;
  pages?: { index: number; text: string }[];
  meta?: Record<string, string>;
}
export interface DocParseProvider {
  readonly name: string;
  parse(buffer: Buffer, filename: string): Promise<ParsedDocument>;
}

// ==================== 通知 ====================
export interface NotifyInput {
  userId: string;
  type: string;
  title: string;
  content: string;
  ref?: Record<string, unknown>;
  channels?: ('in_app' | 'subscribe_message' | 'websocket')[];
}
export interface NotifyProvider {
  readonly name: string;
  send(input: NotifyInput): Promise<{ delivered: string[]; failed: string[] }>;
}

// ==================== 支付 ====================
// 类型已拆分到 ./pay.types.ts（文件顶部有 re-export，对外导入路径不变）

// ==================== 短信 ====================
export interface SmsProvider {
  readonly name: string;
  send(phone: string, templateCode: string, params: Record<string, string>): Promise<void>;
}

// ==================== 搜索 ====================
export interface SearchHit {
  id: string;
  type: string;
  title: string;
  snippet: string;
  score: number;
  raw?: Record<string, unknown>;
}
export interface SearchProvider {
  readonly name: string;
  index(type: string, doc: Record<string, unknown>): Promise<void>;
  search(
    query: string,
    opts?: { type?: string; page?: number; size?: number },
  ): Promise<{ list: SearchHit[]; total: number }>;
}

// ==================== 队列（文档 A5：Redis Stream 起步，可换 RabbitMQ） ====================
export interface QueueJob<T = unknown> {
  id: string;
  name: string;
  payload: T;
  attempts: number;
  maxAttempts: number;
}
export interface QueueProvider {
  readonly name: string;
  enqueue<T>(
    name: string,
    payload: T,
    opts?: { delayMs?: number; maxAttempts?: number },
  ): Promise<string>;
  /** 注册消费者 */
  process<T>(
    name: string,
    handler: (job: QueueJob<T>) => Promise<void>,
    opts?: { concurrency?: number },
  ): void;
  /** 队列深度（用于"排队 N 人"提示与 GPU 弹性启停） */
  depth(name: string): Promise<number>;
  /**
   * 队列运行状态（可选实现）。
   *
   * 为什么需要：Redis Stream 版队列在 Redis 不可用时会**降级为进程内执行**以避免
   * 静默丢任务 —— 这在功能上无害（作业本身幂等），但必须让运维看得见，
   * 否则"分布式队列"会在无人察觉时退化成单机队列。故由 /health 暴露本状态。
   */
  status?(): Promise<QueueStatus>;
  /** 释放消费者循环（可选实现；测试与优雅停机使用） */
  close?(): Promise<void>;
}

/** 队列运行状态 */
export interface QueueStatus {
  /** 实际生效的驱动名，如 redis-stream */
  driver: string;
  /** 是否处于降级（消息落到了进程内执行，而非分布式队列） */
  degraded: boolean;
  /** 各队列待处理消息数。**-1 表示无法读取**（降级中），与"真的为空"区分 */
  pending: Record<string, number>;
  /** 已转入死信队列的消息数。同样以 -1 表示无法读取 */
  deadLettered?: number;
}

/** 全部 Provider 的聚合类型 */
export interface Providers {
  llm: LlmProvider;
  embedding: EmbeddingProvider;
  /** 向量库（RAG 检索）。未配 Qdrant 时回退 mock-vector，并在响应头打标 */
  vector: VectorProvider;
  storage: StorageProvider;
  ocr: OcrProvider;
  ppt: PptProvider;
  doc: DocProvider;
  image: ImageProvider;
  video: VideoProvider;
  audio: AudioProvider;
  docParse: DocParseProvider;
  /** 文档格式转换（独立部署的 GPL/AGPL 引擎，ADR-05） */
  convert: DocConvertProvider;
  /**
   * PDF 能力（独立部署的 AGPL 引擎 PyMuPDF，经 `services/pdf` 子进程调用）。
   *
   * 与 `convert` 的分工见 `pdf.types.ts`：这里做"不改排版"的四件事
   *（合并 / 拆分 / 压缩 / 取文本），格式互转仍归 convert。
   */
  pdf: PdfProvider;
  notify: NotifyProvider;
  pay: PayProvider;
  sms: SmsProvider;
  search: SearchProvider;
  moderation: ModerationProvider;
  queue: QueueProvider;
  /**
   * 地图 / 位置服务（高德 / 腾讯等合规服务商）。
   *
   * ⚠️ key 一律**只在服务端**（前端明文会被嗅探，且小程序端根本用不到 ——
   * 微信 `<map>` 组件本身就是腾讯地图，零 key）。
   */
  map: MapProvider;
  /** 仓库解读（deepwiki-open 自托管，MIT）。未配 DEEPWIKI_BASE_URL 时回退 mock-repo 并打标 */
  repo: RepoProvider;
}
