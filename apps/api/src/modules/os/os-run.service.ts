import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ZodError } from 'zod';
import {
  BizException,
  ErrorCode,
  NodeStatus,
  PlanRunStatus,
  PublishTaskSchema,
  asStringArray,
  transitionNode,
  transitionPlanRun,
  type ConfirmOsNodeDto,
  type OsPlanResult,
  type PublishOsNodeDto,
  type PublishTaskDto,
} from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { StationWriteService } from '../station/station-write.service';
import type { TaskItemDto } from '../station/station.service';

import {
  NODE_SELECT,
  RUN_SELECT,
  buildRunView,
  initialRunStatus,
  isRunTerminal,
  nextRunStatus,
  nodeCreateData,
  nodeKey,
  runProgress,
  type OsRunRow,
  type OsRunView,
  type OsTaskNodeRow,
} from './os-run.view';

/**
 * 青智 OS · 计划 Run 持久化（任务清单 M2-06）
 *
 * ## 这个文件存在的理由
 *
 * `OsPlanRun` / `OsTaskNode` 两张表在 M0 建库时就画好了，但**一条读写都没有过**：
 * 规划（M2-05）把 DAG 返回给客户端后就结束，看板页只能靠前端演示数据渲染。
 * 本服务把这张图**落进数据库**，并给出看板真正需要的三条读写字路径。
 * 定时调度、节点重试、HITL 超时策略**不在本切片内**（M2-13 / M2-14）。
 *
 * ## 状态纪律
 *
 * 所有状态变更都经 `@qz/core` 的 `transitionNode()` / `transitionPlanRun()`：
 * 非法迁移抛 40904（`IllegalStateTransition`），**不存在"直接写个状态字符串"的入口**。
 * 初始值同样由状态机推导（见 `os-run.view.ts` 的 `initialNodeStatus`）。
 *
 * ## 关于"第 2 点：AI 节点执行回写"做到哪一步（如实说明）
 *
 * 现状链路是 `OsService.chatWithTools` → `OsToolRegistry.execute` →
 * `AiDispatchService.dispatch` → `ToolInvokeService.invoke`，
 * **调哪个工具、什么时候调由模型决定**，提示词与工具清单里都没有"节点"这个概念，
 * 所以一次 AI 执行**无法可靠地对应到某个具体节点**：
 * 计划里的 `ai` 节点只有中文名（"AI 生成预算明细表"），与工具名
 *（`generate_ppt` / `summarize_long_text`…）之间没有可依据的映射，
 * 硬猜一个节点置为 `running`/`succeeded` 就是假状态（红线 9）。
 *
 * 因此本切片做的是 **run 级回写**：`tool_job` 表本来就留有 `run_id` 列，
 * 助手在"该会话最近一个未终态 Run"期间发起的作业都会带上 `runId`
 *（由 `OsService` 查 `openRunId()` 后穿过工具上下文传下去），
 * 看板的 `jobs` 字段据此如实列出"这个计划期间跑了哪些 AI 作业"。
 * **`ai` 节点本身保持 `pending`** —— 等 M2-10/M2-11 的 Agent 运行循环
 * 真正按节点驱动执行时，再在这里补节点级回写。
 */
@Injectable()
export class OsRunService {
  constructor(
    private readonly prisma: PrismaService,
    /**
     * 驿站写路径（分类校验 + 送审 + taskNo + 直接 published 的唯一发布入口）。
     * 经 `StationModule.exports` 注入 —— 与驿站页面走**同一条**发布链路，
     * 不另起第二份实现（那会漂移出两套发布纪律）。
     */
    private readonly station: StationWriteService,
    private readonly logger: AppLogger,
  ) {}

  // ---------- 建：规划产物落库 ----------

  /**
   * 规划成功后把计划落成 Run，并把 `runId` 带回给客户端。
   *
   * 三种情况**不建 Run**（原样返回计划，客户端拿不到 runId）：
   *   · `degraded` —— 没规划出合法的图，落库只会存一张空壳；
   *   · 节点为 0 —— 同上；
   *   · 请求没带 `sessionId` —— `os_plan_run.session_id` 是必填外键。
   *
   * ⚠️ 写库失败时**只记日志、不报错**：规划是已经花掉 token 的真实产出，
   * 不该因为一次落库失败让用户什么都拿不到。但日志必须有，
   * 否则线上"看板为什么是空的"会无从下手。
   */
  async persistPlan(
    userId: string,
    sessionId: string | undefined,
    plan: OsPlanResult,
  ): Promise<OsPlanResult> {
    if (!sessionId || plan.degraded || plan.nodes.length === 0) return plan;
    try {
      const runId = await this.createRun(userId, sessionId, plan);
      return { ...plan, runId };
    } catch (e) {
      this.logger.warn(
        `计划 Run 落库失败（计划本身仍返回给客户端）：${(e as Error)?.message ?? '未知错误'}`,
        'OsRun',
      );
      return plan;
    }
  }

  /** 建 Run + 逐节点建 TaskNode（节点按 planner 的拓扑序写入 `sort`） */
  async createRun(userId: string, sessionId: string, plan: OsPlanResult): Promise<string> {
    const session = await this.prisma.osSession.findFirst({
      where: { id: sessionId, userId },
      select: { id: true },
    });
    if (!session) {
      throw new BizException(ErrorCode.NotFound, undefined, '会话不存在或已结束');
    }

    const run = await this.prisma.osPlanRun.create({
      data: {
        sessionId: session.id,
        goal: plan.goal,
        // 原样存一份计划 JSON：节点后来会被人工改动，但"模型当初怎么拆的"要能回放
        plan: asJson(plan),
        status: initialRunStatus(),
        progress: 0,
      },
      select: { id: true },
    });

    await this.prisma.osTaskNode.createMany({
      data: plan.nodes.map((node, i) => nodeCreateData(run.id, node, i)),
    });
    this.logger.log(`计划 Run 已建：${run.id}（${plan.nodes.length} 个节点）`, 'OsRun');
    return run.id;
  }

  // ---------- 读：看板数据源 ----------

  /** 看板读模型（`GET /os/runs/:id`）。只允许本人读，越权与不存在同一句文案 */
  async getRun(userId: string, runId: string): Promise<OsRunView> {
    const run = await this.loadRun(userId, runId);
    const [nodes, jobs] = await Promise.all([
      this.prisma.osTaskNode.findMany({
        where: { runId: run.id },
        orderBy: { sort: 'asc' },
        select: NODE_SELECT,
      }),
      this.prisma.toolJob.findMany({
        where: { runId: run.id },
        orderBy: { createdAt: 'desc' },
        take: JOB_LIMIT,
        select: { id: true, toolName: true, status: true, createdAt: true },
      }),
    ]);
    return buildRunView(run, nodes, jobs);
  }

  /**
   * 会话内**最近一个未终态**的 Run id。
   *
   * 只给一件事用：给助手这一轮发起的 AI 作业打上 `runId`（见文件头"第 2 点"）。
   * 取"最近一个"是因为规划卡在看板上是**逐个进行**的，
   * 同会话并跑两个计划在 UI 上没有入口 —— 真出现时宁可归属错到最近的那个，
   * 也不给作业挂一个假节点 id。
   */
  async openRunId(sessionId: string): Promise<string | undefined> {
    const row = await this.prisma.osPlanRun.findFirst({
      where: { sessionId, status: { in: OPEN_RUN_STATUSES } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return row?.id;
  }

  // ---------- 节点操作 ----------

  /**
   * HITL 节点确认（`POST /os/runs/:id/nodes/:nodeId/confirm`）。
   *
   * 两道门，缺一不可：
   *   ① **只有 `hitl` 类型的节点可以被"确认"** —— `pending → running` 在节点状态机里
   *      本来是合法边，光靠状态机挡不住"把一个 ai 节点确认成执行中"（那不是人工拍板，
   *      那是替调度器做决定，而本切片没有调度器）；
   *   ② 状态机只允许 `awaiting_hitl → running`：已确认过（running / succeeded）
   *      → 40904，而不是"再点一次也成功"。
   *
   * 用户的决策内容进 `result`（谁拍的板、说了什么）——
   * 否则"人工确认"这件事在库里没有凭据。
   */
  async confirmNode(
    userId: string,
    runId: string,
    nodeId: string,
    dto: ConfirmOsNodeDto,
  ): Promise<OsRunView> {
    const run = await this.loadRun(userId, runId);
    const node = await this.loadNode(run.id, nodeId);
    if (node.type !== 'hitl') {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '这个节点不需要你确认');
    }
    const status = moveNode(node.status, NodeStatus.Running, '该节点不在「待你确认」状态');

    /**
     * 条件更新（并发守卫）：带上读到的 `node.status`。
     *
     * 裸 `update({ where: { id } })` 时，重复点「确认」会让两个请求都通过状态机校验、
     * 都写一次结果 —— `result` 被后写者覆盖，而用户两次都看到成功。
     * 同文件的 `publishNode` 早已是 `updateMany + where.status`，这里对齐口径。
     */
    const moved = await this.prisma.osTaskNode.updateMany({
      where: { id: node.id, status: node.status },
      data: { status, result: asJson(decisionResult(dto)) },
    });
    if (moved.count === 0) {
      throw new BizException(
        ErrorCode.IllegalStateTransition,
        { nodeId },
        '该节点已被处理过，请刷新后重试',
      );
    }
    await this.syncRun(run);
    return this.getRun(userId, run.id);
  }

  /**
   * 确认整份计划、开始执行（`POST /os/runs/:id/confirm`，文档 9.2.4）。
   *
   * 与节点级 confirm 是两件事：这条推进 **Run** 的 `awaiting_confirm → running`
   *（用户认可这张图），节点级推进的是**单个 hitl 节点**（用户拍板某个决定）。
   */
  async confirmPlan(userId: string, runId: string): Promise<OsRunView> {
    const run = await this.loadRun(userId, runId);
    const status = moveRun(run.status, PlanRunStatus.Running, '该计划已确认过或已结束');

    // 条件更新（并发守卫）：只有仍是读到的那一刻状态才推进得动，
    // 否则两人同时点「确认开始」会各自写一次 startedAt 并都返回成功
    const moved = await this.prisma.osPlanRun.updateMany({
      where: { id: run.id, status: run.status },
      data: { status, startedAt: run.startedAt ?? new Date() },
    });
    if (moved.count === 0) {
      throw new BizException(
        ErrorCode.IllegalStateTransition,
        { runId },
        '该计划已确认过，请刷新后重试',
      );
    }
    return this.getRun(userId, run.id);
  }

  /**
   * 人力节点一键发布到驿站（`POST /os/runs/:id/nodes/:nodeId/publish`）。
   *
   * ## 复用而不是自己写 task.create
   *
   * 发布要走的是 M3-06 那一条**已经定死**的入口：分类存在性校验、标题/描述送审、
   * `taskNo` 生成、直接落 `published`。在这里另写一份等于给驿站开第二个后门 ——
   * 下一次改发布规则时必然只改一处（届时"OS 发的需求绕过送审"这种问题不会报错，
   * 只会在合规检查时被发现）。
   *
   * ## 为什么"先建任务、后改节点"
   *
   * `StationWriteService.publish` 不吃外部事务句柄，跨不到同一事务里。
   * 于是顺序只能是：状态机校验 → 建任务 → **带原状态条件的更新**（`where.status`）。
   * 更新抢不到（同一节点被并发点了两次发布）时任务已经建出来了 ——
   * 那是本切片**已知且如实记录**的代价：宁可留一条可关掉的重复需求并告警，
   * 也不让节点停在原地、界面上却显示"已发布"。
   */
  async publishNode(
    userId: string,
    runId: string,
    nodeId: string,
    dto: PublishOsNodeDto,
  ): Promise<{ run: OsRunView; task: TaskItemDto }> {
    const run = await this.loadRun(userId, runId);
    const node = await this.loadNode(run.id, nodeId);
    if (node.type !== 'human') {
      throw new BizException(
        ErrorCode.ParamInvalid,
        undefined,
        '只有「需真人完成」的节点可以发布到驿站',
      );
    }
    const status = moveNode(
      node.status,
      NodeStatus.Published,
      '该节点已发布，或当前状态不支持发布',
    );
    const task = await this.station.publish(userId, publishInput(run, node, dto));

    const moved = await this.prisma.osTaskNode.updateMany({
      where: { id: node.id, status: node.status },
      data: {
        status,
        refTaskId: task.id,
        result: asJson({
          taskId: task.id,
          taskNo: task.taskNo,
          publishedAt: new Date().toISOString(),
        }),
      },
    });
    if (moved.count === 0) {
      this.logger.warn(
        `节点 ${nodeId} 发布时状态已被改写，驿站可能多出一条重复需求 ${task.taskNo}`,
        'OsRun',
      );
      throw new BizException(
        ErrorCode.DuplicateOperation,
        undefined,
        '该节点刚刚已被发布，请刷新看板查看',
      );
    }

    await this.syncRun(run);
    return { run: await this.getRun(userId, run.id), task };
  }

  // ---------- 内部 ----------

  /** 取 Run 并校验归属（越权与不存在给同一句话，不泄露"存在但不是你的"） */
  private async loadRun(userId: string, runId: string): Promise<OsRunRow> {
    const row = await this.prisma.osPlanRun.findFirst({
      where: { id: runId, session: { userId } },
      select: RUN_SELECT,
    });
    if (!row) throw new BizException(ErrorCode.NotFound, undefined, '计划不存在或没有权限');
    return row;
  }

  private async loadNode(runId: string, nodeId: string): Promise<OsTaskNodeRow> {
    const row = await this.prisma.osTaskNode.findFirst({
      where: { runId, nodeId: nodeKey(nodeId) },
      select: NODE_SELECT,
    });
    if (!row) throw new BizException(ErrorCode.NotFound, undefined, '节点不存在');
    return row;
  }

  /**
   * 节点变化后把 Run 的进度与状态对齐（**只在状态机允许时写**）。
   *
   * `nextRunStatus` 聚合不出合法的下一跳时返回 null —— 那时只更新 `progress`，
   * 状态保持原样。这不是偷懒：`planning → succeeded` 这类跳跃在状态机里就是非法的，
   * 写进去会让后面所有对账都对不上（红线：状态只能由状态机改）。
   */
  private async syncRun(run: OsRunRow): Promise<void> {
    const rows = await this.prisma.osTaskNode.findMany({
      where: { runId: run.id },
      select: { status: true },
    });
    const statuses = rows.map((r) => r.status as NodeStatus);
    if (statuses.length === 0) return;

    const data: Prisma.OsPlanRunUpdateInput = { progress: runProgress(statuses).percent };
    const target = nextRunStatus(run.status as PlanRunStatus, statuses);
    if (target) {
      data.status = target;
      if (target === PlanRunStatus.Running && !run.startedAt) data.startedAt = new Date();
      if (isRunTerminal(target)) data.finishedAt = new Date();
    }
    await this.prisma.osPlanRun.update({ where: { id: run.id }, data });
  }
}

/** 未终态的 Run：这些状态下，会话里发起的 AI 作业仍可能属于它 */
const OPEN_RUN_STATUSES: string[] = [
  PlanRunStatus.Planning,
  PlanRunStatus.AwaitingConfirm,
  PlanRunStatus.Running,
];

/** 看板一次最多回看的作业数（长任务的作业列表只用于"最近做了什么"） */
const JOB_LIMIT = 20;

/** Prisma 的 Json 列类型不接受自定义对象；收口在这一个函数里，免得各处写 `as never` */
function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** 状态机抛的 `IllegalTransitionError` 是 Error 不是业务异常，HTTP 层必须翻译成 40904 */
function moveNode(from: string, to: NodeStatus, message: string): NodeStatus {
  try {
    return transitionNode(from as NodeStatus, to);
  } catch {
    throw new BizException(ErrorCode.IllegalStateTransition, { from, to }, message);
  }
}

function moveRun(from: string, to: PlanRunStatus, message: string): PlanRunStatus {
  try {
    return transitionPlanRun(from as PlanRunStatus, to);
  } catch {
    throw new BizException(ErrorCode.IllegalStateTransition, { from, to }, message);
  }
}

/** 用户确认节点时留下的凭据 */
function decisionResult(dto: ConfirmOsNodeDto): Record<string, string> {
  return {
    confirmedBy: 'user',
    confirmedAt: new Date().toISOString(),
    ...(dto.decision ? { decision: dto.decision } : {}),
    ...(dto.note ? { note: dto.note } : {}),
  };
}

/**
 * 节点 → 驿站需求。
 *
 * 标题与描述**默认由节点名和计划目标拼出来**（用户一键发布时不该被表单拦住），
 * 但仍然过一遍 `PublishTaskSchema`：这条链路与 `POST /station/tasks` 共用同一套规则，
 * 只在这里放宽一次，就会变成"从 OS 发的需求可以短标题、手填的不可以"。
 */
function publishInput(run: OsRunRow, node: OsTaskNodeRow, dto: PublishOsNodeDto): PublishTaskDto {
  const budget = dto.budget ?? node.budget;
  const title = (dto.title ?? node.name).trim().slice(0, 60);
  const description = (
    dto.description ?? `${node.name}（青智 OS 计划「${run.goal}」里的真人环节，需要到场完成）`
  )
    .trim()
    .slice(0, 2000);

  const parsed = PublishTaskSchema.safeParse({
    title,
    categoryId: dto.categoryId,
    description,
    budget,
    budgetType: dto.budgetType ?? (budget > 0 ? 'fixed' : 'negotiable'),
    ...(dto.deadline ? { deadline: dto.deadline } : {}),
    ...(dto.location ? { location: dto.location } : {}),
    // 规划器目前不产出技能标签；留空 = 大厅里靠分类 + 标题被检索到，不编造标签
    skillTags: asStringArray(node.skillTags),
    source: 'os_plan',
    refRunId: run.id,
  });
  if (!parsed.success) {
    throw new BizException(
      ErrorCode.ParamInvalid,
      issueDetail(parsed.error),
      '节点信息不足以生成一条合规需求，请在发布时补充标题或描述',
    );
  }
  return parsed.data;
}

function issueDetail(error: ZodError): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  for (const issue of error.issues) detail[issue.path.join('.') || '_'] = issue.message;
  return detail;
}
