/**
 * 队列消息的编解码与常量（M1-04）
 *
 * 消息体单独成文件而不是内联在 Provider 里，原因是它同时被**生产者**
 * （`RedisStreamQueueProvider.enqueue`）与**消费者**（`RedisStreamConsumer`）使用：
 * 放在任一侧都会让另一侧产生无谓的依赖方向。
 *
 * 兼容性纪律：本结构会**长期留在 Redis 里**（消息可能在升级期间驻留）。
 * 新增字段必须给默认值，且不能重命名既有字段 —— 否则滚动升级时旧消息会被判为脏消息丢弃。
 */

/** 消息载荷在流中的字段名（单字段 JSON，便于以后扩字段而不破坏旧消息） */
export const PAYLOAD_FIELD = 'p';

/** 死信流后缀 */
export const DEAD_SUFFIX = ':dead';

/** 队列消息体 */
export interface QueueMessageBody {
  /** 队列名（与流名分开记录，便于只凭消息定位业务语义） */
  name: string;
  payload: unknown;
  maxAttempts: number;
  attempts: number;
  enqueuedAt: number;
}

/** 扁平字段数组 `[k1, v1, k2, v2]` → 对象 */
export function toFieldMap(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) out[fields[i]] = fields[i + 1];
  return out;
}

/** 解析消息体；格式不符返回 null（调用方负责确认并丢弃，避免永久占据待确认列表） */
export function parseQueueMessage(raw: string | undefined): QueueMessageBody | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<QueueMessageBody>;
    if (typeof parsed?.name !== 'string') return null;
    return {
      name: parsed.name,
      payload: parsed.payload,
      maxAttempts: typeof parsed.maxAttempts === 'number' ? parsed.maxAttempts : 3,
      attempts: typeof parsed.attempts === 'number' ? parsed.attempts : 0,
      enqueuedAt: typeof parsed.enqueuedAt === 'number' ? parsed.enqueuedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

/** 不阻止进程退出的 sleep：循环让步与退避都用它 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
