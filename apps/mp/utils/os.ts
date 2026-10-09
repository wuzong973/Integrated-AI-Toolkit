/**
 * 青智 OS（AI 助手）的共享类型与纯逻辑
 *
 * ## 为什么从页面里拆出来
 *
 * `pages/os/index.ts` 已经贴着单文件 300 行的红线（ESLint `max-lines`），
 * 再加逻辑必然超限。而这些**纯函数与常量本来就不属于页面**：
 * 意图映射、离线兜底规则、计划卡构建 —— 放在这里既能被单测直接打靶，
 * 也让页面只剩"渲染与事件"。
 *
 * ## 与后端的分工
 *
 * 后端 `/os/intent` 用大模型做意图识别（更准）；本文件的 `localIntent`
 * 是**离线兜底**（断网 / 后端没起时保证 AI 页不白屏）。
 * 两份逻辑**刻意不合并**，但**意图取值必须与后端一致**
 *（`packages/core/src/validators/index.ts` 的 `OS_INTENTS`）。
 */

/** 节点视觉状态（由业务状态映射而来，只服务展示，见 MP-VISUAL-SYSTEM.md） */
export type NodeState = 'done' | 'run' | 'wait' | 'human';

/**
 * 计划节点类型（与 `packages/core` 的 `OS_PLAN_NODE_TYPES` 一致）。
 *
 * ⚠️ 取值必须两边同步：`hitl` / `external` 是**服务端 planner 才会产出**的类型，
 * 小程序侧只做展示映射。若这里少一个取值，`type` 会落到 `undefined`，
 * 界面表现为"节点没有图标、也没有说明文字"——**不报错**，只是看起来像没做完。
 */
export type PlanNodeType = 'ai' | 'human' | 'hitl' | 'external';

/** 计划节点 */
export interface PlanNode {
  id: string;
  name: string;
  type: PlanNodeType;
  status: string;
  icon: string;
  detail: string;
  state: NodeState;
  budget?: number;
}

/** 计划卡（文档 5.3.2 核心 UI） */
export interface PlanCard {
  runId: string;
  total: number;
  done: number;
  /** 完成度百分比，驱动进度条 */
  percent: number;
  nodes: PlanNode[];
  needHumanCount: number;
  published: boolean;
  /**
   * true = 这次**没有规划成功**，节点来自意图识别的子任务清单（无依赖关系）。
   *
   * 必须如实展示（红线 9）：否则用户会把一张"只是排了顺序"的清单
   * 当成 AI 认真拆解过的执行计划。
   */
  degraded?: boolean;
}

/** 动作按钮（工具路由用） */
export interface ActionButton {
  label: string;
  toolName: string;
}

/** 模型返回的子任务（后端 `OsIntentResult.subtasks` 的结构） */
export interface OsSubtask {
  name: string;
  type: 'ai' | 'human';
}

/** 意图识别结果（与后端 `OsIntentResult` 对齐；字段缺失时按可选处理） */
export interface OsIntent {
  intent: string;
  confidence: number;
  isComposite: boolean;
  subtasks?: OsSubtask[];
  needsClarification?: boolean;
  questions?: string[];
}

/** 服务端 planner 产出的计划节点（对应 `packages/core` 的 `OsPlanNode`） */
export interface OsPlanNode {
  id: string;
  name: string;
  type: PlanNodeType;
  dependsOn: string[];
}

/**
 * 任务规划结果（对应 `POST /os/plan`）。
 *
 * `degraded === true` 时 `nodes` 一定为空 —— 服务端**不编造**计划，
 * 此时应退回 `buildPlanFromSubtasks(intent.subtasks)`。
 */
export interface OsPlanResult {
  goal: string;
  nodes: OsPlanNode[];
  degraded: boolean;
  degradedReason?: string;
}

/**
 * 意图 → 建议工具（文档 7.4.1 工具路由表）。
 *
 * ⚠️ **这里只能放 `status: 'active'` 的工具**。
 * 曾经它指向 `compress_video` / `separate_vocals`，而这两个后来被标为 `planned`
 * —— 用户点按钮只会拿到"即将上线"的弹窗，等于 AI 助手把人引到了一个死路。
 * 静态守卫 `npm run check:tools` 会拦截这种不一致。
 *
 * ⚠️ 这里只是**离线兜底**：后端在线时，"该挂哪个入口"由服务端的结果卡决定
 *（`OsToolCard`，带真实作业 id 与已解析的参数），比这张静态表准得多。
 * 所以它只需要保证"点了有用"，不需要覆盖每个工具。
 *
 * `toolbox` 是**特殊动作**（不是工具名）：`file_process` / `media_ai` 下有好几个
 * 已上线工具（图片压缩 / 抠图 / 视频压缩 / 语音转文字…），静态表挑不出"哪一个"，
 * 硬挑一个反而会把人引到不想要的那个；直接送到工具箱让他自己选最诚实。
 * 它必须在 `scripts/dev/check-tool-status.mjs` 的 `INTENT_SPECIAL_ACTIONS` 里登记，
 * 否则守卫会把它当成"指向了跑不通的工具"。
 */
export const INTENT_TOOL_MAP: Record<string, ActionButton> = {
  ai_generate: { label: 'AI PPT 生成', toolName: 'generate_ppt' },
  campus_service: { label: '去青智驿站发布', toolName: 'create_task' },
  file_process: { label: '去工具箱处理文件', toolName: 'toolbox' },
  media_ai: { label: '去工具箱处理音视频', toolName: 'toolbox' },
};

/**
 * 离线兜底：后端不可用时的关键词规则。
 *
 * 只保证"不白屏、能给出一个合理方向"，不追求准确 ——
 * 准确的那份在后端（`apps/api/src/modules/os/os-intent.ts`，用大模型）。
 */
export function localIntent(text: string): OsIntent {
  if (/活动|策划|全部安排/.test(text)) {
    return { intent: 'campus_service', isComposite: true, confidence: 0.9 };
  }
  if (/\.(mov|avi|mkv|mp4)|压缩|转(换|成)|ocr/i.test(text)) {
    return { intent: 'file_process', isComposite: false, confidence: 0.9 };
  }
  // 只要提到"人声/伴奏"就足以判定为音视频 AI 处理。
  // 原来的 `/(去|分离).*(人声|伴奏)/` 依赖语序，"把这首歌的人声和伴奏分开"这类
  // 常见说法反而匹配不上（实测漏判），故不再要求动词在前。
  if (/(人声|伴奏)/.test(text)) {
    return { intent: 'media_ai', isComposite: false, confidence: 0.9 };
  }
  if (/ppt|幻灯片|演示/i.test(text)) {
    return { intent: 'ai_generate', isComposite: false, confidence: 0.9 };
  }
  if (/(找|请).*(同学|服务)|发布.*需求/.test(text)) {
    return { intent: 'campus_service', isComposite: false, confidence: 0.8 };
  }
  return { intent: 'knowledge', isComposite: false, confidence: 0.6 };
}

/**
 * 由模型给出的子任务构建计划卡。
 *
 * ⚠️ **全部节点都是待执行状态，不伪造"AI 已完成"**。
 * 之前这里用的是写死的演示数据（节点标着 `succeeded` / "AI 已完成 · 2min"、
 * 还带编造的预算），用户会以为任务真的跑完了 —— 那是假成功（红线 9）。
 * 现在节点来自模型的真实拆解结果，状态如实标为"待执行"。
 */
export function buildPlanFromSubtasks(subtasks: OsSubtask[]): PlanCard {
  const nodes: PlanNode[] = subtasks.map((s, i) => {
    const human = s.type === 'human';
    return {
      id: `n${i + 1}`,
      name: s.name,
      type: human ? 'human' : 'ai',
      status: 'pending',
      icon: human ? 'qz-i-station' : 'qz-i-sparkle',
      detail: human ? '需真人完成 · 待发布' : '待执行',
      state: human ? 'human' : 'wait',
    };
  });

  return {
    // 尚无真实的 run 记录（计划持久化与执行尚未实现），留空字符串而不是编一个 id
    runId: '',
    total: nodes.length,
    done: 0,
    percent: 0,
    nodes,
    needHumanCount: nodes.filter((n) => n.type === 'human').length,
    published: false,
    degraded: true,
  };
}

/**
 * 由**服务端 planner** 的 DAG 节点构建计划卡（`POST /os/plan` 的产物）。
 *
 * 与 `buildPlanFromSubtasks` 的区别：那份只有"有哪些子任务"，这份还有
 * **依赖关系**（服务端已做无环校验并排好拓扑序），所以 `detail` 里会带上
 * "依赖 N 项"，让用户看出步骤之间的先后。
 *
 * 节点仍然**全部是待执行状态** —— 规划不等于执行，这里不伪造任何"已完成"。
 */
export function buildPlanFromNodes(nodes: OsPlanNode[]): PlanCard {
  const mapped: PlanNode[] = nodes.map((n) => {
    const human = n.type === 'human';
    return {
      id: n.id,
      name: n.name,
      type: n.type,
      status: 'pending',
      icon: NODE_ICON[n.type],
      detail: nodeDetail(n),
      // hitl / external 也还没有对应的视觉状态，统一走 wait（不新增样式，避免视觉体系漂移）
      state: human ? 'human' : 'wait',
    };
  });

  return {
    runId: '',
    total: mapped.length,
    done: 0,
    percent: 0,
    nodes: mapped,
    needHumanCount: mapped.filter((n) => n.type === 'human').length,
    published: false,
    degraded: false,
  };
}

/** 节点图标（只用糖果图标库里的类名，见 styles/icons.scss） */
const NODE_ICON: Record<PlanNodeType, string> = {
  ai: 'qz-i-sparkle',
  human: 'qz-i-station',
  hitl: 'qz-i-check',
  external: 'qz-i-verify',
};

/**
 * 节点说明文字。
 *
 * 逐类型给出**用户能看懂的一句话**，而不是把 `type` 原样显示成英文。
 * `hitl` 特意写成"需你确认"——它和 `ai` 都是自动执行，区别只在
 * "要不要等用户点一下"，这个差别不写清楚用户会以为卡住了。
 */
function nodeDetail(n: OsPlanNode): string {
  const base =
    n.type === 'human'
      ? '需真人完成 · 待发布'
      : n.type === 'hitl'
        ? '需你确认后继续'
        : n.type === 'external'
          ? '需第三方办理'
          : '待执行';

  const deps = n.dependsOn.length;
  return deps > 0 ? `${base} · 依赖 ${deps} 项` : base;
}

/**
 * 助手回复里带的**结果卡**。
 *
 * 与后端 `apps/api/src/modules/os/os-tool-card.ts` 的 `OsToolCard` **同形**。
 * 小程序不能 `import` 后端或 `@qz/core`（微信开发者工具解析不到，需要"构建 npm"配合），
 * 所以类型在这里各写一份，靠注释对齐 —— 与本文件其它类型（`OsIntent` 等）同一套做法。
 *
 * ⚠️ 改字段必须两边一起改。`npm run audit:mp` 会核对 wxml 里绑定的字段在 TS 里存在。
 *
 * 三种形态：
 *   · `result` —— 本轮真的执行过了，带 `jobId`，点进结果页看产物/进度；
 *   · `guide`  —— 本轮没执行（缺文件），带 `route`，点进执行页去上传；
 *   · `files`  —— 本轮没执行，但用户手上已有文件，带 `route`，点进「我的文件」。
 */
export interface OsToolCard {
  kind: 'result' | 'guide' | 'files';
  toolName: string;
  title: string;
  summary: string;
  params: { label: string; value: string }[];
  jobId?: string;
  status?: string;
  outputCount?: number;
  route?: string;
  note?: string;
}

/**
 * 结果卡的状态文案。
 *
 * ⚠️ 只有 `succeeded` 才显示"已完成"。`succeeded` 之外的状态**一律显示"处理中"** ——
 * 长任务（PPT / 视频）提交后立刻回来时状态是 `queued`，把它渲染成"已完成"
 * 就是红线 9 说的假成功：用户点进去会发现文件还没出来。
 *
 * 同理，状态**缺失**时也按"处理中"处理（宁可保守也不要谎报完成）。
 *
 * `files` 卡的徽标是「往期产物」：它**不是本轮的结果**。这个措辞必须把这一点说清楚，
 * 否则用户会把下面这张卡当成刚刚生成的东西 —— 那就是另一种形式的假成功。
 */
export function cardStatusText(card: OsToolCard): string {
  if (card.kind === 'guide') return '需要上传文件';
  if (card.kind === 'files') return '往期产物';
  switch (card.status) {
    case 'succeeded':
      return '已完成';
    case 'failed':
      return '执行失败';
    default:
      return '处理中';
  }
}

/**
 * 卡片是否可点击（没有任何去处时不要给点击态，避免"点了没反应"）。
 *
 * `guide` 与 `files` 都靠后端拼好的 `route`；`result` 靠 `jobId` 现拼结果页路由。
 */
export function cardActionable(card: OsToolCard): boolean {
  return card.kind === 'result' ? !!card.jobId : !!card.route;
}

/**
 * 卡片底部那颗"去"按钮的文字。
 *
 * 在 TS 里算好再交给 WXML —— 模板里不能调函数，而三层嵌套三元读起来很糟、
 * 出错时也不会有堆栈（只会静默渲染成空白）。
 */
export function cardActionText(card: OsToolCard): string {
  if (card.kind === 'guide') return '去上传文件';
  if (card.kind === 'files') return '打开我的文件';
  return '查看结果';
}

/**
 * 卡片图标（只用糖果图标库里的类名，见 `styles/icons.scss`）。
 *
 * `files` 用 `qz-i-files` —— 与底部快捷栏「我的文件」**同一个图标**。
 * 图标本身就是路标：两处一致，用户才认得出这是同一个地方。
 */
export function cardIcon(card: OsToolCard): string {
  if (card.kind === 'guide') return 'qz-i-doc';
  if (card.kind === 'files') return 'qz-i-files';
  return 'qz-i-sparkle';
}

/**
 * 渲染用视图对象。
 *
 * WXML 里**不能调用 TS 函数**，所以凡是"要算一下才能显示"的东西
 *（状态文案、能不能点、按钮文字、图标、参数摘要行）都必须在进 `setData` 之前算好。
 * 这也顺带把逻辑留在可单测的纯模块里，而不是塞进模板表达式
 *（WXML 里的复杂表达式出错时**没有堆栈**，只会静默渲染成空白）。
 */
export interface OsToolCardView extends OsToolCard {
  /** 状态文案，如「已完成」/「处理中」/「需要上传文件」/「往期产物」 */
  statusText: string;
  /** 是否可点击（决定要不要给按下反馈） */
  actionable: boolean;
  /** 底部按钮文字 */
  actionText: string;
  /** 糖果图标类名 */
  icon: string;
  /** 参数摘要压成一行：`主题：创青春路演 · 页数：20` */
  paramText: string;
}

/** 把结果卡转成可直接渲染的视图对象 */
export function toCardView(card: OsToolCard): OsToolCardView {
  return {
    ...card,
    statusText: cardStatusText(card),
    actionable: cardActionable(card),
    actionText: cardActionText(card),
    icon: cardIcon(card),
    paramText: (card.params ?? []).map((p) => `${p.label}：${p.value}`).join(' · '),
  };
}

/**
 * 点击卡片要跳去哪里。
 *
 * 抽成纯函数是为了能被单测直接打靶 —— 它决定"用户点下去有没有反应"，
 * 而这类问题在真机上才暴露、代价最高（本项目已有的教训：按钮点了没反应）。
 *
 * 三种形态的去向完全不同：
 *   · `result` → 结果页（看产物 / 看进度）；
 *   · `guide`  → 执行页（去选文件），路由由后端拼好并带上已解析的参数；
 *   · `files`  → 「我的文件」列表（往期产物都在那），路由同样由后端给。
 * 前两种是分包页，用 `navigateTo`；`files` 也是分包页（非 tabBar），同样 `navigateTo`。
 */
export function cardTarget(card: OsToolCard): string | null {
  if (card.kind === 'guide' || card.kind === 'files') return card.route ?? null;
  if (!card.jobId) return null;
  return `/pkg-toolbox/result/index?jobId=${encodeURIComponent(card.jobId)}`;
}

/** 会话页的消息角色 / 形态（仅服务渲染，与后端 `os_message` 的 role/contentType 对应） */
export type MsgRole = 'user' | 'assistant' | 'system';
/** file = 带附件的消息（快捷栏上传成功后记录用） */
export type MsgKind = 'text' | 'card' | 'buttons' | 'file';

/**
 * 会话页里的一条消息（纯视图结构）。
 *
 * 放在这里而不是页面里：页面已贴着单文件 300 行上限，而这是**纯类型**。
 * 注意 `cards` 存的是**渲染视图**（`OsToolCardView`）而不是后端原始卡 ——
 * 状态文案 / 能否点击 / 参数摘要行都要在进 `setData` 之前算好
 *（WXML 里不能调函数，模板表达式出错也不会报错）。
 */
export interface ChatMessage {
  id: string;
  role: MsgRole;
  agentName?: string;
  kind: MsgKind;
  content: string;
  plan?: PlanCard;
  buttons?: ActionButton[];
  cards?: OsToolCardView[];
  createdAt: string;
}

/** 后端回复的载荷（正文 + 结果卡） */
export interface ReplyPayload {
  text: string;
  cards: OsToolCard[];
}

/**
 * 空会话时的引导卡。
 *
 * 放在这里而不是页面里的原因和别处一样：页面已贴着单文件 300 行上限，
 * 而这是**纯数据**（图标类名同样只来自糖果图标库）。
 *
 * ⚠️ 每句引导都必须指向**真的能跑**的能力：
 * "办活动"能跑（走驿站发布）、"做 PPT"能跑（generate_ppt）、
 * "处理文件"能跑（工具箱）、"找人帮忙"能跑（驿站）——
 * 引导用户点一个点了没用的示例，比不给示例更伤信任。
 */
export const GUIDE_CARDS = [
  {
    key: 'ppt',
    label: '做 PPT',
    icon: 'qz-i-office',
    text: '帮我做一份创青春路演 PPT，16 页，商务风',
  },
  {
    key: 'event',
    label: '办活动',
    icon: 'qz-i-rocket',
    text: '我要办一场 200 人的创新创业活动，预算 3000，帮我全部安排',
  },
  { key: 'file', label: '处理文件', icon: 'qz-i-video', text: '把视频压缩到 50MB' },
  { key: 'people', label: '找人帮忙', icon: 'qz-i-station', text: '我要找一个同学拍毕业照' },
];

/**
 * 会话建立后的**开场白消息**。
 *
 * 放在这里而不是页面里：`pages/os/index.ts` 已贴着单文件 300 行上限，
 * 而这是**纯数据 + 文案**（无 wx 依赖），与 `GUIDE_CARDS` / `intentFallbackText` 同族，
 * 可以被单测直接打靶。
 *
 * ⚠️ 后端不可用时必须**如实说**是「演示模式」—— 让用户以为模型在回答他，
 * 就是红线 9 说的假成功。
 */
export function buildHelloMessage(backendReady: boolean): ChatMessage {
  return {
    id: `hello_${Date.now()}`,
    role: 'assistant',
    agentName: 'coordinator',
    kind: 'text',
    content: backendReady
      ? '你好，我是青智 OS。告诉我你想完成什么？我会拆解任务：能交给 AI 做的自动做，需要真人做的帮你发到青智驿站。'
      : '你好，我是青智 OS（演示模式，后端未连接）。你可以先输入需求看看拆解效果。',
    createdAt: new Date().toISOString(),
  };
}

/**
 * 给 Promise 加一个等待上限：超时或失败都返回 `null`，由调用方决定兜底。
 *
 * 用 `Promise.race` 而不是 `Promise.allSettled` 的原因是"不等它了"，
 * 所以必须自己把落败的那条 promise 接住（`.catch(() => null)`）——
 * 否则它之后 reject 时无人接管，会冒成 unhandledrejection。
 *
 * ⚠️ 超时**不等于放弃**：调用方会继续等那条 promise，到了再原地补上内容
 *（见 `pages/os/index.ts` 的 `onSend`）—— 所以既不干等，也不丢信息。
 */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/**
 * 计划节点类型白名单（与 `packages/core` 的 `OS_PLAN_NODE_TYPES` 一致）。
 *
 * 表外取值一律归为 `ai` —— 与后端 `os-planner.ts` 同一个取舍：
 * 判成 ai 顶多是"该找人的环节没给发布入口"，判成 human 却会凭空多出一个
 * "需真人完成"的节点，引导用户去发布一个根本不存在的需求。
 */
export function toPlanNodeType(v: string): PlanNodeType {
  return v === 'human' || v === 'hitl' || v === 'external' ? v : 'ai';
}

/**
 * 后端回复拿不到时的兜底文案（超时、断网、模型不可用）。
 *
 * 按意图给一句**有用且诚实**的话，而不是干巴巴的"好的"。
 *
 * 放在这里而不是页面里：它是**纯函数**、与 wx 无关，可以被单测直接打靶，
 * 而 `pages/os/index.ts` 已经贴着单文件行数上限。
 */
export function intentFallbackText(intent: OsIntent): string {
  if (intent.needsClarification && intent.questions?.length) {
    return `我需要再确认一下：${intent.questions.slice(0, 2).join('；')}`;
  }
  switch (intent.intent) {
    case 'ai_generate':
      return '这类内容可以直接生成，说清主题和要求即可（也可以点下面的入口）。';
    case 'campus_service':
      return '这件事需要真人帮忙，可以发到青智驿站让同学接单。';
    case 'file_process':
    case 'media_ai':
      // ⚠️ 这句以前写的是"还在开发中"——那在视频/音频工具转 active 之后就变成了谎话。
      // 现在改为如实指路：这些工具都已上线，只是需要先上传文件。
      return '这类处理需要先上传文件，点下面的入口选文件即可（图片 / 视频 / 音频都支持）。';
    default:
      return '我先记下了。换个说法再问我一次，或试试下面已上线的工具。';
  }
}
