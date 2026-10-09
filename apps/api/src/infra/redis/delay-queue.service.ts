import { Injectable } from '@nestjs/common';

import { AppLogger } from '../../common/logger/logger.service';

import { RedisService } from './redis.service';
import type { DelayQueueItem } from './redis.types';

/**
 * 原子取出到期任务：取 ZSET 中 score <= now 的前 N 个并同时移除。
 * 必须用 Lua 保证"读 + 删"原子，否则多 Worker 会取到同一批任务。
 */
const POLL_SCRIPT = `
local items = redis.call('zrangebyscore', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
if #items > 0 then
  redis.call('zrem', KEYS[1], unpack(items))
end
return items
`;

/**
 * 延迟队列（任务清单 M0-11）
 *
 * 基于 ZSET：score = 计划执行时间戳，member = 任务 JSON。
 * 用于"30 分钟后关闭未支付订单""7 天后自动验收"这类**定时触发**场景。
 * 与队列 Worker（M1-04 的 Redis Stream）分工不同：那边是"立即执行的异步任务"，这边是"到点才执行"。
 *
 * 降级：Redis 不可用时**抛错**，不静默丢弃。
 * 这与缓存/锁/限流的 fail-open 相反，判据是"降级后是否会静默丢数据"——
 * 延迟任务丢了就是真的丢了（订单永远不会被自动关闭），必须让调用方感知并补偿。
 */
@Injectable()
export class DelayQueueService {
  constructor(
    private readonly redis: RedisService,
    private readonly logger: AppLogger,
  ) {}

  /**
   * 入队一个延迟任务。
   * @param queue  队列名，如 `delay:order-autoclose`
   * @param payload 任意可 JSON 序列化的载荷
   * @param delayMs 延迟毫秒数
   * @returns 任务 id（可用于取消）
   */
  async enqueue(queue: string, payload: unknown, delayMs: number): Promise<string> {
    const client = this.redis.raw;
    if (!client) {
      throw new Error(`Redis 不可用，无法写入延迟队列 ${queue}（延迟任务不可静默丢弃）`);
    }

    const runAt = Date.now() + Math.max(0, delayMs);
    // member 必须唯一：相同载荷在同一毫秒入队会被 ZSET 去重，故拼一个随机 id
    const id = `${runAt}-${Math.random().toString(36).slice(2, 10)}`;
    const member = JSON.stringify({ id, runAt, payload });

    try {
      await client.zadd(queue, runAt, member);
      return id;
    } catch (e) {
      this.logger.error(
        `延迟队列入队失败（${queue}）：${(e as Error).message}`,
        undefined,
        'DelayQueue',
      );
      throw e;
    }
  }

  /** 取出到期任务（原子取出并移除）；Redis 不可用时抛错 */
  async poll(queue: string, limit = 10): Promise<DelayQueueItem[]> {
    const client = this.redis.raw;
    if (!client) {
      throw new Error(`Redis 不可用，无法读取延迟队列 ${queue}`);
    }

    try {
      const raw = (await client.eval(POLL_SCRIPT, 1, queue, Date.now(), limit)) as string[];
      return (raw ?? []).map(parseItem).filter((x): x is DelayQueueItem => x !== null);
    } catch (e) {
      this.logger.error(
        `延迟队列出队失败（${queue}）：${(e as Error).message}`,
        undefined,
        'DelayQueue',
      );
      throw e;
    }
  }

  /** 队列积压量（监控用）；Redis 不可用时返回 -1 以便与"真的为空"区分 */
  async size(queue: string): Promise<number> {
    const client = this.redis.raw;
    if (!client) return -1;
    try {
      // ZCARD 走 eval，避免为它单独扩 RedisLike 接口
      const n = await client.eval("return redis.call('zcard', KEYS[1])", 1, queue);
      return typeof n === 'number' ? n : Number(n ?? 0);
    } catch {
      return -1;
    }
  }
}

/** 单条 member 解析；脏数据返回 null 由调用方丢弃 */
function parseItem(member: string): DelayQueueItem | null {
  try {
    const parsed = JSON.parse(member) as { payload?: unknown; runAt?: number };
    return {
      payload: JSON.stringify(parsed.payload ?? null),
      runAt: typeof parsed.runAt === 'number' ? parsed.runAt : 0,
    };
  } catch {
    return null;
  }
}
