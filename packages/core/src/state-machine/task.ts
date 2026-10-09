import { TaskStatus } from '../enums';

import { IllegalTransitionError } from './index';

/**
 * 任务（需求）状态机（文档 6.6.1 / 5.3.9）
 *
 * 草稿 → 待审核 → 已发布(招募中) → 已选定(待支付) → 进行中 → 待验收 → 已完成
 *                     |                |              |
 *                     |无服务者报名     |超时未支付      |违约/协商取消
 *                     v                v              v
 *                  已关闭           已关闭          已取消
 */
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  [TaskStatus.Draft]: [TaskStatus.Reviewing, TaskStatus.Published, TaskStatus.Canceled],
  [TaskStatus.Reviewing]: [TaskStatus.Published, TaskStatus.Draft, TaskStatus.Canceled],
  [TaskStatus.Published]: [TaskStatus.Assigned, TaskStatus.Closed, TaskStatus.Canceled],
  [TaskStatus.Assigned]: [TaskStatus.InProgress, TaskStatus.Published, TaskStatus.Closed],
  [TaskStatus.InProgress]: [TaskStatus.PendingAcceptance, TaskStatus.Canceled],
  [TaskStatus.PendingAcceptance]: [TaskStatus.Completed, TaskStatus.InProgress],
  [TaskStatus.Completed]: [],
  [TaskStatus.Closed]: [],
  [TaskStatus.Canceled]: [],
};

export const TASK_TERMINAL_STATUSES: readonly TaskStatus[] = [
  TaskStatus.Completed,
  TaskStatus.Closed,
  TaskStatus.Canceled,
];

export function transitionTask(from: TaskStatus, to: TaskStatus): TaskStatus {
  const allowed = TASK_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new IllegalTransitionError(from, to, 'task');
  }
  return to;
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return (TASK_TRANSITIONS[from] ?? []).includes(to);
}

export function isTaskTerminal(status: TaskStatus): boolean {
  return TASK_TERMINAL_STATUSES.includes(status);
}
