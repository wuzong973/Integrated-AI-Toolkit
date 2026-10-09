import type { Providers } from './types';
import {
  MockAudioProvider,
  MockConvertProvider,
  MockDocParseProvider,
  MockDocProvider,
  MockEmbeddingProvider,
  MockImageProvider,
  MockLlmProvider,
  MockMapProvider,
  MockModerationProvider,
  MockNotifyProvider,
  MockOcrProvider,
  MockPayProvider,
  MockPdfProvider,
  MockPptProvider,
  MockQueueProvider,
  MockRepoProvider,
  MockSearchProvider,
  MockSmsProvider,
  MockStorageProvider,
  MockVectorProvider,
  MockVideoProvider,
} from './mock';

/** Provider 运行模式（文档 1.6） */
export type ProviderMode = 'mock' | 'real' | 'hybrid';

/**
 * 真实实现的注入契约。
 * apps/api 在启动时把真实 Provider 传进来，core 不依赖任何第三方 SDK —— 保证红线 9。
 */
export interface RealProviderOverrides {
  llm?: Providers['llm'];
  embedding?: Providers['embedding'];
  vector?: Providers['vector'];
  storage?: Providers['storage'];
  ocr?: Providers['ocr'];
  ppt?: Providers['ppt'];
  doc?: Providers['doc'];
  image?: Providers['image'];
  video?: Providers['video'];
  audio?: Providers['audio'];
  docParse?: Providers['docParse'];
  convert?: Providers['convert'];
  pdf?: Providers['pdf'];
  notify?: Providers['notify'];
  pay?: Providers['pay'];
  sms?: Providers['sms'];
  search?: Providers['search'];
  moderation?: Providers['moderation'];
  queue?: Providers['queue'];
  map?: Providers['map'];
  repo?: Providers['repo'];
}

/**
 * hybrid 模式下"始终走真实实现"的能力（文档 1.6）
 * 理由：这些开源实现稳定且零成本，没有理由用 Mock。
 */
const ALWAYS_REAL_KEYS = ['image', 'video'] as const;

function pick<T>(mode: ProviderMode, key: keyof RealProviderOverrides, mock: T, real?: T): T {
  if (mode === 'mock') return mock;
  if (mode === 'real') return real ?? mock;
  // hybrid：有真实实现就用；标记为 ALWAYS_REAL 的能力必须走真实实现
  if ((ALWAYS_REAL_KEYS as readonly string[]).includes(key) && real) return real;
  return real ?? mock;
}

/**
 * 创建 Provider 集合。
 * 纪律：业务代码只调用 createProviders()，不直接 new 任何第三方客户端。
 * 说明：每个字段显式标注目标接口类型，避免 TS 从 Mock 实现推断出过窄的类型。
 *
 * 分成两组装配不是审美问题：19 个 Provider 挤在一个函数体里会直接撞上
 * ESLint 的「单函数 ≤50 行」硬红线，而按「基础设施 / 业务能力」分组
 * 恰好也是读代码时最自然的分界 —— 加新 Provider 时该往哪组放是明确的。
 */
export function createProviders(
  mode: ProviderMode,
  overrides: RealProviderOverrides = {},
): Providers {
  return {
    ...buildInfraProviders(mode, overrides),
    ...buildCapabilityProviders(mode, overrides),
  };
}

/** 基础设施：模型、存储、向量库、队列 —— 业务不直接感知，但一切都架在它们之上 */
function buildInfraProviders(mode: ProviderMode, o: RealProviderOverrides) {
  return {
    llm: pick<Providers['llm']>(mode, 'llm', new MockLlmProvider(), o.llm),
    embedding: pick<Providers['embedding']>(mode, 'embedding', new MockEmbeddingProvider(), o.embedding),
    vector: pick<Providers['vector']>(mode, 'vector', new MockVectorProvider(), o.vector),
    storage: pick<Providers['storage']>(mode, 'storage', new MockStorageProvider(), o.storage),
    queue: pick<Providers['queue']>(mode, 'queue', new MockQueueProvider(), o.queue),
    notify: pick<Providers['notify']>(mode, 'notify', new MockNotifyProvider(), o.notify),
    pay: pick<Providers['pay']>(mode, 'pay', new MockPayProvider(), o.pay),
    sms: pick<Providers['sms']>(mode, 'sms', new MockSmsProvider(), o.sms),
    search: pick<Providers['search']>(mode, 'search', new MockSearchProvider(), o.search),
    moderation: pick<Providers['moderation']>(
      mode,
      'moderation',
      new MockModerationProvider(),
      o.moderation,
    ),
    map: pick<Providers['map']>(mode, 'map', new MockMapProvider(), o.map),
  };
}

/** 业务能力：用户能在界面上直接点到的那些（工具、助手、编辑器） */
function buildCapabilityProviders(mode: ProviderMode, o: RealProviderOverrides) {
  return {
    ocr: pick<Providers['ocr']>(mode, 'ocr', new MockOcrProvider(), o.ocr),
    ppt: pick<Providers['ppt']>(mode, 'ppt', new MockPptProvider(), o.ppt),
    doc: pick<Providers['doc']>(mode, 'doc', new MockDocProvider(), o.doc),
    image: pick<Providers['image']>(mode, 'image', new MockImageProvider(), o.image),
    video: pick<Providers['video']>(mode, 'video', new MockVideoProvider(), o.video),
    audio: pick<Providers['audio']>(mode, 'audio', new MockAudioProvider(), o.audio),
    docParse: pick<Providers['docParse']>(mode, 'docParse', new MockDocParseProvider(), o.docParse),
    convert: pick<Providers['convert']>(mode, 'convert', new MockConvertProvider(), o.convert),
    pdf: pick<Providers['pdf']>(mode, 'pdf', new MockPdfProvider(), o.pdf),
    repo: pick<Providers['repo']>(mode, 'repo', new MockRepoProvider(), o.repo),
  };
}

/** 判断某个 Provider 当前是否为 Mock 实现（用于注入 X-Provider: mock） */
export function isMockProvider(p: { name?: string } | undefined): boolean {
  return !!p?.name?.startsWith('mock-');
}

/**
 * **整期未接入**的 Provider 键：它们当前必然是 Mock，且没有任何操作能改变这一点。
 *
 * | 键 | 未接入的原因 |
 * |---|---|
 * | `pay` | 正式支付（微信支付商户）未开工（M5-07）；`pay` 只在 `prepay` / `refund` / 回调三条路径被真正调用 |
 * | `notify` | 订阅消息未开工（M3-19）；当前**全项目无人调用**它（in-app 通知不走这个 Provider） |
 *
 * ## 为什么必须把它们从"演示模式"判定里摘出来
 *
 * 演示角标的语义是"**你这次看到的内容是演示数据**"。而这两个 Provider 是常量级的 Mock，
 * 于是 `anyMockProvider()` 永远为 true —— 接口返回**真实 LLM 生成**的 PPT 时，
 * 前端照样亮"演示模式"。这比不亮更糟：把真的说成假的，角标彻底失去信息量
 *（排查报告 P1-8：角标恒亮，失去区分度）。
 *
 * 摘出来之后，它们的"未接入"并没有被藏起来，只是换了更诚实的表达：
 *   · `/health` 的 `mockProviders` 照旧列出；
 *   · 响应头 `X-Provider-Not-Integrated` 照旧下发（见 MockMarkerMiddleware）；
 *   · **真正会走到它们的路由**（`pay` 的 prepay / refund / 回调）仍由中间件按路由打角标 ——
 *     这部分用 `routeScopedExemptKeys()` 判定，不靠"全局恒亮"来实现。
 */
export const DEMO_MARKER_EXEMPT_KEYS = ['pay', 'notify'] as const;

export type DemoMarkerExemptKey = (typeof DEMO_MARKER_EXEMPT_KEYS)[number];

/** Mock Provider 分布：谁该点亮角标、谁只是"整期未接入" */
export interface MockSummary {
  /** 参与角标判定的 Mock（非空即表示"本次响应可能含演示数据"） */
  flags: string[];
  /** 已知整期未接入的 Mock（不进角标，但必须能被 /health 与响应头看到） */
  notIntegrated: string[];
}

/**
 * 拆分 Mock Provider：按「是否影响本次响应的真实性」分两组。
 *
 * 用 `Object.entries` 而不是 `Object.values` —— 必须知道**每个 Mock 是哪个键**，
 * 才能把 `pay` / `notify` 认出来（只看名字需要维护一份名字→键的映射，更脆）。
 */
export function summarizeMocks(providers: Partial<Providers>): MockSummary {
  const summary: MockSummary = { flags: [], notIntegrated: [] };
  const exempt = new Set<string>(DEMO_MARKER_EXEMPT_KEYS);

  for (const [key, value] of Object.entries(providers)) {
    if (!isMockProvider(value as { name?: string })) continue;
    const name = (value as { name: string }).name;
    if (exempt.has(key)) summary.notIntegrated.push(name);
    else summary.flags.push(name);
  }
  return summary;
}

/**
 * 检查一组 Provider 中是否包含 Mock（含"整期未接入"的那些）。
 *
 * ⚠️ 这个判定的语义是"**有没有任何 mock**"，**不要**拿它驱动演示角标 ——
 * 那会因 `pay` / `notify` 恒真（见 `DEMO_MARKER_EXEMPT_KEYS`）。
 * 角标请用 `summarizeMocks().flags`。
 */
export function anyMockProvider(providers: Partial<Providers>): boolean {
  return Object.values(providers).some((p) => isMockProvider(p as { name?: string }));
}
