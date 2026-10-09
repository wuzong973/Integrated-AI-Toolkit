import type { OsIntentName } from '@qz/core';

/**
 * AI 能力的**契约定义**（统一调用与调度机制的骨架）
 *
 * ## 为什么需要一层"目录"
 *
 * 平台里的 AI 能力本来散落在三处，彼此不知道对方存在：
 *   1. `seed.ts` —— 工具目录（给工具箱 UI 用的展示信息）；
 *   2. `tool-executor.service.ts` —— 真正能跑的执行器；
 *   3. 助手的提示词 —— 一段**手写的**"当前可用的能力只有这些"的散文。
 * 第 3 处最危险：它是给模型看的**能力承诺**，却没有任何东西保证它与 1、2 一致。
 * 2026-09-17 就核对出"18 个 active 里有 9 个跑不通"——提示词当时还在向用户承诺它们。
 *
 * 所以把"助手能不能用某个能力"收敛成**一份目录**：
 *   · 目录声明能力（本文件 + `ai-capability.catalog.ts`）；
 *   · 注册表（`os-capability.registry.ts`）把它与 seed / 执行器**对账**；
 *   · 提示词由注册表的对账结果**生成**，不再手写。
 * 任何一处漂移都会被 `npm run check:ai-capabilities` 拦下。
 *
 * ## 职责边界
 *
 * 本文件只放**类型与纯函数**，不放数据（数据在 `ai-capability.catalog.ts`）——
 * 这样单测可以直接打靶，不必拉起整个 Nest 容器。
 */

/**
 * 能力来源。
 *
 * - `tool`：工具箱里用户**也能单独使用**的工具（`seed.ts` 登记、执行器已接入）。
 *   助手只是"多了一个入口"，同一个能力、同一套配额与计费。
 * - `internal`：只给 Agent 用的内部能力（`visible: false`），不进工具箱 UI。
 *   它们**不查工具表**，由 `OsToolRegistry` 本地实现。
 */
export type CapabilitySource = 'tool' | 'internal';

/**
 * 调用形态 —— 这是本机制最核心的一个字段。
 *
 * - `auto`：**输入全是文字**，模型可以在对话里直接调用并拿到产物。
 *   例：`generate_ppt`（主题是文字）、`translate_text`（原文可以贴在对话里）。
 * - `guided`：**必须先有用户上传的文件**。模型不能凭空执行，只能"指路"——
 *   调度层会返回一张带深链的结果卡，把用户带到执行页去选文件。
 *
 * 为什么要有 `guided` 而不是干脆不暴露给模型：
 * 用户会说"帮我把图片压小一点"，而助手若不知道 `compress_image` 存在，
 * 就只能回一句"这个我做不到"——**能力存在，助手却不知道**，这是最冤的一种失败。
 * 暴露它、但强制走"引导上传"，既让助手能正确回答，又不会伪造一个没执行的成功。
 *
 * 反过来，当用户在会话里**已经传过文件**时，`guided` 也会真的执行
 *（见 `AiDispatchService`）——"指路"只是缺文件时的降级，不是永久限制。
 */
export type CapabilityInvocation = 'auto' | 'guided';

/** 产物形态，决定结果卡怎么渲染 */
export type CapabilityResultKind = 'file' | 'text';

/** 需要用户先提供哪一类文件（`false` = 不需要文件） */
export type CapabilityFileKind = 'image' | 'audio' | 'video' | 'text' | false;

/** 一条 AI 能力的声明（目录里的一项） */
export interface AiCapability {
  /** 工具名。`source: 'tool'` 时必须与 `seed.ts` 和执行器 handlers 的键**逐字一致** */
  toolName: string;
  source: CapabilitySource;
  /**
   * 归属意图（`OS_INTENTS` 取值）。
   *
   * ⚠️ 取值必须在 `OS_INTENTS` 里：它是助手与用户之间的**共同语汇**，
   * 随意新增取值不会报错，只会让小程序的路由按钮永远匹配不上（静默失效）。
   */
  intent: OsIntentName;
  /** 人话名，用于结果卡标题 */
  title: string;
  /**
   * 可触发场景。
   *
   * ⚠️ 这段文字会**原样进入模型的工具描述**，所以要按"模型读了才知道该不该调"来写：
   * 说清楚「什么时候调」，也要说清楚「什么时候不要调」——只写好话会让模型过度调用。
   */
  scene: string;
  /** 不适用场景（会追加到工具描述里）。命中这些的情况应改用别的能力或直接回答 */
  notFor?: string[];
  invocation: CapabilityInvocation;
  /** 需要哪类文件；`auto` 能力一般为 `false` */
  needsFile: CapabilityFileKind;
  resultKind: CapabilityResultKind;
  /** 执行成功后给用户看的一句话（结果卡副标题） */
  resultHint: string;
  /** 缺文件时的引导语（`guided` 必填）：告诉用户点卡片做什么 */
  guideHint?: string;
  /**
   * 参数规范（**仅 `source: 'internal'` 需要**）。
   *
   * `source: 'tool'` 的能力从工具表取 `inputSchema`（与执行页表单同源，
   * 不再抄一份，抄了必然会漂移）；内部能力不在工具箱里、没有那份 schema，
   * 所以在这里就地声明 —— 它同样是"输入输出规范"的一部分，属于本目录的职责。
   */
  params?: Record<string, unknown>;
}

/** 目录查找：按工具名取能力声明 */
export function findCapability(
  catalog: readonly AiCapability[],
  toolName: string,
): AiCapability | undefined {
  return catalog.find((c) => c.toolName === toolName);
}

/** 某一意图下声明了哪些能力（供文档与前端路由使用，**不代表它们真的能跑**） */
export function capabilitiesOfIntent(
  catalog: readonly AiCapability[],
  intent: OsIntentName,
): AiCapability[] {
  return catalog.filter((c) => c.intent === intent);
}
