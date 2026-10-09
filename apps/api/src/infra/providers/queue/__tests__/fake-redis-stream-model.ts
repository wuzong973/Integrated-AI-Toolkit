import { compareId, delay, flatten, idInRange } from './fake-redis-resp';

/**
 * 测试替身的 Stream 数据模型
 *
 * 与 `fake-redis-stream-server.ts` 拆开：那边只管 RESP 协议与连接，
 * 这边只管 **Redis Stream 的语义**（待确认列表、消费组游标、认领与投递计数）。
 * 分开的好处是"协议对不对"和"语义对不对"可以分别读、分别改。
 *
 * 抛出的 Error 会被上层原样写成 RESP 错误回复，因此
 * **错误文案必须与真实 Redis 一致**（例如 BUSYGROUP 前缀）——
 * 被验证的生产代码正是靠这些前缀判断分支的。
 */
export class FakeStreamStore {
  private readonly streams = new Map<string, StreamState>();

  /** XADD；`idArg` 传 '*' 时自动生成 */
  xadd(key: string, idArg: string, fields: string[]): string {
    if (fields.length === 0 || fields.length % 2 !== 0) {
      throw new Error('wrong number of arguments for XADD');
    }
    const stream = this.stream(key);
    const id = idArg === '*' ? stream.nextId() : idArg;

    const map: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) map[fields[i]] = fields[i + 1];
    stream.entries.set(id, map);
    return id;
  }

  /** XLEN */
  xlen(key: string): number {
    return this.stream(key).entries.size;
  }

  /** XGROUP CREATE；组已存在时抛 BUSYGROUP（与真实 Redis 一致） */
  createGroup(key: string, group: string, idArg: string, mkstream: boolean): void {
    if (!this.streams.has(key)) {
      if (!mkstream) throw new Error('The XGROUP subcommand requires the key to exist');
      this.stream(key);
    }

    const stream = this.stream(key);
    if (stream.groups.has(group)) {
      throw new Error('BUSYGROUP Consumer Group name already exists');
    }

    stream.groups.set(group, {
      lastDeliveredId: idArg === '$' ? stream.lastId() : '0-0',
      pending: new Map(),
      consumers: new Set(),
    });
  }

  /** XREADGROUP；无消息且 blockMs>0 时等待后再试一次，仍无则返回空数组 */
  async readGroup(
    key: string,
    group: string,
    consumer: string,
    idArg: string,
    count: number,
    blockMs: number,
  ): Promise<[string, string[]][]> {
    const stream = this.streams.get(key);
    const g = stream?.groups.get(group);
    if (!stream || !g) {
      throw new Error(`NOGROUP No such key '${key}' or consumer group '${group}'`);
    }

    let entries = readEntries(stream, g, consumer, idArg, count);
    if (entries.length === 0 && blockMs > 0) {
      await delay(Math.min(blockMs, 200));
      entries = readEntries(stream, g, consumer, idArg, count);
    }
    return entries;
  }

  /** XACK；返回成功确认的条数 */
  ack(key: string, group: string, ids: string[]): number {
    const g = this.streams.get(key)?.groups.get(group);
    if (!g) return 0;
    let acked = 0;
    for (const id of ids) {
      if (g.pending.delete(id)) acked += 1;
    }
    return acked;
  }

  /**
   * XAUTOCLAIM 的核心：挑出空闲超时且内容仍在的条目并转移所有权。
   * 内容已被删除的条目直接从待确认列表移除并单独回报（客户端必须据此清理）。
   */
  autoClaim(
    key: string,
    group: string,
    consumer: string,
    minIdleMs: number,
    start: string,
    count: number,
  ): { claimed: [string, string[]][]; deleted: string[] } {
    const stream = this.streams.get(key);
    const g = stream?.groups.get(group);
    if (!stream || !g) {
      throw new Error(`NOGROUP No such key '${key}' or consumer group '${group}'`);
    }

    const now = Date.now();
    const claimed: [string, string[]][] = [];
    const deleted: string[] = [];

    for (const [id, p] of [...g.pending.entries()]) {
      if (claimed.length >= count) break;
      if (compareId(id, start) < 0) continue;

      const entry = stream.entries.get(id);
      if (!entry) {
        g.pending.delete(id);
        deleted.push(id);
        continue;
      }
      if (now - p.lastDeliveredAt < minIdleMs) continue;

      // 认领：更换持有者并把投递次数 +1（与真实 Redis 一致）
      p.consumer = consumer;
      p.deliveryCount += 1;
      p.lastDeliveredAt = now;
      g.consumers.add(consumer);
      claimed.push([id, flatten(entry)]);
    }

    return { claimed, deleted };
  }

  /** XPENDING 明细：[id, consumer, idleMs, deliveryCount] */
  pendingDetail(
    key: string,
    group: string,
    start: string,
    end: string,
    count: number,
  ): [string, string, number, number][] {
    const g = this.streams.get(key)?.groups.get(group);
    if (!g) return [];

    const now = Date.now();
    return [...g.pending.entries()]
      .filter(([id]) => idInRange(id, start, end))
      .sort(([a], [b]) => compareId(a, b))
      .slice(0, count)
      .map(([id, p]) => [id, p.consumer, now - p.lastDeliveredAt, p.deliveryCount]);
  }

  // ---------- 断言用的直读接口 ----------

  /** 流内容 */
  entries(key: string): { id: string; fields: Record<string, string> }[] {
    const s = this.streams.get(key);
    if (!s) return [];
    return [...s.entries.entries()].map(([id, fields]) => ({ id, fields }));
  }

  /** 待确认列表 */
  pending(key: string, group: string): { id: string; consumer: string; deliveryCount: number }[] {
    const g = this.streams.get(key)?.groups.get(group);
    if (!g) return [];
    return [...g.pending.entries()].map(([id, p]) => ({
      id,
      consumer: p.consumer,
      deliveryCount: p.deliveryCount,
    }));
  }

  // ---------- 内部 ----------

  private stream(key: string): StreamState {
    let s = this.streams.get(key);
    if (!s) {
      s = {
        entries: new Map(),
        groups: new Map(),
        lastMs: 0,
        lastSeq: 0,
        nextId(): string {
          const ms = Date.now();
          if (ms > this.lastMs) {
            this.lastMs = ms;
            this.lastSeq = 0;
          } else {
            this.lastSeq += 1;
          }
          return `${this.lastMs}-${this.lastSeq}`;
        },
        lastId(): string {
          const ids = [...this.entries.keys()];
          return ids.length ? ids[ids.length - 1] : '0-0';
        },
      };
      this.streams.set(key, s);
    }
    return s;
  }
}

// ==================== 内部类型与算法 ====================

interface StreamState {
  entries: Map<string, Record<string, string>>;
  groups: Map<string, GroupState>;
  lastMs: number;
  lastSeq: number;
  nextId(): string;
  lastId(): string;
}

interface GroupState {
  lastDeliveredId: string;
  pending: Map<string, { consumer: string; deliveryCount: number; lastDeliveredAt: number }>;
  consumers: Set<string>;
}

/** 读新消息（id='>'）或重读某消费者自己的待确认消息 */
function readEntries(
  stream: StreamState,
  group: GroupState,
  consumer: string,
  idArg: string,
  count: number,
): [string, string[]][] {
  if (idArg === '>') {
    const fresh = [...stream.entries.entries()]
      .filter(([id]) => compareId(id, group.lastDeliveredId) > 0)
      .slice(0, count);
    for (const [id] of fresh) {
      group.lastDeliveredId = id;
      group.consumers.add(consumer);
      group.pending.set(id, { consumer, deliveryCount: 1, lastDeliveredAt: Date.now() });
    }
    return fresh.map(([id, fields]) => [id, flatten(fields)]);
  }
  return [...group.pending.entries()]
    .filter(([id, p]) => p.consumer === consumer && compareId(id, idArg) > 0)
    .slice(0, count)
    .map(([id]) => [id, flatten(stream.entries.get(id) ?? {})]);
}
