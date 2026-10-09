import { describe, expect, it } from 'vitest';

import { degraded, normalizePlan } from '../os-planner';

/**
 * 任务规划校验（M2-05 验收：JSON Schema 强校验、节点 ≤12、无环拓扑校验）
 *
 * 这一层的价值不在"模型答得好不好"，而在**模型答错时系统不会装作没事**：
 * 一张带环的 DAG、一个指向不存在节点的依赖，如果被原样透到界面，
 * 用户会看到"第 3 步依赖第 5 步、第 5 步又依赖第 3 步"这种计划 ——
 * 而它看起来完全像一份正常输出。
 */
describe('normalizePlan —— 合法计划', () => {
  it('线性依赖原样通过，并保持顺序', () => {
    const r = normalizePlan(
      {
        goal: '办活动',
        nodes: [
          { id: 'n1', name: '确认方案', type: 'hitl', dependsOn: [] },
          { id: 'n2', name: '写策划书', type: 'ai', dependsOn: ['n1'] },
          { id: 'n3', name: '找摄影', type: 'human', dependsOn: ['n2'] },
        ],
      },
      '办活动',
    );

    expect(r.degraded).toBe(false);
    expect(r.nodes.map((n) => n.id)).toEqual(['n1', 'n2', 'n3']);
    expect(r.nodes.map((n) => n.type)).toEqual(['hitl', 'ai', 'human']);
  });

  it('⭐ 输出按拓扑序排列（依赖一定排在前面，界面线性渲染才不会颠倒）', () => {
    // 模型把下游节点写在了前面 —— 这是常见形态，必须由服务端纠正
    const r = normalizePlan(
      {
        nodes: [
          { id: 'n3', name: '第三步', type: 'ai', dependsOn: ['n2'] },
          { id: 'n1', name: '第一步', type: 'ai', dependsOn: [] },
          { id: 'n2', name: '第二步', type: 'ai', dependsOn: ['n1'] },
        ],
      },
      '目标',
    );

    expect(r.degraded).toBe(false);
    expect(r.nodes.map((n) => n.id)).toEqual(['n1', 'n2', 'n3']);
  });

  it('菱形依赖（两条分支汇合）也能排序', () => {
    const r = normalizePlan(
      {
        nodes: [
          { id: 'n1', name: 'A', type: 'ai', dependsOn: [] },
          { id: 'n2', name: 'B', type: 'ai', dependsOn: ['n1'] },
          { id: 'n3', name: 'C', type: 'ai', dependsOn: ['n1'] },
          { id: 'n4', name: 'D', type: 'human', dependsOn: ['n2', 'n3'] },
        ],
      },
      '目标',
    );

    expect(r.degraded).toBe(false);
    expect(r.nodes.map((n) => n.id)).toEqual(['n1', 'n2', 'n3', 'n4']);
  });

  it('goal 缺失时回落到入参（不让界面拿到空标题）', () => {
    const r = normalizePlan({ nodes: [{ id: 'n1', name: 'A', type: 'ai' }] }, '原始目标');
    expect(r.goal).toBe('原始目标');
  });
});

describe('normalizePlan —— 非法计划一律降级，不修补', () => {
  it('⭐ 有环 → degraded 且不返回任何节点（半修补的 DAG 比没有 DAG 更危险）', () => {
    const r = normalizePlan(
      {
        nodes: [
          { id: 'n1', name: 'A', type: 'ai', dependsOn: ['n2'] },
          { id: 'n2', name: 'B', type: 'ai', dependsOn: ['n1'] },
        ],
      },
      '目标',
    );

    expect(r.degraded).toBe(true);
    expect(r.nodes).toEqual([]);
    expect(r.degradedReason).toContain('环');
  });

  it('⭐ 悬空依赖（指向不存在的 id）→ 降级', () => {
    const r = normalizePlan(
      {
        nodes: [
          { id: 'n1', name: 'A', type: 'ai', dependsOn: [] },
          { id: 'n2', name: 'B', type: 'ai', dependsOn: ['n9'] },
        ],
      },
      '目标',
    );

    expect(r.degraded).toBe(true);
    expect(r.nodes).toEqual([]);
  });

  it('超过 12 个节点 → 降级（M2-05 硬上限）', () => {
    const nodes = Array.from({ length: 13 }, (_, i) => ({
      id: `n${i + 1}`,
      name: `步骤${i + 1}`,
      type: 'ai',
      dependsOn: i === 0 ? [] : [`n${i}`],
    }));
    const r = normalizePlan({ nodes }, '目标');

    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toContain('12');
  });

  it('恰好 12 个节点可以通过（边界不能差一）', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({
      id: `n${i + 1}`,
      name: `步骤${i + 1}`,
      type: 'ai',
      dependsOn: i === 0 ? [] : [`n${i}`],
    }));
    expect(normalizePlan({ nodes }, '目标').degraded).toBe(false);
  });

  it('nodes 不是数组 / 为空 / 全是空壳 → 降级', () => {
    expect(normalizePlan({ nodes: 'oops' }, '目标').degraded).toBe(true);
    expect(normalizePlan({ nodes: [] }, '目标').degraded).toBe(true);
    expect(normalizePlan({ nodes: [{}, null, 'x'] }, '目标').degraded).toBe(true);
    expect(normalizePlan(undefined, '目标').degraded).toBe(true);
  });
});

describe('normalizePlan —— 脏字段的保守处理', () => {
  it('id 重复时丢弃后出现的那一个（前一个已建立依赖引用）', () => {
    const r = normalizePlan(
      {
        nodes: [
          { id: 'n1', name: '先出现的', type: 'ai', dependsOn: [] },
          { id: 'n1', name: '后出现的', type: 'ai', dependsOn: [] },
        ],
      },
      '目标',
    );

    expect(r.degraded).toBe(false);
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0]?.name).toBe('先出现的');
  });

  it('⭐ 表外 type 归为 ai（保守：不凭空多出"需真人完成"的节点）', () => {
    const r = normalizePlan(
      {
        nodes: [
          { id: 'n1', name: 'A', type: 'ROBOT', dependsOn: [] },
          { id: 'n2', name: 'B', dependsOn: [] },
          { id: 'n3', name: 'C', type: 'human', dependsOn: [] },
        ],
      },
      '目标',
    );

    expect(r.nodes.map((n) => n.type)).toEqual(['ai', 'ai', 'human']);
  });

  it('自依赖被剔除（否则必然成环、必然降级）', () => {
    const r = normalizePlan(
      { nodes: [{ id: 'n1', name: 'A', type: 'ai', dependsOn: ['n1'] }] },
      '目标',
    );

    expect(r.degraded).toBe(false);
    expect(r.nodes[0]?.dependsOn).toEqual([]);
  });

  it('依赖数组去重、剔空串与非字符串', () => {
    const r = normalizePlan(
      {
        nodes: [
          { id: 'n1', name: 'A', type: 'ai', dependsOn: [] },
          { id: 'n2', name: 'B', type: 'ai', dependsOn: ['n1', 'n1', '', 3, null] },
        ],
      },
      '目标',
    );

    expect(r.degraded).toBe(false);
    expect(r.nodes[1]?.dependsOn).toEqual(['n1']);
  });

  it('id / name 为空白的节点被丢掉', () => {
    const r = normalizePlan(
      {
        nodes: [
          { id: '  ', name: '没有 id', type: 'ai', dependsOn: [] },
          { id: 'n1', name: '   ', type: 'ai', dependsOn: [] },
          { id: 'n2', name: '有效', type: 'ai', dependsOn: [] },
        ],
      },
      '目标',
    );

    expect(r.degraded).toBe(false);
    expect(r.nodes.map((n) => n.name)).toEqual(['有效']);
  });
});

describe('degraded —— 降级结果不编造节点', () => {
  it('返回空节点 + 原因，且 goal 原样带上', () => {
    const r = degraded('办活动', '模型超时');
    expect(r).toEqual({
      goal: '办活动',
      nodes: [],
      degraded: true,
      degradedReason: '模型超时',
    });
  });
});
