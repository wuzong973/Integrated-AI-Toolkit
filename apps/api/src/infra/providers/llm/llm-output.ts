/**
 * LLM 产出解析与校验（从 `openai-compatible.provider.ts` 拆出）
 *
 * ## 为什么单独成文件
 *
 * 那个文件已贴 300 行红线，而这三个纯函数（产出校验 / JSON 提取）
 * 与"怎么发 HTTP 请求、怎么重试降级"是两件事：
 * 前者是**对模型输出的判断**，后者是**对网络行为的编排**。
 * 拆开后两者都能被单测直接打靶 —— 判断逻辑不该埋在 300 行的类里。
 */
import { BizException, ErrorCode } from '@qz/core';
/**
 * **空内容必须视为失败**，而不是把空串往上抛。
 *
 * 实测场景：推理型模型（智谱 GLM-4.7 / 5.x）在 `max_tokens` 太小时，
 * 会把全部 token 花在 `reasoning_content` 上、`content` 返回空 ——
 * 实测 max_tokens=300 时有 1007 字符的推理、0 字符结论。
 * 如果不拦住，下游会把"空大纲"当成成功结果存库：用户拿到一个只有标题的 PPT，
 * 还以为 AI 就这水平。这里 fail loudly，让问题立刻可见、可修。
 *
 * （`reasoning_content` 长度会附在 detail 里，方便从日志判断是不是 token 被推理吃完了。）
 */
/**
 * 产出可用性校验（空内容 / 只出推理 / 被截断）。
 *
 * ## 为什么"截断"必须在这里拦（Q8）
 *
 * `finish_reason: length` 表示模型把 `max_tokens` 用完了、回答**没写完**。
 * 但 HTTP 仍是 200、内容也非空 —— 于是它会一路通过所有校验，
 * 作为"正常结果"落盘交付。用户拿到的是一篇**戛然而止的文档**，
 * 而系统里没有任何地方记录过这件事。
 *
 * 实测形态：长文档生成时最后一句停在"…"或半句话中间，
 * 下载下来才发现少了一整节。这类问题在数据上不可查（没有报错、没有标记）。
 *
 * 处理取"宁可失败也不交付半成品"：正文类内容被截断即视为不可用，
 * 由上层重试（`LLM_MAX_RETRY`）或如实报错，而不是静默交付。
 */
export function assertContentPresent(
  content: string,
  hasToolCalls: boolean,
  reasoning?: string,
  finishReason?: string,
): void {
  // 工具调用不受此限：模型发起 tool_call 后本就不再输出正文，
  // 那种情况下 finish_reason 是 tool_calls，属正常协议流程。
  if (hasToolCalls) return;
  if (finishReason === 'length') {
    throw new BizException(
      ErrorCode.AiOutputInvalid,
      { finishReason, contentLength: content.length },
      `模型输出被截断（内容只写到 ${content.length} 字符就达到上限）—— 请调大 max_tokens 或减少要求的内容量`,
    );
  }
  if (content.trim()) return;

  const reasoningLen = (reasoning ?? '').length;
  throw new BizException(
    ErrorCode.AiOutputInvalid,
    { reasoningLength: reasoningLen },
    reasoningLen > 0
      ? `模型只输出了推理过程（${reasoningLen} 字符）没有结论，通常是把 max_tokens 花完了 —— 请调大 max_tokens 或降低推理深度`
      : '模型返回了空内容',
  );
}

/** 从可能带 markdown 围栏的文本中提取 JSON（模型常见输出形态） */
export function extractJson(text: string): string {
  const t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();
  const start = t.search(/[[{]/);
  if (start > 0) {
    const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (end > start) return t.slice(start, end + 1);
  }
  return t;
}
