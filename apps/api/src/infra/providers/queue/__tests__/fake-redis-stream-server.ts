import { createServer, type Server, type Socket } from 'node:net';

import { INFO_REPLY, bulk, integer, parseRequest, write } from './fake-redis-resp';
import { FakeStreamStore } from './fake-redis-stream-model';

/**
 * 测试用 Redis Stream 替身（真实 RESP 协议，走 TCP）
 *
 * ## 为什么不用 20 行的内存假对象
 *
 * `RedisService` 的 Stream 方法要完成"选项对象 ↔ ioredis 位置参数"的翻译，
 * 并解析 Redis 的嵌套回复（XAUTOCLAIM 的三段式、XPENDING 的四元组）。
 * 用假对象只能验证**我自己对回复形状的假设**，验证不了命令拼接是否正确
 * （参数顺序错、少一个 `COUNT` 关键字，假对象照样"通过"）。
 *
 * 这里起一个真实 TCP 服务讲 RESP，让 **真实 ioredis** 连上去：
 *   · 命令拼错 → 真机 Redis 会报语法错，这里同样会（服务端做参数校验）；
 *   · 回复形状错 → ioredis 解析出的结构不对，业务断言就会失败。
 *
 * ## 它**不能**替代什么（重要，别当护身符）
 *
 * 它按公开文档实现 Stream 语义，但**不是 Redis 本身**。以下仍须真机验证：
 *   ① `BUSYGROUP` 等错误文案的确切形态；
 *   ② XAUTOCLAIM 在 Redis 6.2 / 7.x 之间的回复差异（nextCursor 行为）；
 *   ③ 大流量下的 BLOCK 行为、内存回收与流裁剪策略。
 * 本机没有 Redis 时的定位是"把能验的都验掉"，而不是"证明线上一定没问题"。
 *
 * ## 支持的命令
 *
 * PING / INFO / SELECT / AUTH / CLIENT / CONFIG（够 ioredis 建连）
 * XADD / XLEN / XGROUP CREATE / XREADGROUP / XACK / XAUTOCLAIM / XPENDING
 *
 * 职责边界：本文件只做**协议与连接**，Stream 语义在 `fake-redis-stream-model.ts`。
 */
export class FakeRedisStreamServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly store = new FakeStreamStore();
  /** 命令路由表（见 registerRoutes） */
  private readonly routes = new Map<string, Route>();

  /** 监听地址（start() 之后可用），形如 redis://127.0.0.1:53124 */
  url: string | null = null;

  /** 收到的命令（按序），便于断言"到底发了什么" */
  readonly commands: string[][] = [];

  constructor() {
    this.registerRoutes();
  }

  async start(): Promise<{ url: string; port: number }> {
    this.server = createServer((socket) => this.attach(socket));

    const port = await new Promise<number>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    this.url = `redis://127.0.0.1:${port}`;
    return { url: this.url, port };
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** 直接读某条流的内容（断言用） */
  entries(stream: string): { id: string; fields: Record<string, string> }[] {
    return this.store.entries(stream);
  }

  /** 某消费组的待确认列表（断言"消息确实留在 PEL"用） */
  pending(
    stream: string,
    group: string,
  ): { id: string; consumer: string; deliveryCount: number }[] {
    return this.store.pending(stream, group);
  }

  // ---------- 连接 ----------

  private attach(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => this.sockets.delete(socket));

    // 显式标注为 Buffer（而非 Buffer.alloc 推断出的 Buffer<ArrayBuffer>）：
    // 因为 parseRequest 回传的 subarray 是 Buffer<ArrayBufferLike>，两者不能互相赋值
    let buffer: Buffer = Buffer.alloc(0);
    /**
     * **逐条串行处理，且严格保序**。
     *
     * 这不是实现细节而是协议正确性的要求：客户端靠"回复到达顺序"与"命令发送顺序"
     * 一一对应来匹配请求。阻塞中的 XREADGROUP 若不挡住后续命令的回复，
     * XADD 的回复会先到达并被错配给 XREADGROUP —— 表现为 `enqueue()` 返回了一个
     * XREADGROUP 的回复数组（本文件第一版就踩了这个坑，靠 9 个用例才暴露出来）。
     *
     * 真实 Redis 也是这个行为：客户端阻塞期间发来的命令会在服务端排队，
     * 直到阻塞命令返回后才依次执行，因此回复顺序天然保持。
     */
    let chain: Promise<void> = Promise.resolve();
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const parsed = parseRequest(buffer);
        if (!parsed) break;
        buffer = parsed.rest;
        const { args } = parsed;
        chain = chain.then(() => this.handle(socket, args));
      }
    });
  }

  private async handle(socket: Socket, args: string[]): Promise<void> {
    this.commands.push(args);
    const route = this.routes.get((args[0] ?? '').toUpperCase());
    if (!route) {
      write(socket, `-ERR unknown command '${args[0]}'\r\n`);
      return;
    }
    try {
      await route(socket, args);
    } catch (e) {
      // 模型层抛出的文案必须与真实 Redis 一致（BUSYGROUP / NOGROUP）
      write(socket, `-${(e as Error).message}\r\n`);
    }
  }

  /**
   * 命令路由表。
   *
   * 用表驱动而不是一个 14 分支的 switch：一是把 `handle` 的圈复杂度压下来，
   * 二是新增命令只需加一行，不必再动分发逻辑。
   */
  private registerRoutes(): void {
    const ok = (socket: Socket): void => write(socket, '+OK\r\n');

    this.routes.set('PING', (socket) => write(socket, '+PONG\r\n'));
    this.routes.set('INFO', (socket) => write(socket, bulk(INFO_REPLY)));
    this.routes.set('SELECT', ok);
    this.routes.set('AUTH', ok);
    this.routes.set('CLIENT', ok);
    this.routes.set('CONFIG', (socket) => write(socket, '*0\r\n'));

    this.routes.set('XADD', (socket, args) =>
      write(socket, bulk(this.store.xadd(args[1], args[2], args.slice(3)))),
    );
    this.routes.set('XLEN', (socket, args) => write(socket, integer(this.store.xlen(args[1]))));
    this.routes.set('XGROUP', (socket, args) => this.xgroup(socket, args));
    this.routes.set('XREADGROUP', (socket, args) => this.xreadgroup(socket, args));
    this.routes.set('XACK', (socket, args) =>
      write(socket, integer(this.store.ack(args[1], args[2], args.slice(3)))),
    );
    this.routes.set('XAUTOCLAIM', (socket, args) => this.xautoclaim(socket, args));
    this.routes.set('XPENDING', (socket, args) => this.xpending(socket, args));
  }

  // ---------- 命令实现（参数校验与回复编码） ----------

  private xgroup(socket: Socket, args: string[]): void {
    if ((args[1] ?? '').toUpperCase() !== 'CREATE') {
      write(socket, `-ERR unknown XGROUP subcommand '${args[1]}'\r\n`);
      return;
    }
    try {
      const mkstream = args.some((a) => a.toUpperCase() === 'MKSTREAM');
      this.store.createGroup(args[2], args[3], args[4], mkstream);
      write(socket, '+OK\r\n');
    } catch (e) {
      write(socket, `-${(e as Error).message}\r\n`);
    }
  }

  private async xreadgroup(socket: Socket, args: string[]): Promise<void> {
    const parsed = parseReadGroupArgs(args);
    if (!parsed) {
      write(socket, '-ERR syntax error\r\n');
      return;
    }

    const { group, consumer, stream: key, id: idArg, count, blockMs } = parsed;
    let entries: [string, string[]][];
    try {
      entries = await this.store.readGroup(key, group, consumer, idArg, count, blockMs);
    } catch (e) {
      write(socket, `-${(e as Error).message}\r\n`);
      return;
    }

    // 阻塞超时无消息时，真实 Redis 返回 null 数组
    if (entries.length === 0) {
      write(socket, '*-1\r\n');
      return;
    }

    write(
      socket,
      `*1\r\n*2\r\n${bulk(key)}*${entries.length}\r\n${entries.map(encodeEntry).join('')}`,
    );
  }

  private xautoclaim(socket: Socket, args: string[]): void {
    const [, key, group, consumer, minIdleArg, start] = args;
    const countIdx = args.findIndex((a) => a.toUpperCase() === 'COUNT');
    const count = countIdx > 0 ? Number(args[countIdx + 1]) : 100;

    let claimed: [string, string[]][];
    let deleted: string[];
    try {
      ({ claimed, deleted } = this.store.autoClaim(
        key,
        group,
        consumer,
        Number(minIdleArg),
        start,
        count,
      ));
    } catch (e) {
      write(socket, `-${(e as Error).message}\r\n`);
      return;
    }

    // 简化：一次扫完即返回 '0-0'（真实 Redis 7 会返回可续扫的游标）
    write(
      socket,
      `*3\r\n${bulk('0-0')}*${claimed.length}\r\n${claimed.map(encodeEntry).join('')}` +
        `*${deleted.length}\r\n${deleted.map(bulk).join('')}`,
    );
  }

  private xpending(socket: Socket, args: string[]): void {
    const [, key, group, start, end, countArg] = args;
    const count = countArg === undefined ? 100 : Number(countArg);
    const rows = this.store
      .pendingDetail(key, group, start, end, count)
      .map(
        ([id, consumer, idleMs, deliveryCount]) =>
          `*4\r\n${bulk(id)}${bulk(consumer)}${integer(idleMs)}${integer(deliveryCount)}`,
      );

    write(socket, `*${rows.length}\r\n${rows.join('')}`);
  }
}

/** 一条命令的处理函数 */
type Route = (socket: Socket, args: string[]) => void | Promise<void>;

/** 一条流消息编码为 `*2\r\n$id $fields...` */
function encodeEntry([id, fields]: [string, string[]]): string {
  return `*2\r\n${bulk(id)}*${fields.length}\r\n${fields.map(bulk).join('')}`;
}

/** XREADGROUP 参数解析结果 */
interface ReadGroupArgs {
  group: string;
  consumer: string;
  stream: string;
  id: string;
  count: number;
  blockMs: number;
}

/** 解析 `GROUP g c [COUNT n] [BLOCK ms] STREAMS key id`；语法不符返回 null */
function parseReadGroupArgs(args: string[]): ReadGroupArgs | null {
  if ((args[1] ?? '').toUpperCase() !== 'GROUP') return null;

  const streamsIdx = args.findIndex((a) => a.toUpperCase() === 'STREAMS');
  if (streamsIdx < 0) return null;

  const out: ReadGroupArgs = {
    group: args[2],
    consumer: args[3],
    stream: '',
    id: '',
    count: 10,
    blockMs: 0,
  };

  for (let i = 4; i < streamsIdx; i++) {
    const token = args[i].toUpperCase();
    if (token === 'COUNT') out.count = Number(args[++i]);
    else if (token === 'BLOCK') out.blockMs = Number(args[++i]);
    else if (token === 'NOACK')
      continue; // 本项目不用，忽略
    else return null;
  }

  out.stream = args[streamsIdx + 1];
  out.id = args[streamsIdx + 2];
  return out.stream && out.id ? out : null;
}
