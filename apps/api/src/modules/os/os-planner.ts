import {
  OS_PLAN_MAX_NODES,
  OS_PLAN_NODE_TYPES,
  type LlmMessage,
  type OsPlanNode,
  type OsPlanNodeType,
  type OsPlanResult,
} from '@qz/core';

/**
 * 任务规划（M2-05 planner）—— **`plan` 档（深度思考）的唯一调用点**。
 *
 * ## 为什么单独成文件
 *
 * 与 `os-intent.ts` 同理：提示词、输出 schema、输出校验是**一套东西**。
 * 而且这里的校验比意图识别更重 —— 它要保证产出的是一张**合法的 DAG**，
 * 不是一段看起来像计划的文本。
 *
 * ## 为什么用 `plan` 档而不是 `generate` 档
 *
 * 三档（`intent` / `generate` / `plan`）在 `.env` 里可独立换模型。规划要做的是
 * "把一句话拆成带依赖关系的多步计划"，是纯推理任务、不需要文采，且**输出必须严格合法**。
 * 与对话正文（`generate`）的取舍不同：规划宁慢求准，对话宁快求顺。
 * 把两件事挤在同一档，就没法在"规划变慢了"和"对话变慢了"之间单独调参。
 *
 * ## 降级是显式的，不是静默的
 *
 * 模型返回的 JSON 非法（缺字段、有环、超 12 节点）时，这里**不编造一张计划**，
 * 而是返回 `nodes: []` + `degraded: true` + 原因。客户端据此退回
 * `buildPlanFromSubtasks(intent.subtasks)` —— 那份子任务同样是模型的真实输出
 *（来自 `intent` 档），只是没有依赖关系。**红线 9：宁可显示"没规划成功"，
 * 也不产出一张看起来像计划、实际是编出来的图。**
 */

/** 结构化输出的 JSON Schema（与 `INTENT_JSON_SCHEMA` 同一套 `json_object` + 提示词约束） */
export const PLAN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string' },
    nodes: {
      type: 'array',
      maxItems: OS_PLAN_MAX_NODES,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string', enum: [...OS_PLAN_NODE_TYPES] },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'name', 'type'],
      },
    },
  },
  required: ['nodes'],
} as const;

/**
 * 系统提示词。
 *
 * 设计要点：
 *   · 把 `type` 四个取值的**判定标准**写清楚 —— 否则模型会把所有节点都标成 `ai`，
 *     界面就不会给"去驿站发布"的入口，真人环节被吞掉；
 *   · 明确"id 只能用小写字母 + 数字"，避免模型产出 `"步骤一"` 这类
 *     `dependsOn` 无法稳定引用的 id；
 *   · 明确"不许成环"并给出正确示例 —— 只写"不能有环"模型仍会犯；
 *   · 明确"只拆解用户真正提到的目标"，防止为了凑数添加环节。
 */
export const PLAN_SYSTEM_PROMPT = `你是「青智校园」的任务规划器。用户给出一个目标，你要把它拆成一张**有依赖关系的执行计划**（DAG）。

输出规则（必须严格遵守）：
1. 只输出 JSON，不要任何解释文字、不要 Markdown 围栏。
2. 节点数量 **1~${OS_PLAN_MAX_NODES} 个**，只拆解用户真正提到的目标，不要为了凑数添加环节。
3. 每个节点形如：
   { "id": "n1", "name": "节点名", "type": "ai", "dependsOn": [] }
   - id 只能用小写字母 + 数字（如 n1、n2），**不要用中文或空格**；
   - dependsOn 里只能填**已存在的 id**，且**绝不能成环**（A 依赖 B、B 又依赖 A 是错的）；
   - 第一个节点的 dependsOn 必须是空数组 []。

4. type 只能取这四个值之一，判定标准如下：
   - "ai"：机器可以独立完成。写方案、做预算表、生成大纲、生成海报提示词、总结长文。
   - "human"：**必须真人到场或动手**。摄影摄像、现场主持、跑腿、布置场地、志愿者。
   - "hitl"：需要**用户本人拍板**才能继续。确认预算口径、选择场地、验收成品。
   - "external"：依赖平台外的第三方审批或流程。场地报备、学校审批、外部供应商对接。

5. **不要编造平台能力**。青智校园当前真正能做的只有：AI 生成大纲、AI PPT 生成、
   长文总结、AI 生图提示词、图片压缩/转格式/增强、OCR 文字识别、语音转文字、
   以及发布需求到「青智驿站」找真人帮忙。超出这些的节点照样可以出现在计划里
   （计划描述的是"要做什么"，不是"平台已经能做什么"），但**不要**声称某一步已经完成。

6. 所有节点都是**待执行**状态。不要假设任何一步已经做完。

示例（用户说"我要办一场 200 人的创新创业活动，预算 3000，帮我全部安排"）：
{"goal":"办一场 200 人的创新创业活动","nodes":[
 {"id":"n1","name":"确认活动方案与流程","type":"hitl","dependsOn":[]},
 {"id":"n2","name":"AI 生成活动策划书","type":"ai","dependsOn":["n1"]},
 {"id":"n3","name":"AI 生成预算明细表","type":"ai","dependsOn":["n2"]},
 {"id":"n4","name":"申请场地并报备","type":"external","dependsOn":["n1"]},
 {"id":"n5","name":"找同学现场摄影","type":"human","dependsOn":["n4"]},
 {"id":"n6","name":"活动执行与收尾","type":"human","dependsOn":["n3","n5"]}
]}`;

/** 组装任务规划请求消息 */
export function buildPlanMessages(goal: string): LlmMessage[] {
  return [
    { role: 'system', content: PLAN_SYSTEM_PROMPT },
    { role: 'user', content: goal },
  ];
}

/**
 * 校验并归一化模型输出，产出**保证合法**的计划。
 *
 * 不做"尽力修补"：任何一处硬性约束（节点数、id 唯一、依赖存在、无环）不满足，
 * 都整体降级为 `nodes: []`，让客户端用真实但无依赖的子任务列表顶上。
 * 理由：一张**部分修补过**的 DAG 比没有 DAG 更危险 —— 界面会把它当成模型真实意图展示，
 * 而实际上有些边是我们猜的。
 */
export function normalizePlan(raw: unknown, goal: string): OsPlanResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const nodes = toNodeArray(r.nodes);

  if (nodes.length === 0) {
    return degraded(goal, '模型没有给出任何可用的计划节点');
  }
  if (nodes.length > OS_PLAN_MAX_NODES) {
    return degraded(goal, `计划节点数 ${nodes.length} 超过上限 ${OS_PLAN_MAX_NODES}`);
  }

  const sorted = topoSort(nodes);
  if (!sorted) {
    return degraded(goal, '计划里存在环或指向了不存在的节点，已按"未规划成功"处理');
  }

  return {
    goal: typeof r.goal === 'string' && r.goal.trim() ? r.goal.trim() : goal,
    nodes: sorted,
    degraded: false,
  };
}

/** 降级结果：不编造节点，把原因如实上报 */
export function degraded(goal: string, reason: string): OsPlanResult {
  return { goal, nodes: [], degraded: true, degradedReason: reason };
}

/**
 * 归一化节点数组。
 *
 * 丢弃规则（任一不满足即丢掉该节点，而不是让它带着脏数据往下走）：
 *   · 不是对象 / id 或 name 为空 → 丢；
 *   · id 重复 → 丢后出现的那一个（前一个已经建立了依赖引用）；
 *   · `type` 表外取值 → 归为 `ai`（保守：不会凭空多出"需真人完成"的节点）。
 */
function toNodeArray(v: unknown): OsPlanNode[] {
  if (!Array.isArray(v)) return [];

  const seen = new Set<string>();
  const out: OsPlanNode[] = [];

  for (const item of v) {
    const node = toNode(item);
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }

  return out;
}

/** 单个节点的归一化；返回 `null` 表示这个节点不可用 */
function toNode(item: unknown): OsPlanNode | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;

  const o = item as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!id || !name) return null;

  return { id, name, type: toNodeType(o.type), dependsOn: toIdArray(o.dependsOn, id) };
}

function toNodeType(v: unknown): OsPlanNodeType {
  return OS_PLAN_NODE_TYPES.includes(v as OsPlanNodeType) ? (v as OsPlanNodeType) : 'ai';
}

/** 依赖 id 列表：去空、去重，并**剔除自依赖**（自依赖必然成环，留着一定降级） */
function toIdArray(v: unknown, self: string): string[] {
  if (!Array.isArray(v)) return [];
  const ids = v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x !== '' && x !== self);
  return [...new Set(ids)];
}

/**
 * 拓扑排序（Kahn 算法）。
 *
 * **同时承担两个职责**：无环校验 + 输出顺序。计划卡是线性渲染的，
 * 按拓扑序输出才能保证"依赖的节点一定排在前面" —— 否则用户会看到一个
 * 还没做完就被引用的步骤。
 *
 * @returns 拓扑序节点数组；存在环或悬空依赖时返回 `null`
 */
function topoSort(nodes: OsPlanNode[]): OsPlanNode[] | null {
  const graph = buildGraph(nodes);
  if (!graph) return null;

  const queue = nodes.filter((n) => (graph.indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const out: OsPlanNode[] = [];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    const node = graph.byId.get(id);
    if (!node) return null;
    out.push(node);

    for (const child of graph.children.get(id) ?? []) {
      const left = (graph.indegree.get(child) ?? 0) - 1;
      graph.indegree.set(child, left);
      if (left === 0) queue.push(child);
    }
  }

  // 有环时排不完，输出的长度一定小于节点数
  return out.length === nodes.length ? out : null;
}

/** 计划图的邻接结构（Kahn 算法的工作区） */
interface PlanGraph {
  byId: Map<string, OsPlanNode>;
  indegree: Map<string, number>;
  children: Map<string, string[]>;
}

/**
 * 建图。
 *
 * @returns 邻接结构；依赖**指向不存在的 id** 时返回 `null`
 *（悬空依赖无法拓扑排序，与成环同等对待）
 */
function buildGraph(nodes: OsPlanNode[]): PlanGraph | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const children = new Map<string, string[]>(nodes.map((n) => [n.id, []]));

  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      if (!byId.has(dep)) return null;
      indegree.set(n.id, (indegree.get(n.id) ?? 0) + 1);
      children.get(dep)?.push(n.id);
    }
  }

  return { byId, indegree, children };
}
