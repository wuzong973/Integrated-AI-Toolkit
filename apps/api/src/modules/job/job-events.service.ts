import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { JobProgressSnapshot, WsServerMessage } from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';

/** 订阅者回调 */
export type JobEventSubscriber = (message: WsServerMessage) => void;

/**
 * 作业事件总线（任务清单 M1-05）
 *
 * 职责单一：把"作业状态变了"这件事**按用户**分发给当前进程内的订阅者（WebSocket 连接）。
 * 不认识 WebSocket，也不认识数据库 —— 这样它既能在单测里被直接验证，
 * 也能在 M2-15 需要跨实例推送时**只替换本类**（改为订阅 Redis Pub/Sub），
 * 不必动 JobService 与网关。
 *
 * ## 为什么按用户订阅，而不是按作业
 *
 * 推送的授权边界是"只能看自己的作业"（越权看到别人的进度等于信息泄漏）。
 * 按用户聚合订阅者后，网关侧只需在 `subscribe` 时校验作业归属一次，
 * 之后的分发天然不会越界 —— 比"广播给所有连接、让连接自己过滤"安全得多。
 *
 * ## 已知局限（写清楚，避免误判）
 *
 * 事件只在**本进程内**分发。多实例部署时，作业在 A 实例执行、用户连在 B 实例，
 * 就收不到实时推送 —— 此时前端靠 1.5s 的轮询兜底，状态不会错、只是不够"即时"。
 * 跨实例 fan-out 属于 M2-15（WebSocket 事件协议）的范围。
 */
@Injectable()
export class JobEventsService implements OnModuleDestroy {
  private readonly subscribers = new Map<string, Set<JobEventSubscriber>>();
  /** 进程内事件序号，辅助排查"消息是否乱序" */
  private seq = 0;

  constructor(private readonly logger: AppLogger) {}

  onModuleDestroy(): void {
    this.subscribers.clear();
  }

  /** 当前在线订阅者数量（供 /health 与排查使用） */
  get subscriberCount(): number {
    let total = 0;
    for (const set of this.subscribers.values()) total += set.size;
    return total;
  }

  /** 订阅某用户的作业事件；返回取消订阅函数 */
  subscribe(userId: string, listener: JobEventSubscriber): () => void {
    let set = this.subscribers.get(userId);
    if (!set) {
      set = new Set();
      this.subscribers.set(userId, set);
    }
    set.add(listener);

    return () => {
      set.delete(listener);
      // 及时清理空集合，避免长期运行下 Map 无限增长（每个登出用户都留一个空 Set）
      if (set.size === 0) this.subscribers.delete(userId);
    };
  }

  /**
   * 发布作业进度（running 期间的高频事件）。
   * 没有订阅者时静默返回：这是常态（用户不在页面上），不该产生日志噪音。
   */
  publishProgress(userId: string, snapshot: JobProgressSnapshot): void {
    this.publish(userId, {
      type: 'tool.progress',
      ...this.envelope(),
      ...toMessageFields(snapshot),
    });
  }

  /** 发布作业终态（succeeded / failed / canceled / rejected） */
  publishFinished(userId: string, snapshot: JobProgressSnapshot): void {
    this.publish(userId, {
      type: 'tool.finished',
      ...this.envelope(),
      ...toMessageFields(snapshot),
    });
  }

  /** 下发快照（订阅/重连时补齐进度用） */
  sendSnapshot(userId: string, snapshot: JobProgressSnapshot): void {
    this.publish(userId, {
      type: 'tool.progress',
      ...this.envelope(),
      snapshot: true,
      ...toMessageFields(snapshot),
    });
  }

  /** 分发到该用户的所有订阅者；单个订阅者抛错不影响其他订阅者 */
  private publish(userId: string, message: WsServerMessage): void {
    const set = this.subscribers.get(userId);
    if (!set || set.size === 0) return;

    for (const listener of set) {
      try {
        listener(message);
      } catch (e) {
        // 一个连接写失败（如刚好断开）不能让其他连接跟着丢消息
        this.logger.warn(`作业事件推送失败：${(e as Error).message}`, 'JobEvents');
      }
    }
  }

  private envelope(): Pick<WsServerMessage, 'seq' | 'at'> {
    this.seq += 1;
    return { seq: this.seq, at: new Date().toISOString() };
  }
}

/** 快照 → 消息字段（两个事件类型共用，避免字段漏写） */
function toMessageFields(snapshot: JobProgressSnapshot): Partial<WsServerMessage> {
  return {
    jobId: snapshot.jobId,
    status: snapshot.status,
    progress: snapshot.progress,
    stage: snapshot.stage,
    error: snapshot.error,
  };
}
