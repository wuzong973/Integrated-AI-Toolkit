import {
  BizException,
  ErrorCode,
  type LlmCallOptions,
  type LlmMessage,
  type LlmProvider,
  type LlmResponse,
} from '@qz/core';

import type { AppLogger } from '../../../common/logger/logger.service';
import type { AppConfig } from '../../../common/config/configuration';
import { TimeBudget } from '../../../common/utils/time-budget';

import { assertContentPresent, extractJson } from './llm-output';
import { consumeSse } from './sse';

// 既有测试与调用方从本文件取 extractJson，保持出口不变
export { extractJson };

/**
 * OpenAI 兼容协议的 LLM 实现（文档 6.10.2 模型分级）
 *
 * 兼容范围：DeepSeek / 通义千问 / 智谱 / Moonshot / vLLM / Ollama 等
 * 只要服务端实现 POST {baseUrl}/chat/completions 即可。
 *
 * 纪律：
 * - 必须支持 JSON Schema 结构化输出；
 * - 失败按指数退避重试（1s/4s/16s，最多 LLM_MAX_RETRY 次）；
 * - **整个调用链受 `LLM_TOTAL_BUDGET_MS` 总预算约束**（见 `TimeBudget`）——
 *   没有这个上限时，`模型数 × 重试数 × 单次超时` 会放大到几分钟；
 * - 不在此处做业务判断，只负责"调用与容错"。
 *
 * ## 模型降级（`LLM_FALLBACK_MODELS`）
 *
 * 免费档的 flash 模型会过载：智谱返回 `HTTP 429 + code 1305 该模型当前访问量过大`。
 * 实测 `glm-4.7-flash` 高峰期 **5 次里 4 次 429**，唯一成功那次耗时 42 秒 ——
 * 光靠重试等不来可用性，只会让用户白等 20 秒再看到失败。
 *
 * 所以主模型重试耗尽后，按 `fallbackModels` 顺序再试。降级只在**可重试**的失败上发生
 *（429 / 5xx / 网络），确定性失败（400，如模型名写错、参数不支持）直接抛出 ——
 * 换模型也一样会失败，没必要多打一次。
 */
export class OpenAiCompatibleLlmProvider implements LlmProvider {
  readonly name = 'openai-compatible';

  constructor(
    private readonly cfg: AppConfig['llm'],
    /** 可选：仅用于记录"降级到备用模型"这类运维事件；不传则静默 */
    private readonly logger?: Pick<AppLogger, 'warn'>,
  ) {}

  private modelFor(tier?: LlmCallOptions['tier']): string {
    switch (tier) {
      case 'intent':
        return this.cfg.models.intent;
      case 'plan':
        return this.cfg.models.plan;
      case 'generate':
      default:
        return this.cfg.models.generate;
    }
  }

  /** 实际要尝试的模型序列：主模型 + 降级模型（剔除与主模型重名的，避免白试一次） */
  private modelsFor(tier?: LlmCallOptions['tier']): string[] {
    const primary = this.modelFor(tier);
    return [primary, ...this.cfg.fallbackModels.filter((m) => m !== primary)];
  }

  async chat(messages: LlmMessage[], options: LlmCallOptions = {}): Promise<LlmResponse> {
    const json = await this.postWithFallback(this.buildBody(messages, options), options.tier);
    return this.normalize(json);
  }

  /** 组装请求体（不含 `model`，由请求层按当前尝试的模型填入） */
  private buildBody(
    messages: LlmMessage[],
    options: LlmCallOptions,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        ...(m.name ? { name: m.name } : {}),
        // assistant 消息里的 tool_calls 必须原样带回：
        // 协议要求模型能看到自己上一轮发起了哪些调用，否则它会重复调用同一个工具
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      })),
      temperature: options.temperature ?? 0.7,
      // top_p 不传时不给默认值：服务商默认各不同，擅自补值会改变既有行为
      ...(options.topP !== undefined ? { top_p: options.topP } : {}),
      max_tokens: options.maxTokens ?? 4000,
      stream: false,
    };

    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    // 结构化输出：用 `json_object` 而**不是** `json_schema`。
    // 实测智谱的 json_schema 不可靠 —— 即使 `strict: true`，glm-4-flash 仍会自由发挥
    //（要求 `string[]`，它返回 `[{title, content}]`）；而 `json_object` 在对比测试里
    // 最快也最稳（4.3s vs 9.4s）。代价是 schema 只能靠提示词传达，
    // 所以 `structured()` 会先把 schema 追加进消息（见 `withSchemaHint`）。
    if (options.jsonSchema) {
      body.response_format = { type: 'json_object' };
    }

    this.applyReasoningEffort(body);
    this.applyThinking(body, options);
    return body;
  }

  async structured<T>(
    messages: LlmMessage[],
    schema: unknown,
    options: LlmCallOptions = {},
  ): Promise<T> {
    const res = await this.chat(withSchemaHint(messages, schema), {
      ...options,
      jsonSchema: schema as Record<string, unknown>,
    });
    try {
      return JSON.parse(extractJson(res.content)) as T;
    } catch (e) {
      throw new BizException(
        ErrorCode.AiOutputInvalid,
        { reason: (e as Error).message },
        'AI 输出格式异常，已自动重试仍未通过校验',
      );
    }
  }

  /**
   * 流式输出（SSE 分片）。
   *
   * ⚠️ **不做模型降级**：分片一旦开始推给客户端，中途换模型会拼出前后不一致的内容。
   * 降级只发生在流开始之前（首个 HTTP 响应就失败）时才有意义，
   * 那种情况由调用方改用非流式的 `chat()` 更合适。
   */
  async chatStream(
    messages: LlmMessage[],
    options: LlmCallOptions,
    onChunk: (delta: string) => void,
  ): Promise<LlmResponse> {
    const body = {
      model: this.modelFor(options.tier),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: options.temperature ?? 0.7,
      // top_p 不传时不给默认值：服务商默认各不同，擅自补值会改变既有行为
      ...(options.topP !== undefined ? { top_p: options.topP } : {}),
      max_tokens: options.maxTokens ?? 4000,
      stream: true,
    };

    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(this.cfg.timeoutMs, this.cfg.totalBudgetMs)),
    });

    if (!res.ok || !res.body) {
      throw new BizException(ErrorCode.LlmUnavailable, { status: res.status });
    }

    const full = await consumeSse(res.body, onChunk);
    return { content: full, model: this.modelFor(options.tier) };
  }

  /**
   * 请求头。
   *
   * ⚠️ `Connection: close` 是**刻意**加的，不是随手写的。
   *
   * Node 的 `fetch`（undici）默认复用 keep-alive 连接，而服务端会在空闲一段时间后
   * **静默关闭**它。复用一条已被对端关闭的连接时，请求会**一直挂起直到超时** ——
   * 症状极具迷惑性：**刚重启时一切正常，跑十几分钟后每个 LLM 调用都卡满总预算**。
   *
   * 2026-09-18 实测：作业 `summarize_text` 连续两次卡满 45s 后失败
   *（`startedAt → finishedAt` 恰好 45.028s，等于 `LLM_TOTAL_BUDGET_MS`），
   * 而**同一时刻**新起的进程调同一个接口只要 3.5s —— 排除供应商、Key、网络因素。
   *
   * 代价是每次请求多一次 TCP+TLS 握手（本地实测约 0.2~0.5s）。
   * 相比"卡满 45 秒且必然失败、还照样烧掉一次供应商配额"，这个代价可以接受。
   */
  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.cfg.apiKey}`,
      Connection: 'close',
    };
  }

  /**
   * 附加推理深度参数（可选）。
   *
   * ## 为什么需要它（实测踩坑）
   *
   * 智谱的 GLM 系列是**推理型模型**：回答会先在 `reasoning_content` 里"思考"，
   * 再把结论写进 `content`。默认推理很深 —— 实测"只回复两个字：可以"
   * 消耗 **112 个完成 token（其中 107 是推理）**、3.5 秒。
   * 设 `reasoning_effort: "low"` 后降到 **3 个 token、0.99 秒**。
   *
   * ## 为什么做成"非空才发送"，而不是默认带上
   *
   * 这个字段只有部分服务商认识（OpenAI 系 / 智谱支持），发给不认识的服务商
   * 有被拒的风险。默认不发送可保证 Provider 对任何 OpenAI 兼容后端都安全。
   *
   * ## 取值合法性由 schema 保证
   *
   * 这里只判"非空"，不逐个比对取值 —— `env.schema.ts` 已把枚举收紧到
   * 智谱实际接受的 `low/high/max`（`medium`/`minimal` 会被 400 拒绝，见那里注释）。
   */
  private applyReasoningEffort(body: Record<string, unknown>): void {
    if (this.cfg.reasoningEffort) body.reasoning_effort = this.cfg.reasoningEffort;
  }

  /**
   * 显式**关闭思考**（智谱 GLM 的 `thinking: { type: 'disabled' }`）。
   *
   * ## 与 `applyReasoningEffort` 的分工
   *
   * 那个是"把推理**降档**"，效果**强依赖任务复杂度**：极简任务（"只回复两个字"）
   * 能从 112 token 降到 3；但复杂生成任务压不住 —— `generate_mindmap` 实测
   * reasoning 仍占 token 的 60~75%、耗时 23.6~31.1s，**在 30s 超时线上反复横跳**。
   * 这个是"**直接关掉**"，实测 reasoning 归零、耗时 3.6s。
   *
   * ## 双开关，缺一不发
   *
   * - `options.disableThinking`：**调用方**声明"我这个请求不需要思考"
   *  （重生成类工具，如思维导图）；
   * - `cfg.disableThinking`：**部署方**声明"我这个端点认识这个参数"
   *  （`LLM_DISABLE_THINKING`，换不兼容端点时设 `false`）。
   *
   * 之所以不无条件发送：`thinking` 是服务商特有参数，发给不认识的端点会被 400 拒绝。
   */
  private applyThinking(body: Record<string, unknown>, options: LlmCallOptions): void {
    if (options.disableThinking && this.cfg.disableThinking) {
      body.thinking = { type: 'disabled' };
    }
  }

  /**
   * 按当前尝试的**序号**调整请求体：降级模型（第 2 个及以后）一律**关闭思考**。
   *
   * ## 为什么只给降级关（2026-09-20 实测）
   *
   * `glm-4.7-flash` 作为降级模型时，**21.2 秒只吐了 341 字符推理、`content` 为空** ——
   * 推理把 `max_tokens` 花光了。后果不是"降级慢一点"，而是**降级过去照样拿不到结果**：
   * 主模型过载 → 降级 → 还是空 → 预算耗尽 → 用户只看到"AI 服务繁忙"。
   * 换言之：**降级链形同虚设**，表面上配了兜底，实际一步都兜不住。
   *
   * 主模型不关：解题、论文摘要这类工具**需要推理**，关了会明显降质。
   * 但降级的语义本就是"主路走不通了，先给我一个能用的答案"——
   * 此时"答案浅一点"远好过"没有答案"。
   *
   * ⚠️ 同样受 `cfg.disableThinking` 约束：换到不认识 `thinking` 的端点时，
   * 把 `LLM_DISABLE_THINKING` 设为 false 即可，无需改代码。
   */
  private forAttempt(body: Record<string, unknown>, index: number): Record<string, unknown> {
    if (index === 0 || !this.cfg.disableThinking) return body;
    return { ...body, thinking: { type: 'disabled' } };
  }

  /**
   * 按「主模型 → 降级模型」顺序请求，任一个成功即返回。
   *
   * 只在**可重试**失败（429 / 5xx / 网络超时）上换模型；确定性失败（400）直接抛出 ——
   * 模型名写错、参数不支持这类问题，换模型也一样失败，多打一次只是浪费一次往返。
   *
   * ⚠️ **整个循环共享一个时间预算**（`LLM_TOTAL_BUDGET_MS`）。这是本方法最容易写错的地方：
   * 若把预算放在 `postWithRetry` 里各自计算，模型数 × 重试数又会重新乘起来，
   * 等于没加限制。预算必须覆盖**所有模型、所有重试、所有退避**的总和。
   */
  private async postWithFallback(
    body: Record<string, unknown>,
    tier?: LlmCallOptions['tier'],
  ): Promise<unknown> {
    const models = this.modelsFor(tier);
    const budget = new TimeBudget(this.cfg.totalBudgetMs);
    let last: unknown;
    let attempted = 0;

    for (let i = 0; i < models.length; i++) {
      if (!budget.canAttempt()) break;
      try {
        attempted++;
        return await this.postWithRetry(this.forAttempt(body, i), models[i], budget);
      } catch (e) {
        if (e instanceof LlmRequestError && !e.retryable) throw toBizException(e);
        last = e;
        const next = models[i + 1];
        if (next && budget.canAttempt()) {
          this.logger?.warn(
            `LLM 主模型 ${models[i]} 不可用（${describeError(e)}），降级到 ${next}`,
            'LlmProvider',
          );
        }
      }
    }

    // 一次都没发出去（预算在首个请求前就已耗尽，或预算被配成 0）→ 必须说清原因，
    // 否则会走到 toBizException(undefined) 得到一句 "unknown"，线上无法归因。
    if (attempted === 0) {
      throw new BizException(
        ErrorCode.LlmUnavailable,
        { reason: 'budget-exhausted-before-first-attempt', totalBudgetMs: this.cfg.totalBudgetMs },
        'AI 服务暂时不可用，请稍后重试',
      );
    }
    throw toBizException(last);
  }

  /**
   * 指数退避重试（1s / 4s / 16s），受 `budget` 约束。
   *
   * 预算耗尽时**主动停下**而不是"再试最后一次"：剩余时间不足一次请求的典型耗时，
   * 再发出去也只会超时，却要真金白银地消耗供应商配额。
   */
  private async postWithRetry(
    body: Record<string, unknown>,
    model: string,
    budget: TimeBudget,
  ): Promise<unknown> {
    const max = Math.max(1, this.cfg.maxRetry);
    let lastErr: unknown;

    for (let attempt = 0; attempt < max; attempt++) {
      if (!budget.canAttempt()) break;

      try {
        return await this.postOnce(body, model, budget);
      } catch (e) {
        // 确定性失败（400）立刻抛出，不浪费退避时间
        if (e instanceof LlmRequestError && !e.retryable) throw e;
        lastErr = e;
      }

      if (attempt < max - 1) {
        const delay = budget.backoff(Math.pow(4, attempt) * 1000); // 1s, 4s, 16s
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw lastErr ?? new Error('LLM 请求失败');
  }

  /**
   * 单次 HTTP 请求。
   *
   * 非 2xx 一律转成 `LlmRequestError`，**可重试性在这里判定**：
   * 429（含智谱的 `1305` 过载）与 5xx 可重试，其余 4xx 是确定性失败。
   * 单独抽出来是为了让"重试循环"与"响应解读"各自保持低复杂度 ——
   * 混在一起时复杂度会顶到 lint 上限，改一处要重读整段。
   */
  private async postOnce(
    body: Record<string, unknown>,
    model: string,
    budget: TimeBudget,
  ): Promise<unknown> {
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ ...body, model }),
      // 单次超时同时受"per-attempt 上限"和"剩余总预算"约束
      signal: AbortSignal.timeout(budget.attemptTimeout(this.cfg.timeoutMs)),
    });

    if (res.ok) return await res.json();

    const text = (await res.text()).slice(0, 300);
    throw new LlmRequestError(res.status, res.status === 429 || res.status >= 500, text);
  }

  private normalize(json: unknown): LlmResponse {
    const j = json as {
      choices?: {
        finish_reason?: string;
        message?: {
          content?: string;
          reasoning_content?: string;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      model?: string;
    };

    const choice = j.choices?.[0];
    const msg = choice?.message;
    const content = msg?.content ?? '';
    const finishReason = choice?.finish_reason;
    const hasToolCalls = (msg?.tool_calls?.length ?? 0) > 0;

    assertContentPresent(content, hasToolCalls, msg?.reasoning_content, finishReason);

    return {
      content,
      toolCalls: msg?.tool_calls?.map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: c.function.arguments,
      })),
      usage: j.usage
        ? {
            promptTokens: j.usage.prompt_tokens ?? 0,
            completionTokens: j.usage.completion_tokens ?? 0,
            totalTokens: j.usage.total_tokens ?? 0,
          }
        : undefined,
      model: j.model,
      finishReason,
    };
  }
}

/**
 * 把 JSON Schema 追加成一条 system 消息。
 *
 * ## 为什么必须这么做（实测踩坑）
 *
 * Provider 用的是 `response_format: { type: 'json_object' }` —— 它只保证
 * "输出是合法 JSON"，**不保证结构**。所以结构只能靠提示词讲清楚。
 *
 * 为什么不改用 `json_schema`：智谱对它支持不可靠。实测同一 schema、同一提示词：
 *   · glm-4-flash + `json_schema`（strict 无论 true/false）→ 形状不符（返回嵌套对象）
 *   · glm-4-flash + `json_object`                        → ✅ 严格符合，且快一倍
 *   · glm-5.3-flash 三种模式都符合，但 `json_object` 最快（5.8s vs 9.2s）
 * 换言之 `json_object` + 明确提示词是**又快又稳**的组合。
 *
 * 注：下游仍必须**校验并兜底**（见 `normalizeIntent`）——
 * 提示词是"尽量遵守"，不是"强制保证"。
 */
function withSchemaHint(messages: LlmMessage[], schema: unknown): LlmMessage[] {
  const hint =
    '只输出 JSON，不要任何解释文字、不要 Markdown 围栏。' +
    '输出必须严格符合下面这个 JSON Schema（字段名、类型、数组元素类型都要一致）：\n' +
    JSON.stringify(schema);
  return [...messages, { role: 'system', content: hint }];
}

/**
 * 单次 HTTP 请求失败。
 *
 * **刻意不继承 `BizException`**：重试与降级循环需要区分"可重试"与"确定性失败"，
 * 而 `BizException` 在本项目里一律被当作确定性失败直接抛出。
 * 继承关系就是重试策略的开关 —— 分类错了，偶发故障就变成必然失败。
 * （同款取舍见 OCR Provider 的 `UnusableOutputError`。）
 */
class LlmRequestError extends Error {
  constructor(
    readonly status: number,
    readonly retryable: boolean,
    readonly body: string,
  ) {
    super(`LLM HTTP ${status}`);
    this.name = 'LlmRequestError';
  }
}

/** 把最后一类错误翻译成对用户有意义的业务异常 */
function toBizException(err: unknown): BizException {
  if (err instanceof LlmRequestError) {
    return new BizException(ErrorCode.LlmUnavailable, {
      status: err.status,
      body: err.body,
    });
  }
  return new BizException(ErrorCode.LlmUnavailable, {
    reason: (err as Error)?.message ?? 'unknown',
  });
}

/** 日志用的一句话描述（把厂商原始报文带上，便于判断是过载还是配置错） */
function describeError(err: unknown): string {
  if (err instanceof LlmRequestError) return `HTTP ${err.status} ${err.body.slice(0, 120)}`;
  return (err as Error)?.message ?? 'unknown';
}

