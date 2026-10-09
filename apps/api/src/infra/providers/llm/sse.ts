/**
 * SSE（Server-Sent Events）分片解码。
 *
 * 从 `openai-compatible.provider.ts` 抽出来的原因很实际：那个文件已经顶到
 * ESLint 的 `max-lines`（300 行，跳过空行与注释）上限，再加逻辑就过不了 lint。
 * 而这两段代码**与 LLM 协议无关** —— 任何流式 HTTP 接口都是同一套解码，
 * 放独立文件后也更容易单测。
 */
/**
 * 消费 SSE 流（把分片解码逻辑独立出来，便于单测与复用）
 * 返回累计的完整文本。
 */
export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onChunk: (delta: string) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const delta = parseSseLine(line);
      if (delta) {
        full += delta;
        onChunk(delta);
      }
    }
  }
  return full;
}

/** 解析单行 SSE：data: {...} -> choices[0].delta.content */
export function parseSseLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return '';
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return '';
  try {
    const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
    return parsed.choices?.[0]?.delta?.content ?? '';
  } catch {
    return '';
  }
}
