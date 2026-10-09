/**
 * 作业进度实时通道（小程序端，文档 9.3 / 任务清单 M1-05）
 *
 * 协议（与后端 `apps/api/src/modules/job/job-progress.gateway.ts` 对应）：
 *   连接 `ws://host/ws?token=<accessToken>`，**握手即鉴权**，失败关闭码 4401；
 *   发送 `{type:'subscribe',jobIds:[...]}` → 服务端回 `subscribed` 并**逐个下发当前快照**；
 *   心跳 `{type:'ping'}` → 服务端回 `{type:'pong'}`。
 *
 * ## 两条必须守住的边界
 *
 * **① 断线重连后要能补齐进度。**
 *   `wx.connectSocket` 在小程序切后台、弱网、代理超时下都会断开，这是常态而非异常。
 *   重连成功后本类会**自动重新订阅全部在看的作业**，服务端随即下发权威快照，
 *   因此不需要客户端自己推算"断线期间漏了哪几条消息"。
 *
 * **② 进度绝不能倒退。**
 *   合并规则见 `./progress.ts`（终态不可变 + 进度不倒退 + 去重）。
 *   服务端也保证写入单调（JobService.updateProgress），两端都防才完整：
 *   只靠客户端防，轮询通道仍会把服务端的倒退值暴露出来。
 *
 * ## 与轮询的关系（重要）
 *
 * WebSocket 只负责"更快"，**权威来源始终是 HTTP 接口**（GET /jobs/:id）。
 * 重连超过上限后 `shouldFallbackToPolling` 变为 true，调用方应保持轮询 ——
 * 页面原本就在轮询，这里不做任何替代，只做增强。
 */
import { mergeProgress, type ProgressUpdate } from './progress';

/** 重连退避（文档 9.3：1s / 2s / 4s / 8s，最多 5 次） */
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000];
const MAX_RECONNECT_ATTEMPTS = 5;

/** 心跳间隔（文档 9.3：每 30s ping，60s 无 pong 视为断开） */
const HEARTBEAT_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;

/** 通道状态 */
export type ChannelState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface JobProgressChannelOptions {
  /** 后端基址，如 http://127.0.0.1:3000（会自动换成 ws://） */
  apiBase: string;
  accessToken: string;
  /** 合并通过后回调（进度不会倒退） */
  onUpdate: (update: ProgressUpdate) => void;
  /** 连接状态变化（页面可据此显示"实时/轮询"标识） */
  onStateChange?: (state: ChannelState) => void;
}

export class JobProgressChannel {
  private readonly opts: JobProgressChannelOptions;
  /** 在看的作业（断线时保留，重连后用于重新订阅） */
  private readonly watching = new Set<string>();
  /** 已知的最新状态（合并基准） */
  private readonly known = new Map<string, ProgressUpdate>();

  private socket: WechatMiniprogram.SocketTask | null = null;
  private state: ChannelState = 'idle';
  private attempts = 0;
  private closedByUser = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;

  constructor(options: JobProgressChannelOptions) {
    this.opts = options;
  }

  get currentState(): ChannelState {
    return this.state;
  }

  get connected(): boolean {
    return this.state === 'open';
  }

  /** 是否应保持轮询兜底（未连上或重连次数用尽） */
  get shouldFallbackToPolling(): boolean {
    return this.state !== 'open';
  }

  /** 已知的某作业最新状态（页面首屏渲染可用，避免闪一下 0%） */
  progressOf(jobId: string): ProgressUpdate | undefined {
    return this.known.get(jobId);
  }

  /** 开始监听（幂等；重复调用会触发重新连接） */
  open(): void {
    if (this.socket) return;
    this.closedByUser = false;
    this.connect();
  }

  /** 关注一个作业；未连接时先记下，连上后自动订阅 */
  watch(jobId: string): void {
    if (!jobId) return;
    this.watching.add(jobId);
    if (this.state === 'open') this.send({ type: 'subscribe', jobIds: [jobId] });
  }

  /** 取消关注（最多 50 个，与后端上限一致） */
  unwatch(jobId: string): void {
    this.watching.delete(jobId);
    if (this.state === 'open') this.send({ type: 'unsubscribe', jobIds: [jobId] });
  }

  /** 主动关闭（页面卸载时调用；之后再 watch 需重新 open） */
  close(): void {
    this.closedByUser = true;
    this.clearTimers();
    this.closeSocket();
    this.setState('closed');
  }

  /** 本地记录一次权威状态（用于轮询兜底时也走同一套合并规则） */
  applyLocal(update: ProgressUpdate): boolean {
    return this.apply(update);
  }

  // ---------- 连接管理 ----------

  private connect(): void {
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting');

    const url = `${this.wsBase()}/ws?token=${encodeURIComponent(this.opts.accessToken)}`;
    const socket = wx.connectSocket({ url });
    this.socket = socket;

    socket.onOpen(() => {
      this.attempts = 0;
      this.lastPongAt = Date.now();
      this.setState('open');
      this.startHeartbeat();
      // 重连后**必须重新订阅**：这是"断线重连补齐进度"的关键一步，
      // 服务端收到订阅会立刻下发每个作业的当前快照
      if (this.watching.size > 0) {
        this.send({ type: 'subscribe', jobIds: Array.from(this.watching) });
      }
    });

    socket.onMessage((res) => this.onMessage(res.data));

    socket.onClose(() => this.onDisconnected());
    socket.onError(() => this.onDisconnected());
  }

  private onDisconnected(): void {
    this.clearTimers();
    this.socket = null;
    if (this.closedByUser) {
      this.setState('closed');
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.attempts >= MAX_RECONNECT_ATTEMPTS) {
      // 用尽重连次数：交给轮询兜底。这里**不静默**，状态变化会通知调用方
      this.setState('closed');
      return;
    }
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.attempts, RECONNECT_BACKOFF_MS.length - 1)];
    this.attempts += 1;
    this.setState('reconnecting');
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.close({ code: 1000 });
    } catch {
      // 某些基础库在未连上时 close 会抛错，忽略即可（连接本就已不存在）
    }
  }

  // ---------- 心跳 ----------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // 60s 没有任何 pong：判定为半开连接（小程序切后台常见），主动重连
      if (Date.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
        this.closeSocket();
        this.onDisconnected();
        return;
      }
      this.send({ type: 'ping' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  // ---------- 消息 ----------

  private onMessage(raw: unknown): void {
    const message = parseMessage(typeof raw === 'string' ? raw : '');
    if (!message) return;

    if (message.type === 'pong') {
      this.lastPongAt = Date.now();
      return;
    }
    if (message.type === 'error') {
      // 服务端明确拒绝（如 token 过期）：不再重连，交给轮询兜底与重新登录
      this.attempts = MAX_RECONNECT_ATTEMPTS;
      return;
    }
    if (message.type !== 'tool.progress' && message.type !== 'tool.finished') return;
    if (!message.jobId || typeof message.progress !== 'number') return;

    this.apply({
      jobId: message.jobId,
      status: message.status || 'running',
      progress: message.progress,
      stage: message.stage,
      error: message.error,
    });
  }

  /**
   * 走一次合并；通过才回调。
   * 快照（服务端订阅时下发）与增量事件走**同一条路径** ——
   * 这样"重连补齐"与"实时更新"不可能出现两套口径。
   */
  private apply(update: ProgressUpdate): boolean {
    const outcome = mergeProgress(this.known.get(update.jobId), update);
    if (!outcome.accepted) return false;
    this.known.set(update.jobId, outcome.next);
    this.opts.onUpdate(outcome.next);
    return true;
  }

  private send(message: Record<string, unknown>): void {
    if (!this.socket || this.state !== 'open') return;
    try {
      this.socket.send({ data: JSON.stringify(message) });
    } catch {
      // 发送失败按断开处理，由重连逻辑恢复
      this.onDisconnected();
    }
  }

  private setState(state: ChannelState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onStateChange?.(state);
  }

  /** http(s) 基址 → ws(s) 基址 */
  private wsBase(): string {
    return this.opts.apiBase.replace(/^http/i, 'ws').replace(/\/+$/, '');
  }
}

/** 服务端消息（宽松解析：未知字段与未知事件名都要能安全忽略） */
interface ServerMessage {
  type: string;
  jobId?: string;
  status?: string;
  progress?: number;
  stage?: string;
  error?: string;
}

/** 解析服务端消息；非法 JSON 返回 null */
function parseMessage(raw: string): ServerMessage | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ServerMessage;
    return parsed && typeof parsed.type === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
