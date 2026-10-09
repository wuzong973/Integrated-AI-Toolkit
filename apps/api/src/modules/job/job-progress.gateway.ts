import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { JobProgressSnapshot, WsClientMessage, WsServerMessage } from '@qz/core';
import { WebSocket, WebSocketServer } from 'ws';

import { AppLogger } from '../../common/logger/logger.service';
import { TokenService } from '../auth/token.service';

import { JobEventsService } from './job-events.service';
import { JobService } from './job.service';

/** WebSocket 路径（文档 9.3：`wss://api.xxx/ws?token=<accessToken>`，不带 API 前缀） */
export const WS_PATH = '/ws';

/** 单连接最多订阅的作业数（防止一个连接把内存拖爆） */
const MAX_SUBSCRIPTIONS = 50;

/** 服务端心跳间隔：主动 ping 探测半开连接 */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** 一次订阅请求最多接受的作业 id 数（与 MAX_SUBSCRIPTIONS 一致，超出直接拒绝） */
const MAX_JOB_IDS_PER_REQUEST = 50;

/** 关闭码：鉴权失败（应用自定义区间 4000-4999） */
const CLOSE_UNAUTHORIZED = 4401;

/**
 * 作业进度推送网关（任务清单 M1-05）
 *
 * 实现文档 9.3 的协议：
 *   · 连接 `ws://host/ws?token=<accessToken>`，**连接时即鉴权**，失败关闭 4401；
 *   · 客户端发 `{type:'subscribe',jobIds:[...]}`，服务端先回 `subscribed`，
 *     随即**逐个下发当前状态快照** —— 这就是"断线重连后可补齐进度"的实现方式：
 *     客户端只要在（重）连后重新订阅，就必然拿到服务端权威状态，
 *     不需要自己去算"断线期间漏了哪几条"。
 *   · 心跳：客户端 `ping` → 服务端 `pong`；服务端另有 ws 层 ping 清理半开连接。
 *
 * ## 为什么用原生 ws 而不是 NestJS 的 `@WebSocketGateway`
 *
 * 网关的对外协议是**文档规定的公开契约**（`{type, jobId, progress...}`），
 * 而 Nest 的 WS 适配器会把线上格式绑成它自己的信封（`{event, data}`）。
 * 用原生 ws 可以把契约握在自己手里，也少两个依赖
 * （`@nestjs/websockets` + `@nestjs/platform-ws`）。
 * 连接生命周期与依赖注入仍然由 Nest 管（本类就是普通 Provider，由 main.ts 挂载）。
 *
 * ## 为什么不用它替代轮询
 *
 * WebSocket 会因切后台、弱网、代理超时而断；小程序尤其如此。
 * 因此这里只做"更快"，**权威性始终在 HTTP 接口**（GET /jobs/:id）。
 * 前端在 WS 不可用时自动退回轮询（见 apps/mp/utils/ws.ts）。
 */
@Injectable()
export class JobProgressGateway implements OnModuleDestroy {
  private wss: WebSocketServer | null = null;
  /** 连接 → 会话状态 */
  private readonly clients = new Map<WebSocket, ClientSession>();
  private heartbeat: NodeJS.Timeout | null = null;
  private httpServer: HttpServer | null = null;

  constructor(
    private readonly tokens: TokenService,
    private readonly events: JobEventsService,
    private readonly jobs: JobService,
    private readonly logger: AppLogger,
  ) {}

  /**
   * 挂到 HTTP 服务器上（由 main.ts 调用）。
   *
   * 用 `noServer: true` + 手动处理 upgrade，而不是让 ws 自己监听端口：
   * ① 复用同一个端口，部署时不用为 WS 单开端口与证书；
   * ② 可以按路径分发，未来 `/ws/os` 之类只需再加一个分支，互不干扰。
   */
  attach(server: HttpServer): void {
    if (this.wss) return;
    this.httpServer = server;

    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));

    this.heartbeat = setInterval(() => this.sweepDeadConnections(), HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();

    this.logger.log(`进度推送网关已挂载：${WS_PATH}?token=<accessToken>`, 'WsGateway');
  }

  onModuleDestroy(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const client of this.clients.keys()) client.terminate();
    this.clients.clear();
    this.httpServer?.off('upgrade', this.onUpgrade);
    this.wss?.close();
    this.wss = null;
  }

  /** 当前连接数（供 /health 观测） */
  get connectionCount(): number {
    return this.clients.size;
  }

  // ---------- 连接生命周期 ----------

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // 路径不匹配时**不处理也不销毁** socket，留给其他 upgrade 监听者；
    // 直接 destroy 会把未来的 /ws/xxx 一起打死
    if (url.pathname !== WS_PATH || !this.wss) return;

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      void this.onConnection(ws, url);
    });
  }

  private async onConnection(ws: WebSocket, url: URL): Promise<void> {
    const userId = await this.authenticate(url.searchParams.get('token'));
    if (!userId) {
      this.send(ws, { type: 'error', message: '登录状态无效或已过期，请重新登录' });
      ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
      return;
    }

    const session: ClientSession = { userId, jobIds: new Set(), alive: true };
    this.clients.set(ws, session);

    // 订阅该用户的事件；取消订阅函数随连接关闭一起调用
    session.unsubscribe = this.events.subscribe(userId, (message) => {
      // 只推给"订阅了这个作业"的连接：同账号可能有多个端（手机 + H5），
      // 各自页面不同，不做这层过滤会把消息推给无关页面
      if (!message.jobId || session.jobIds.has(message.jobId)) this.send(ws, message);
    });

    ws.on('message', (raw) => void this.onMessage(ws, session, raw.toString()));
    ws.on('pong', () => {
      session.alive = true;
    });
    ws.on('close', () => this.cleanup(ws, session));
    ws.on('error', () => this.cleanup(ws, session));

    this.logger.log(
      `进度推送连接已建立（用户 ${userId.slice(0, 8)}…，当前 ${this.clients.size} 条）`,
      'WsGateway',
    );
  }

  private cleanup(ws: WebSocket, session: ClientSession): void {
    session.unsubscribe?.();
    session.unsubscribe = undefined;
    this.clients.delete(ws);
  }

  /** 校验 token；失败返回 null（不区分"过期"与"伪造"，避免成为探测工具） */
  private async authenticate(token: string | null): Promise<string | null> {
    if (!token) return null;
    try {
      const payload = await this.tokens.verifyAccess(token);
      return payload.sub;
    } catch {
      return null;
    }
  }

  // ---------- 客户端消息 ----------

  private async onMessage(ws: WebSocket, session: ClientSession, raw: string): Promise<void> {
    const message = parseClientMessage(raw);
    if (!message) {
      this.send(ws, { type: 'error', message: '消息格式不正确' });
      return;
    }

    switch (message.type) {
      case 'ping':
        this.send(ws, { type: 'pong', at: new Date().toISOString() });
        return;
      case 'subscribe':
        await this.onSubscribe(ws, session, message.jobIds ?? []);
        return;
      case 'unsubscribe':
        for (const id of message.jobIds ?? []) session.jobIds.delete(id);
        this.send(ws, { type: 'unsubscribed', jobIds: [...session.jobIds] });
        return;
      default:
        this.send(ws, { type: 'error', message: `不支持的事件：${String(message.type)}` });
    }
  }

  /**
   * 订阅作业进度。
   *
   * 两步且顺序固定：
   *   ① 先按**归属过滤**（一次批量查询）—— 只能订阅自己的作业，
   *      他人作业的 id 会被静默剔除（不回报"无权访问"，否则等于告知该 id 存在）；
   *   ② 回 `subscribed` 告知实际生效的订阅，再**立即下发每个作业的当前快照**。
   *      快照是重连补齐进度的关键：客户端不必自己算漏了哪几条。
   */
  private async onSubscribe(
    ws: WebSocket,
    session: ClientSession,
    jobIds: string[],
  ): Promise<void> {
    const requested = jobIds
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .slice(0, MAX_JOB_IDS_PER_REQUEST);

    let snapshots: JobProgressSnapshot[];
    try {
      snapshots = await this.jobs.snapshotsFor(session.userId, requested);
    } catch (e) {
      this.send(ws, { type: 'error', message: `订阅失败：${(e as Error).message}` });
      return;
    }

    for (const snapshot of snapshots) {
      if (session.jobIds.size >= MAX_SUBSCRIPTIONS) break;
      session.jobIds.add(snapshot.jobId);
    }

    this.send(ws, { type: 'subscribed', jobIds: [...session.jobIds] });
    for (const snapshot of snapshots) {
      if (session.jobIds.has(snapshot.jobId)) this.events.sendSnapshot(session.userId, snapshot);
    }
  }

  // ---------- 心跳与发送 ----------

  /** 清理半开连接：ws 层 ping 无 pong 即判定已死（小程序切后台时常发生） */
  private sweepDeadConnections(): void {
    for (const [ws, session] of this.clients) {
      if (!session.alive) {
        ws.terminate();
        continue;
      }
      session.alive = false;
      ws.ping();
    }
  }

  private send(ws: WebSocket, message: WsServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (e) {
      this.logger.warn(`进度推送写入失败：${(e as Error).message}`, 'WsGateway');
    }
  }
}

/** 单条连接的会话状态 */
interface ClientSession {
  userId: string;
  /** 已订阅的作业 id */
  jobIds: Set<string>;
  /** 取消事件总线订阅 */
  unsubscribe?: () => void;
  /** ws 层心跳存活标记 */
  alive: boolean;
}

/** 解析客户端消息；非法输入返回 null */
function parseClientMessage(raw: string): WsClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as WsClientMessage;
    return typeof parsed?.type === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
