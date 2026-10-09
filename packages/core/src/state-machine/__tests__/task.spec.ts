import { describe, expect, it } from 'vitest';

import { TaskStatus } from '../../enums';
import { TASK_TRANSITIONS, isTaskTerminal, transitionTask } from '../task';

describe('任务状态机（文档 6.6.1）', () => {
  it('全部合法迁移通过、全部非法迁移抛错（自迁移视为非法）', () => {
    const all = Object.values(TaskStatus);
    for (const from of all) {
      const allowed = TASK_TRANSITIONS[from] ?? [];
      for (const to of all) {
        if (to !== from && allowed.includes(to)) {
          expect(() => transitionTask(from, to)).not.toThrow();
        } else {
          expect(() => transitionTask(from, to)).toThrow(/非法状态迁移/);
        }
      }
    }
  });

  it('无服务者报名时可关闭', () => {
    expect(transitionTask(TaskStatus.Published, TaskStatus.Closed)).toBe(TaskStatus.Closed);
  });

  it('超时未支付可从已选定回到已发布', () => {
    expect(transitionTask(TaskStatus.Assigned, TaskStatus.Published)).toBe(TaskStatus.Published);
  });

  it('已完成是终态', () => {
    expect(isTaskTerminal(TaskStatus.Completed)).toBe(true);
    expect(isTaskTerminal(TaskStatus.InProgress)).toBe(false);
  });
});
