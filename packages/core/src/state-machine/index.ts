/**
 * 状态机统一入口（任务清单 M0-14；文档 6.2.6 / 6.6.3）
 * 纪律：所有状态变更必须走 transition()，禁止直接赋值。
 */
export * from './order';
export * from './task';
export * from './job';
export * from './plan';

/** 非法状态迁移错误 */
export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
    public readonly entity: string,
  ) {
    super(`[${entity}] 非法状态迁移：${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}
