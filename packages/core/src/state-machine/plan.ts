import { NodeStatus, PlanRunStatus } from '../enums';

import { IllegalTransitionError } from './index';

/** 计划运行状态机（文档 6.2.6 Plan Run） */
export const PLAN_RUN_TRANSITIONS: Record<PlanRunStatus, readonly PlanRunStatus[]> = {
  [PlanRunStatus.Planning]: [PlanRunStatus.AwaitingConfirm, PlanRunStatus.Canceled],
  [PlanRunStatus.AwaitingConfirm]: [PlanRunStatus.Running, PlanRunStatus.Canceled],
  [PlanRunStatus.Running]: [
    PlanRunStatus.Succeeded,
    PlanRunStatus.PartialFailed,
    PlanRunStatus.Failed,
    PlanRunStatus.Canceled,
  ],
  [PlanRunStatus.Succeeded]: [],
  [PlanRunStatus.PartialFailed]: [PlanRunStatus.Running, PlanRunStatus.Succeeded],
  [PlanRunStatus.Failed]: [PlanRunStatus.Running],
  [PlanRunStatus.Canceled]: [],
};

/** 计划节点状态机（文档 6.2.6 Node） */
export const NODE_TRANSITIONS: Record<NodeStatus, readonly NodeStatus[]> = {
  [NodeStatus.Pending]: [
    NodeStatus.Running,
    NodeStatus.Blocked,
    NodeStatus.AwaitingHitl,
    NodeStatus.AwaitingHuman,
    NodeStatus.Skipped,
  ],
  [NodeStatus.Running]: [NodeStatus.Succeeded, NodeStatus.Failed],
  [NodeStatus.Failed]: [NodeStatus.Running, NodeStatus.Skipped],
  [NodeStatus.Blocked]: [NodeStatus.Pending, NodeStatus.Skipped],
  [NodeStatus.AwaitingHitl]: [NodeStatus.Running, NodeStatus.Canceled],
  [NodeStatus.AwaitingHuman]: [NodeStatus.Published, NodeStatus.Skipped],
  [NodeStatus.Published]: [NodeStatus.Assigned, NodeStatus.Skipped],
  [NodeStatus.Assigned]: [NodeStatus.Delivered],
  [NodeStatus.Delivered]: [NodeStatus.Accepted],
  [NodeStatus.Accepted]: [NodeStatus.Succeeded],
  [NodeStatus.Succeeded]: [NodeStatus.Running], // 允许重做
  [NodeStatus.Skipped]: [],
  [NodeStatus.Canceled]: [],
};

export function transitionPlanRun(from: PlanRunStatus, to: PlanRunStatus): PlanRunStatus {
  const allowed = PLAN_RUN_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new IllegalTransitionError(from, to, 'plan_run');
  }
  return to;
}

export function transitionNode(from: NodeStatus, to: NodeStatus): NodeStatus {
  const allowed = NODE_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new IllegalTransitionError(from, to, 'node');
  }
  return to;
}

export function canTransitionNode(from: NodeStatus, to: NodeStatus): boolean {
  return (NODE_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * 计算计划的最终状态（调度器在全部节点到终态后调用）
 * 任一失败但非全失败 => partial_failed（文档 6.2.4）
 */
export function resolveRunStatus(statuses: readonly NodeStatus[]): PlanRunStatus {
  const terminal = [
    NodeStatus.Succeeded,
    NodeStatus.Failed,
    NodeStatus.Skipped,
    NodeStatus.Canceled,
  ];
  const allTerminal = statuses.every((s) => terminal.includes(s));
  if (!allTerminal) return PlanRunStatus.Running;

  const succeededCount = statuses.filter((s) => s === NodeStatus.Succeeded).length;
  const failedCount = statuses.filter((s) => s === NodeStatus.Failed).length;

  if (failedCount === 0) return PlanRunStatus.Succeeded;
  if (succeededCount === 0) return PlanRunStatus.Failed;
  return PlanRunStatus.PartialFailed;
}
