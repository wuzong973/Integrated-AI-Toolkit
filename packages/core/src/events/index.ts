import { JobStatus } from '../enums';
import { JOB_TERMINAL_STATUSES } from '../state-machine/job';

/**
 * 实时事件协议（文档 9.3）
 *
 * 放在 core 而不是任一端，是因为这份契约被**三端共用**：
 *   后端推送（apps/api）、小程序订阅（apps/mp）、H5/后台复用（packages/sdk）。
 * 任何一端单独定义都会立刻产生"协议漂移"。
 *
 * 与文档 9.3 的对应关系：
 *   文档写了 `tool.progress` / `tool.finished` / `os.*` / `order.*` 等事件名。
 *   本次（M1-05）只落地工具作业这一组（对应 M1 里程碑），其余事件名沿用同一信封，
 *   在 M2-15 统一补齐 —— 那时只需扩展下面的联合类型，不必改传输层。
 */

/** 服务端 → 客户端的事件名 */
export type WsServerEvent =
  'tool.progress' | 'tool.finished' | 'subscribed' | 'unsubscribed' | 'pong' | 'error';

/** 客户端 → 服务端的事件名 */
export type WsClientEvent = 'subscribe' | 'unsubscribe' | 'ping';

/**
 * 作业进度快照（服务端权威状态的一个切片）
 *
 * 与 `GET /jobs/:id` 的返回体刻意保持一致：这样"实时推送"与"轮询兜底"
 * 两条通道喂给前端的是同一种数据结构，前端只需要一套合并逻辑。
 */
export interface JobProgressSnapshot {
  jobId: string;
  status: string;
  /** 0-100 */
  progress: number;
  stage?: string;
  error?: string;
}

/** 服务端推给客户端的消息 */
export interface WsServerMessage {
  /** 事件名，与文档 9.3 一致 */
  type: WsServerEvent;
  /**
   * 事件序号（同一进程内单调递增）。
   * 定位：**排查与去重的辅助**，不作为跨实例的排序依据 ——
   * 多实例部署时各进程的计数器彼此独立，真正的权威来源始终是服务端下发的快照。
   */
  seq?: number;
  at?: string;
  /** tool.progress / tool.finished 时携带 */
  jobId?: string;
  status?: string;
  progress?: number;
  stage?: string;
  error?: string;
  /** 该消息是否为订阅时下发的**当前状态快照**（重连补齐进度用） */
  snapshot?: boolean;
  /** subscribed / unsubscribed 时回带实际生效的订阅列表 */
  jobIds?: string[];
  /** error 时的原因 */
  message?: string;
}

/** 客户端发给服务端的消息 */
export interface WsClientMessage {
  type: WsClientEvent;
  /** subscribe / unsubscribe 必填 */
  jobIds?: string[];
}

/** 进度合并的结论 */
export interface ProgressMergeResult {
  /** 是否采纳本次更新 */
  accepted: boolean;
  /** 拒绝原因，便于排查"为什么界面没动" */
  reason?: 'terminal' | 'regressed' | 'duplicate';
  /** 合并后的状态（被拒绝时原样返回 prev） */
  next: JobProgressSnapshot;
}

/**
 * 合并一次进度更新 —— **保证界面上的进度不倒退**（M1-05 验收项）
 *
 * 三条规则，按优先级：
 *   ① **终态不可变**：已进入 succeeded/failed/canceled/rejected 的作业，
 *      不再接受任何改变状态的消息。迟到的进度消息不能把"已完成"改回"处理中"。
 *   ② **进度不倒退**：比已知进度更低的消息一律丢弃。
 *      服务端本身已保证写入单调（见 JobService.updateProgress），
 *      所以走到这里的"倒退"只可能是乱序或重复投递 —— 直接丢弃，而不是夹断成上界，
 *      因为夹断会把服务端真正的 bug 掩盖掉。
 *   ③ **完全重复**：进度、状态、阶段都一样的消息不再触发渲染。
 *
 * 为什么把这段逻辑放 core：小程序与 H5/后台都要用，
 * 且它是纯函数，可以被单测钉死在边界上（见 __tests__/events.spec.ts）。
 */
export function mergeJobProgress(
  prev: JobProgressSnapshot | undefined,
  incoming: JobProgressSnapshot,
): ProgressMergeResult {
  if (!prev) return { accepted: true, next: { ...incoming } };

  const prevTerminal = isTerminalStatus(prev.status);
  if (prevTerminal && prev.status !== incoming.status) {
    return { accepted: false, reason: 'terminal', next: prev };
  }

  if (incoming.progress < prev.progress) {
    return { accepted: false, reason: 'regressed', next: prev };
  }

  if (isSameProgress(prev, incoming)) {
    return { accepted: false, reason: 'duplicate', next: prev };
  }

  return { accepted: true, next: { ...incoming } };
}

/** 是否处于终态（对未知状态返回 false，避免把脏数据当成终态而永久锁死界面） */
export function isTerminalStatus(status: string): boolean {
  return (JOB_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** 解析服务端消息；非法 JSON 或缺少 type 时返回 null（调用方据此忽略） */
export function parseServerMessage(raw: string): WsServerMessage | null {
  try {
    const parsed = JSON.parse(raw) as WsServerMessage;
    return typeof parsed?.type === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** 把服务端消息转成进度快照；缺少 jobId 时返回 null */
export function toSnapshot(message: WsServerMessage): JobProgressSnapshot | null {
  if (!message.jobId || typeof message.progress !== 'number') return null;
  return {
    jobId: message.jobId,
    status: message.status ?? JobStatus.Running,
    progress: message.progress,
    stage: message.stage,
    error: message.error,
  };
}

function isSameProgress(a: JobProgressSnapshot, b: JobProgressSnapshot): boolean {
  return a.progress === b.progress && a.status === b.status && (a.stage ?? '') === (b.stage ?? '');
}
