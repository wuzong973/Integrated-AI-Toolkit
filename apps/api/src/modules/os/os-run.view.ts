import type { Prisma } from '@prisma/client';
import {
  HitlType,
  NodeStatus,
  PLAN_RUN_TRANSITIONS,
  PlanRunStatus,
  asStringArray,
  resolveRunStatus,
  transitionNode,
  transitionPlanRun,
  type OsPlanNode,
  type OsPlanNodeType,
} from '@qz/core';

/**
 * 计划 Run 的**纯派生层**（任务清单 M2-06）
 *
 * 只放"输入确定 → 输出确定"的东西：入库初值、状态聚合、看板读模型。
 * 单列一个文件有两个理由：
 *   ① `os-run.service.ts` 负责 DB 与迁移，混在一起会顶破 300 行红线；
 *   ② 看板形状（`OsRunView`）是**前端要照着改的契约**，
 *      放在没有 Nest 依赖的文件里，前端同事可以只看这一份。
 *
 * ## 看板形状对齐谁
 *
 * 对齐 `apps/mp/pkg-os/plan/index.ts` 的 `applyRun()`：它读
 * `{ goal, stages: [{ name, nodes: [{ nodeId, name, type, status, actorLabel, detail, budget?, refTaskId? }] }] }`。
 * 字段名与取值一个都不差，页面拿到真实数据后**不需要改渲染代码**，
 * 只需要把 `demo` 角标关掉。
 */

/** `os_plan_run` 里视图要用到的列（Prisma 行的结构化切片） */
export interface OsRunRow {
  id: string;
  sessionId: string;
  goal: string;
  status: string;
  progress: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/**
 * `os_plan_run` 的列选择。
 *
 * ⚠️ 与上面的 `OsRunRow` **必须一起改**：查询多取或漏取一列，
 * 类型不会报错（结构匹配即可），但视图里对应字段会变成 undefined ——
 * 所以两者写在一个文件里，改的人视线跑不掉。
 */
export const RUN_SELECT = {
  id: true,
  sessionId: true,
  goal: true,
  status: true,
  progress: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
} satisfies Prisma.OsPlanRunSelect;

/** `os_task_node` 里视图要用到的列 */
export interface OsTaskNodeRow {
  id: string;
  nodeId: string;
  name: string;
  type: string;
  status: string;
  depends: unknown;
  progress: number;
  budget: number;
  sort: number;
  refTaskId: string | null;
  error: string | null;
  /** 建议技能标签（发布到驿站时带过去；规划器目前不产出，恒为空数组） */
  skillTags: unknown;
  updatedAt: Date;
}

/** `os_task_node` 的列选择，与 `OsTaskNodeRow` 一一对应（同上，改一处必须改两处） */
export const NODE_SELECT = {
  id: true,
  nodeId: true,
  name: true,
  type: true,
  status: true,
  depends: true,
  progress: true,
  budget: true,
  sort: true,
  refTaskId: true,
  error: true,
  skillTags: true,
  updatedAt: true,
} satisfies Prisma.OsTaskNodeSelect;

/** `tool_job` 里挂在本 Run 上的执行记录（run 级回写的证据，见服务头注释） */
export interface OsRunJobRow {
  id: string;
  toolName: string;
  status: string;
  createdAt: Date;
}

/** 看板节点（字段名与 mp `PlanNode` 一致） */
export interface OsRunNodeView {
  /** 计划内的节点 id（如 `n1`）—— confirm / publish 路由用它，不是数据库主键 */
  nodeId: string;
  name: string;
  type: string;
  status: string;
  /** 谁来执行（看板右上角的人称标签） */
  actorLabel: string;
  /** 一句话说明。**只描述库里确有的事实**，不编造耗时与产物数量 */
  detail: string;
  dependsOn: string[];
  progress: number;
  /** 预算，单位**分**（红线）；规划器不产出预算时为 0 */
  budget: number;
  /** 已发布到驿站时关联的需求 id */
  refTaskId?: string;
  /** 失败原因（有则给，供看板的"重试"提示用） */
  error?: string;
  updatedAt: string;
}

export interface OsRunStageView {
  name: string;
  nodes: OsRunNodeView[];
}

export interface OsRunJobView {
  jobId: string;
  toolName: string;
  status: string;
  createdAt: string;
}

/** `GET /os/runs/:id` 的响应体（看板唯一数据源） */
export interface OsRunView {
  runId: string;
  sessionId: string;
  goal: string;
  status: string;
  progress: { done: number; total: number; percent: number };
  /** 按**依赖层级**分组的阶段（规划器不产出阶段名，层级是图里算出来的事实） */
  stages: OsRunStageView[];
  /**
   * 本 Run 期间由助手发起的 AI 作业。
   *
   * ⚠️ 它们是 **run 级**归属，不是节点级：见 `os-run.service.ts` 头部"第 2 点做到哪一步"。
   */
  jobs: OsRunJobView[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/**
 * `os_plan_run.status` 的初始值。
 *
 * 规划刚刚产出时，计划正等着用户点头，所以初值取 `awaiting_confirm`
 *（`planning` 的两个出口之一是它，另一个是 `canceled`）——
 * 停在 `planning` 会让"节点已经开始动"这件事没有合法的下一步可走。
 */
export function initialRunStatus(): PlanRunStatus {
  return transitionPlanRun(PlanRunStatus.Planning, PlanRunStatus.AwaitingConfirm);
}

/**
 * 节点入库时的初始状态。
 *
 * 全部由状态机推导，不写死字面量：
 *   · `hitl` → `awaiting_hitl`（看板据此出"待我确认"，confirm 路由据此才有东西可确认）；
 *   · `human` → `awaiting_human`（看板据此出"去驿站发布"）；
 *   · `ai` / `external` 留在机器起点 `pending`。
 *
 * ⚠️ `pending` 是状态机的**起点**而不是"迁移出来的结果"，
 * 所以这一支直接返回起点值 —— 对起点做 `transitionNode(pending, pending)` 一定抛错。
 */
export function initialNodeStatus(type: OsPlanNodeType): NodeStatus {
  const target =
    type === 'hitl' ? NodeStatus.AwaitingHitl : type === 'human' ? NodeStatus.AwaitingHuman : null;
  return target === null ? NodeStatus.Pending : transitionNode(NodeStatus.Pending, target);
}

/** 节点 id 在库里的落点（`node_id VarChar(40)`；依赖引用要截得**一模一样**才对得上） */
export function nodeKey(id: string): string {
  return id.slice(0, 40);
}

/** 计划节点 → `os_task_node` 插入行（按拓扑序写入 `sort`，看板与阶段分层都依赖它） */
export function nodeCreateData(runId: string, node: OsPlanNode, sort: number) {
  return {
    runId,
    nodeId: nodeKey(node.id),
    name: node.name.slice(0, 120),
    type: node.type,
    depends: node.dependsOn.map(nodeKey) as never,
    status: initialNodeStatus(node.type),
    // 只有 hitl 节点有 HITL 语义，且本期只支持"确认"这一型（文档 6.2.5 的另外几型属 M2-13）
    hitlType: node.type === 'hitl' ? (HitlType.Confirm as string) : null,
    tool: node.tool ?? null,
    sort,
  };
}

/**
 * 节点状态变化后，计划该迁到哪个状态。
 *
 * 返回 `null` 表示**什么都不写**：聚合出的目标态与当前态之间没有合法的边
 *（例如刚建好就收到一个终态节点，`planning → succeeded` 状态机不允许）。
 * 这里绝不为了"看起来有进度"去绕过状态机 —— 绕过去就是脏数据，
 * 而且是一条不报错的脏数据。
 */
export function nextRunStatus(from: PlanRunStatus, statuses: NodeStatus[]): PlanRunStatus | null {
  const target = resolveRunStatus(statuses);
  if (target === from) return null;
  try {
    return transitionPlanRun(from, target);
  } catch {
    return null;
  }
}

/** 计划是否已到终态（判据取自迁移表本身：没有出路的状态就是终态） */
export function isRunTerminal(status: PlanRunStatus): boolean {
  return (PLAN_RUN_TRANSITIONS[status] ?? []).length === 0;
}

/** 完成度：与看板算法一致 —— 只把 `succeeded` 算作"做完了" */
export function runProgress(statuses: NodeStatus[]): {
  done: number;
  total: number;
  percent: number;
} {
  const done = statuses.filter((s) => s === NodeStatus.Succeeded).length;
  const total = statuses.length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/** 谁来执行（`actorLabel`） */
const ACTOR_LABEL: Record<string, string> = {
  ai: 'AI',
  human: '真人',
  hitl: '你',
  external: '校外流程',
};

/** 节点说明（`detail`）：只翻译库里真实存在的状态，不写耗时、不写"几人报名" */
const NODE_DETAIL: Record<string, string> = {
  [NodeStatus.Pending]: '待执行',
  [NodeStatus.Blocked]: '已挂起，需处理',
  [NodeStatus.Running]: '执行中',
  [NodeStatus.AwaitingHitl]: '需你确认后继续',
  [NodeStatus.AwaitingHuman]: '需真人完成 · 待发布',
  [NodeStatus.Published]: '已发布到驿站 · 等待接单',
  [NodeStatus.Assigned]: '已选定服务者',
  [NodeStatus.Delivered]: '服务者已交付 · 待你验收',
  [NodeStatus.Accepted]: '已验收',
  [NodeStatus.Succeeded]: '已完成',
  [NodeStatus.Failed]: '执行失败',
  [NodeStatus.Skipped]: '已跳过',
  [NodeStatus.Canceled]: '已取消',
};

/** 还没做完的状态（用来判断某个 pending 节点该说"待执行"还是"等待前置节点"） */
const UNFINISHED = new Set<string>([
  NodeStatus.Pending,
  NodeStatus.Running,
  NodeStatus.Blocked,
  NodeStatus.AwaitingHitl,
  NodeStatus.AwaitingHuman,
  NodeStatus.Failed,
]);

/** 行 → 看板节点 */
export function toNodeView(row: OsTaskNodeRow, unfinishedIds: Set<string>): OsRunNodeView {
  const status = row.status;
  const detail = detailOf(row, unfinishedIds);
  return {
    nodeId: row.nodeId,
    name: row.name,
    type: row.type,
    status,
    actorLabel: ACTOR_LABEL[row.type] ?? row.type,
    detail,
    dependsOn: asStringArray(row.depends),
    progress: row.progress,
    budget: row.budget,
    ...(row.refTaskId ? { refTaskId: row.refTaskId } : {}),
    ...(row.error ? { error: row.error.slice(0, 120) } : {}),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function detailOf(row: OsTaskNodeRow, unfinishedIds: Set<string>): string {
  if (row.status === NodeStatus.Pending) {
    const waiting = asStringArray(row.depends).some((d) => unfinishedIds.has(d));
    if (waiting) return '等待前置节点';
  }
  if (row.status === NodeStatus.Running && row.progress > 0) return `执行中 ${row.progress}%`;
  if (row.status === NodeStatus.Failed && row.error) return row.error.slice(0, 60);
  return NODE_DETAIL[row.status] ?? row.status;
}

/**
 * 按依赖层级分阶段。
 *
 * 规划器只给出节点与依赖，**没有"阶段"这个概念**；层级是从图里算出来的事实
 *（无依赖的是第 1 层，其余是"最深的前置 + 1"），所以这里能安全地叫它"阶段 N"。
 * 入参必须按 `sort` 升序（planner 已做拓扑排序，见 `os-planner.ts`），
 * 否则某一层的父节点还没算出层级，会被当成根。
 */
export function buildStages(nodes: OsTaskNodeRow[]): OsRunStageView[] {
  const unfinished = new Set(nodes.filter((n) => UNFINISHED.has(n.status)).map((n) => n.nodeId));
  const depth = new Map<string, number>();
  const buckets = new Map<number, OsRunNodeView[]>();

  for (const node of nodes) {
    const parents = asStringArray(node.depends).map((d) => depth.get(d) ?? 0);
    const level = parents.length === 0 ? 1 : Math.max(...parents) + 1;
    depth.set(node.nodeId, level);
    const list = buckets.get(level) ?? [];
    list.push(toNodeView(node, unfinished));
    buckets.set(level, list);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([level, list]) => ({ name: `阶段 ${level}`, nodes: list }));
}

/** Run 行 + 节点行 + 作业行 → 看板响应 */
export function buildRunView(
  run: OsRunRow,
  nodes: OsTaskNodeRow[],
  jobs: OsRunJobRow[],
): OsRunView {
  const statuses = nodes.map((n) => n.status as NodeStatus);
  return {
    runId: run.id,
    sessionId: run.sessionId,
    goal: run.goal,
    status: run.status,
    progress: runProgress(statuses),
    stages: buildStages(nodes),
    jobs: jobs.map((j) => ({
      jobId: j.id,
      toolName: j.toolName,
      status: j.status,
      createdAt: j.createdAt.toISOString(),
    })),
    createdAt: run.createdAt.toISOString(),
    ...(run.startedAt ? { startedAt: run.startedAt.toISOString() } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt.toISOString() } : {}),
  };
}
