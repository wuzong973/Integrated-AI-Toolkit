/**
 * Redis 底层能力的最小接口（任务清单 M0-11）
 *
 * 为什么单独定义而不是直接用 ioredis 的 Redis 类型：
 *   ① ioredis 的 set/zrangebyscore 是重载签名，直接依赖它会让单测难以构造假实现；
 *   ② 这里只声明本项目实际用到的命令，等于给"Redis 封装"划了一条明确的能力边界；
 *   ③ 单测可以传入 20 行的假客户端，不需要起真实 Redis。
 *
 * 纪律：新增 Redis 命令请先在这里声明，再在 RedisService 暴露出去。
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  /** SET key value NX PX ttl —— 成功返回 'OK'，未抢到返回 null */
  set(key: string, value: string, mode: 'NX', ttlMode: 'PX', ttl: number): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  pttl(key: string): Promise<number>;
  /** 用于"比较并删除"这类必须原子化的操作 */
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  zadd(key: string, score: number, member: string): Promise<number>;
  /** 取 score 落在 [min, max] 的成员，最多 count 个（由调用方传 'LIMIT' 0 count） */
  zrangebyscore(
    key: string,
    min: string | number,
    max: string | number,
    limitToken: 'LIMIT',
    offset: number,
    count: number,
  ): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<number>;
  ping(): Promise<string>;
}

// ==================== Stream（M1-04 队列 Worker）====================
//
// 为什么 Stream 命令**不进** RedisLike：
//   RedisLike 是"缓存/锁/限流/延迟队列"共用的最小接口，其假实现只需 20 行。
//   Stream 命令的入口是 RedisService 上的专用方法（xadd / xreadGroup / xautoclaim ...），
//   由它把 ioredis 的位置参数形式适配成下面的选项对象形式 —— 那层适配是**实现细节**，
//   不该污染最小接口，也不该逼着每个假实现去补 7 个用不到的空方法。
//   队列的验证走"真实 RESP 服务 + 真实 ioredis"（见 __tests__/fake-redis-stream-server.ts），
//   比假实现更有说服力。

/** XREADGROUP 入参 */
export interface XReadGroupParams {
  /** 消费组名 */
  group: string;
  /** 消费者名（同一组内唯一，用于区分是哪个 Worker 持有消息） */
  consumer: string;
  /** 单次最多读几条 */
  count: number;
  /** 阻塞等待毫秒数；0 表示永久阻塞（本项目不用，会把关停拖住） */
  blockMs: number;
  /** 流名 */
  stream: string;
  /** `>` 读从未投递过的新消息；具体 id 表示重读自己的待确认消息 */
  id: string;
}

/** XREADGROUP 回复：[流名, [[消息id, [字段, 值, 字段, 值...]], ...]][] */
export type XReadGroupReply = [stream: string, entries: [id: string, fields: string[]][]][];

/** XAUTOCLAIM 入参 */
export interface XAutoClaimParams {
  stream: string;
  group: string;
  consumer: string;
  /** 空闲超过该毫秒数才算"原消费者已失联" */
  minIdleMs: number;
  /** 扫描起点，通常从 '0-0' 开始 */
  start: string;
  count: number;
}

/** XAUTOCLAIM 结果 */
export interface XAutoClaimResult {
  /**
   * 下次扫描游标；为 '0-0' 表示本轮已扫完。
   * Redis 7 起该字段可能返回 "0-0" 之外的游标，调用方需原样带回。
   */
  nextStart: string;
  /** 成功认领的消息 */
  messages: XStreamMessage[];
  /**
   * 已被删除的消息 id（PEL 里还留着，但流里的内容已被 XDEL/裁剪）。
   * 这类条目**必须 ACK 清理**，否则会永远留在 PEL 里被反复扫描。
   */
  deleted: string[];
}

/** 一条流消息 */
export interface XStreamMessage {
  id: string;
  /** 字段名 → 值 */
  fields: Record<string, string>;
}

/** XPENDING 明细入参 */
export interface XPendingParams {
  stream: string;
  group: string;
  /** 起始 id（含），通常用 '-' 或具体 id */
  start: string;
  /** 结束 id（含），通常用 '+' 或具体 id */
  end: string;
  count: number;
}

/** XPENDING 明细条目 */
export interface XPendingEntry {
  id: string;
  /** 当前持有该消息的消费者 */
  consumer: string;
  /** 空闲毫秒数 */
  idleMs: number;
  /** 投递次数（每次 XCLAIM / XAUTOCLAIM 都会 +1）—— 死信判定的依据 */
  deliveryCount: number;
}

/** 限流结果（供调用方决定是否拒绝并给出 retryAfter） */
export interface RateLimitResult {
  allowed: boolean;
  /** 本窗口内剩余可用次数；Redis 不可用时为 limit（即视为未消耗） */
  remaining: number;
  /** 窗口重置剩余毫秒；Redis 不可用时为 0 */
  resetInMs: number;
  /** 是否处于降级放行状态（Redis 不可用） */
  degraded: boolean;
}

/** 延迟队列取出的任务 */
export interface DelayQueueItem {
  payload: string;
  /** 计划执行时间（毫秒时间戳） */
  runAt: number;
}
