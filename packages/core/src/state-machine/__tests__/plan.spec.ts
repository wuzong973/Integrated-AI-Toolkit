import { describe, expect, it } from 'vitest';

import { NodeStatus, PlanRunStatus } from '../../enums';
import {
  NODE_TRANSITIONS,
  PLAN_RUN_TRANSITIONS,
  resolveRunStatus,
  transitionNode,
  transitionPlanRun,
} from '../plan';

describe('计划与节点状态机（文档 6.2.6）', () => {
  it('计划运行状态：合法通过、非法抛错（自迁移视为非法）', () => {
    const all = Object.values(PlanRunStatus);
    for (const from of all) {
      const allowed = PLAN_RUN_TRANSITIONS[from] ?? [];
      for (const to of all) {
        if (to !== from && allowed.includes(to)) {
          expect(() => transitionPlanRun(from, to)).not.toThrow();
        } else {
          expect(() => transitionPlanRun(from, to)).toThrow(/非法状态迁移/);
        }
      }
    }
  });

  it('节点状态：合法通过、非法抛错（自迁移视为非法）', () => {
    const all = Object.values(NodeStatus);
    for (const from of all) {
      const allowed = NODE_TRANSITIONS[from] ?? [];
      for (const to of all) {
        if (to !== from && allowed.includes(to)) {
          expect(() => transitionNode(from, to)).not.toThrow();
        } else {
          expect(() => transitionNode(from, to)).toThrow(/非法状态迁移/);
        }
      }
    }
  });

  it('人力节点完整链路：待指派 → 已发布 → 已指派 → 已交付 → 已验收 → 成功', () => {
    let s = NodeStatus.AwaitingHuman;
    s = transitionNode(s, NodeStatus.Published);
    s = transitionNode(s, NodeStatus.Assigned);
    s = transitionNode(s, NodeStatus.Delivered);
    s = transitionNode(s, NodeStatus.Accepted);
    s = transitionNode(s, NodeStatus.Succeeded);
    expect(s).toBe(NodeStatus.Succeeded);
  });

  it('全部成功 → succeeded', () => {
    expect(resolveRunStatus([NodeStatus.Succeeded, NodeStatus.Succeeded])).toBe(
      PlanRunStatus.Succeeded,
    );
  });

  it('部分失败 → partial_failed（文档 6.2.4）', () => {
    expect(resolveRunStatus([NodeStatus.Succeeded, NodeStatus.Failed])).toBe(
      PlanRunStatus.PartialFailed,
    );
  });

  it('全部失败 → failed', () => {
    expect(resolveRunStatus([NodeStatus.Failed, NodeStatus.Failed])).toBe(PlanRunStatus.Failed);
  });

  it('存在未终态节点 → 仍是 running', () => {
    expect(resolveRunStatus([NodeStatus.Succeeded, NodeStatus.Running])).toBe(
      PlanRunStatus.Running,
    );
  });

  it('跳过节点视为终态，不影响 succeeded 判定', () => {
    expect(resolveRunStatus([NodeStatus.Succeeded, NodeStatus.Skipped])).toBe(
      PlanRunStatus.Succeeded,
    );
  });
});
