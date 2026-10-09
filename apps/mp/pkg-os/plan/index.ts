/**
 * 任务编排看板（文档 5.3.3）
 *
 * 设计说明：节点按【阶段分组】展示，而不是平铺 DAG 图 ——
 * 手机屏幕不适合画复杂有向图，用"阶段 + 状态分组"表达依赖关系更易读。
 *
 * ## 数据源（M2-06 已接真接口）
 *
 * `GET /os/runs/:runId` 返回 `OsRunView`，本页**直接消费该类型**
 * （以前那串 `as unknown as Record<string, unknown>` 会让后端改字段时
 * 一个编译错误都不报，界面只是静默渲染成空白）。
 * 节点操作走的也是真路由（见 `apps/api/src/modules/os/os.controller.ts`）：
 *   · `hitl` 节点确认 → `POST /os/runs/:id/nodes/:nodeId/confirm`；
 *   · `human` 节点发布 → 先挑服务分类，再 `POST …/nodes/:nodeId/publish`；
 *   · 已发布的真人节点 → 跳驿站任务详情（带后端回写的 `refTaskId`）。
 *
 * ⚠️ **终止**与**节点重试**后端没有路由（上面那份 controller 只有 confirm / publish
 * 两条写路径，`grep -i terminate` 为空），所以这两处仍是 `showNotReady`，
 * 不弹"已成功"（红线 9）。
 */
import type { OsRunNode, OsRunView, ToolCategoryItem } from '../../utils/api';
import { osApi, stationApi } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { openOs } from '../../utils/nav';
import { showNotReady } from '../../utils/not-ready';
import { toPlanNodeType, type PlanNodeType } from '../../utils/os';
import { toastError } from '../../utils/request';

/** 看板节点（字段与后端 `OsRunNodeView` 一致，type 已过白名单） */
interface PlanNode {
  nodeId: string;
  name: string;
  type: PlanNodeType;
  status: string;
  actorLabel: string;
  detail: string;
  /** 预算（分）；0 =「面议」，不下发也不显示 */
  budget?: number;
  /** 已发布到驿站后的需求 id（后端 publishNode 回写） */
  refTaskId?: string;
}

/** 节点 + 纯展示字段：糖果图标 / 操作文案 / 色调 / 关联需求标识（WXML 不能调函数，全部在此算好） */
type NodeView = PlanNode & {
  iconClass: string;
  actionText: string;
  toneClass: string;
  refText: string;
};

type StageView = { name: string; iconClass: string; nodes: NodeView[] };

/**
 * 看板只消费 `OsRunView` 的这两列。
 *
 * 用 `Pick` 而不是自己再声明一遍形状：演示兜底数据同样满足它，
 * 于是 `applyRun()` 一份签名通吃真接口与兜底 —— **不需要任何 `as unknown as`**
 * （那种转换会让后端改字段时一个编译错误都不报，界面只是静默渲染成空白）。
 */
type RunBoard = Pick<OsRunView, 'goal' | 'stages'>;

/** 筛选 Tab（文档 5.3.3） */
const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'ai', label: 'AI 处理中' },
  { key: 'hitl', label: '待我确认' },
  { key: 'human', label: '已指派真人' },
  { key: 'succeeded', label: '已完成' },
];

/**
 * 筛选用谓词。
 *
 * 做成表而不是在 tap 里写一串 if：新增一个筛选 Tab 时，
 * FILTERS 与这张表一起加一行就行，onFilterTap 不用跟着改（也就不会漏改某一支）。
 */
const NODE_FILTERS: Record<string, (n: NodeView) => boolean> = {
  ai: (n) => n.type === 'ai' && (n.status === 'running' || n.status === 'pending'),
  hitl: (n) => n.status === 'awaiting_hitl',
  human: (n) => n.type === 'human',
  succeeded: (n) => n.status === 'succeeded',
};

/** 演示节点行：[id, 名称, 类型, 状态, 执行者, 说明, 预算（分）?, 关联任务?] */
type DemoRow = [string, string, 'ai' | 'human', string, string, string, number?, string?];

/**
 * 演示看板数据，与 Mock LLM 生成的 8 节点计划保持一致。
 */
const DEMO_NODES: DemoRow[] = [
  ['n1', '活动方案', 'ai', 'succeeded', 'AI', '2min'],
  ['n2', '预算表', 'ai', 'succeeded', 'AI', '1min'],
  ['n3', '宣传文案', 'ai', 'succeeded', 'AI', '40s'],
  ['n4', '海报设计', 'ai', 'running', 'AI', '60%'],
  ['n5', '报名页面', 'ai', 'pending', 'AI', '等待前置'],
  ['n6', '摄影摄像', 'human', 'published', '真人', '已发布 · 3人报名', 30000, 'demo_t1'],
  ['n7', '现场主持', 'human', 'published', '真人', '已发布 · 待接单', 50000, 'demo_t2'],
  ['n8', '志愿者×5', 'human', 'published', '真人', '已发布 · 2人报名', 0, 'demo_t3'],
];

/** 演示行 → 后端节点形状（缺的字段给**中性值**，不编造进度与时间） */
const toDemoNode = (r: DemoRow): OsRunNode => ({
  nodeId: r[0],
  name: r[1],
  type: r[2],
  status: r[3],
  actorLabel: r[4],
  detail: r[5],
  dependsOn: [],
  progress: 0,
  budget: r[6] ?? 0,
  updatedAt: '',
  ...(r[7] ? { refTaskId: r[7] } : {}),
});

/** 三阶段分组：策划 → 宣传 → 现场执行（需真人） */
const DEMO_PLAN_STAGES: RunBoard['stages'] = [
  { name: '阶段一：策划', nodes: DEMO_NODES.slice(0, 2).map(toDemoNode) },
  { name: '阶段二：宣传', nodes: DEMO_NODES.slice(2, 5).map(toDemoNode) },
  { name: '阶段三：现场执行（需真人）', nodes: DEMO_NODES.slice(5).map(toDemoNode) },
];

/** 阶段图标：按顺序轮换，避免三个阶段长成一个样 */
const STAGE_ICONS = ['qz-i-sparkle', 'qz-i-photo', 'qz-i-station'];

/** `wx.showActionSheet` 一次最多 6 项，其中 1 项留给「更多分类」 */
const CATEGORY_PAGE = 5;

/**
 * 节点状态 → 图标 / 色调 / 动作文案（三件事同源：都由"这个节点到哪一步"决定）。
 *
 * 做成一张表而不是三个 if 链：以前这三处各写一遍状态判断，改一个状态要同时改三处，
 * 漏改的表现是"胶囊写着「去发布」、点下去却提示已经处理过"—— 不报错，只是像坏了。
 * 表外取值（pending / skipped / canceled）由 `lookOf` 按节点类型兜底。
 */
const LOOK: Record<string, [string, string, string]> = {
  failed: ['qz-i-close', 'fail', '重试'],
  succeeded: ['qz-i-check', 'ok', '查看'],
  running: ['qz-i-sparkle', 'run', '查看'],
  awaiting_hitl: ['qz-i-bell', 'confirm', '确认'],
  awaiting_human: ['qz-i-bell', 'confirm', '去发布'],
  published: ['qz-i-station', 'human', '看任务'],
  assigned: ['qz-i-station', 'human', '看任务'],
  delivered: ['qz-i-station', 'human', '看任务'],
  accepted: ['qz-i-station', 'human', '看任务'],
};

/** 表外状态：真人节点给驿站图标，hitl 给"等你拍板"，其余按等待前置处理 */
function lookOf(node: PlanNode): [string, string, string] {
  const hit = LOOK[node.status];
  if (hit) return hit;
  if (node.type === 'human') return ['qz-i-station', 'human', '等待中'];
  if (node.type === 'hitl') return ['qz-i-check', 'wait', '等待拍板'];
  return ['qz-i-clock', 'wait', '查看'];
}

/**
 * 后端节点 → 渲染用节点。
 *
 * `type` 过白名单（表外值一律判成 ai，与 utils/os.ts 同一取舍：判成 human 却凭空
 * 多出一个"需真人"的发布入口更糟）；图标 / 文案 / 色调在这里全部算好 —— WXML 不能调函数。
 */
function toNodeView(n: OsRunNode): NodeView {
  const type = toPlanNodeType(n.type);
  const node: PlanNode = {
    nodeId: n.nodeId,
    name: n.name,
    type,
    status: n.status,
    actorLabel: n.actorLabel,
    detail: n.detail,
    // 预算 0 =「面议」，不是"有 0 元预算"，所以不下发也不显示（红线：金额不编造）
    ...(n.budget ? { budget: n.budget } : {}),
    ...(n.refTaskId ? { refTaskId: n.refTaskId } : {}),
  };
  const [iconClass, toneClass, actionText] = lookOf(node);
  const refText = n.refTaskId ? `需求 ${n.refTaskId.slice(-6)}` : '';
  return { ...node, iconClass, actionText, toneClass, refText };
}

Page({
  data: {
    runId: '',
    goal: '',
    stages: [] as StageView[],
    allStages: [] as StageView[],
    filters: FILTERS,
    activeFilter: 'all',
    progress: { done: 0, total: 0, percent: 0 },
    loading: true,
    /**
     * 当前展示的是**演示数据**（`/os/runs/:id` 请求失败，走了兜底）。
     *
     * 红线 10：Mock 必须显式可辨，不得冒充功能。页面据此挂「演示数据」角标，
     * 并且**不允许在演示数据上做节点写操作**（那些节点 id 后端根本不存在）。
     */
    demo: false,
    /**
     * 真实计划加载失败的说明：只打「演示数据」角标还不够 ——
     * 用户看不到"为什么会退成演示数据"，就会以为平台真的编排了这 8 个节点。
     */
    planError: '',
    /** 服务分类（真人节点发布时挑）；来自 `GET /station/categories` */
    categories: [] as ToolCategoryItem[],
    /** 装饰层视差位移（由 utils/fx.ts 写入） */
    fxStyle: '',
  },

  onLoad(query: Record<string, string>) {
    // setData 会同步更新 this.data，所以下一行就能读到 runId（不必再存一份局部变量）
    this.setData({ runId: query.runId || '' });
    void this.loadPlan(this.data.runId);
    void this.loadCategories();
  },

  onShow() {
    // 真机上开启陀螺仪倾斜视差；开发者工具无传感器时会静默跳过
    fxEnableTilt(this);
  },

  onHide() {
    fxDisableTilt();
  },

  onUnload() {
    fxDisableTilt();
  },

  async loadPlan(runId: string) {
    try {
      this.applyRun(await osApi.run(runId));
      this.setData({ loading: false, demo: false, planError: '' });
    } catch (e) {
      /**
       * 拉不到真实计划时用演示计划兜底（保证看板可预览）。
       *
       * ⚠️ **必须同时置 `demo: true`** —— 红线 10 要求"Mock 不得冒充功能"。
       * 若不打标记，用户会把「摄影摄像 · 已发布 · 3人报名」当成真实编排结果。
       *
       * 还要把**失败原因**写进 `planError`（筛选区下方的错误条），
       * 否则用户只看到"演示数据"却不知道是"真实数据加载失败"退下来的。
       * 这条约束由 `npm run audit:mp` 静态守卫（DEMO_* 常量必须引用演示标记）。
       */
      this.applyRun(this.buildDemoRun());
      this.setData({
        loading: false,
        demo: true,
        planError: `${(e as Error).message || '计划数据加载失败'} · 已退回演示数据`,
      });
    }
  },

  /**
   * 服务分类（发布真人节点时要用）。
   *
   * 拉不到就**留空**，界面上表现为「去驿站发布页手动填」的兜底入口 ——
   * 不内置第二份分类拷贝（那份必然与 `seed.ts` 漂移）。
   */
  async loadCategories() {
    this.setData({ categories: await stationApi.categories().catch(() => []) });
  },

  /** 错误条的「重试」：重新拉一次真实计划（成功后角标与错误条自动消失） */
  onRetry() {
    this.setData({ loading: true, planError: '' });
    void this.loadPlan(this.data.runId);
  },

  applyRun(run: RunBoard) {
    const stages = (run.stages ?? []).map((s, i) => ({
      name: s.name,
      iconClass: STAGE_ICONS[i % STAGE_ICONS.length],
      nodes: (s.nodes ?? []).map(toNodeView),
    }));
    const all = stages.flatMap((s) => s.nodes);
    const done = all.filter((n) => n.status === 'succeeded').length;
    const total = all.length;
    const percent = total ? Math.round((done / total) * 100) : 0;
    this.setData({ goal: run.goal, stages, allStages: stages, progress: { done, total, percent } });
  },

  /**
   * 演示用计划（结构真实，数据是假的）。
   *
   * ⚠️ 调用方**必须**同时置 `demo: true`，否则就是"用假数据冒充功能"（红线 10）。
   */
  buildDemoRun(): RunBoard {
    return { goal: '举办 200 人创新创业活动，预算 3000 元', stages: DEMO_PLAN_STAGES };
  },

  /** 筛选：命中谓词的节点留下，整段没有节点就不显示这个阶段 */
  onFilterTap(e: WechatMiniprogram.TouchEvent) {
    const key = e.currentTarget.dataset.key as string;
    const keep = NODE_FILTERS[key];
    const stages = keep
      ? this.data.allStages
          .map((s) => ({ ...s, nodes: s.nodes.filter(keep) }))
          .filter((s) => s.nodes.length > 0)
      : this.data.allStages;
    this.setData({ activeFilter: key, stages });
  },

  /**
   * 节点操作：确认 / 去发布 / 看任务 / 重试。
   * 分支都落在真接口上，跑不通的那两类（重试、终止）如实告知。
   *
   * 节点由 nodeId 从 allStages 里找回（WXML 只带这一个 data）—— 同一节点的
   * 状态/名称若在 dataset 里再存一份，确认成功后就会出现"界面已更新、点击还带着旧状态"。
   */
  onNodeAction(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.nodeid as string;
    const node = this.data.allStages.flatMap((s) => s.nodes).find((n) => n.nodeId === id);
    if (!node) return;
    /**
     * ⚠️ 失败节点以前弹一句「已重新排队执行」且**没调任何接口**。
     * 后端只有 confirm / publish 两条节点写路由，没有 retry，所以保持如实告知；
     * 失败原因由 `detail` 透出（服务端已把 `node.error` 写进 detail）。
     */
    if (node.status === 'failed') {
      showNotReady('节点重试', `${node.detail} · 编排引擎尚未开放重试接口，无法真正重新排队。`);
      return;
    }
    if (node.type === 'hitl') {
      if (node.status !== 'awaiting_hitl') {
        wx.showToast({ title: '这一步已经处理过了', icon: 'none' });
        return;
      }
      void this.confirmHitl(node);
      return;
    }
    if (node.type === 'human') {
      this.openHumanNode(node);
      return;
    }
    wx.showToast({ title: 'AI 节点的产物在完成后可查看', icon: 'none' });
  },

  /** HITL 节点确认：`awaiting_hitl → running`，成功后用后端回的新看板整体重渲染 */
  async confirmHitl(node: PlanNode) {
    if (this.rejectDemo()) return;
    wx.showModal({
      title: `确认「${node.name}」`,
      content: '这一步由你拍板。确认后节点进入执行，计划继续往下走。',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          this.applyRun(await osApi.confirmNode(this.data.runId, node.nodeId, 'approve'));
          wx.showToast({ title: '已确认，继续执行', icon: 'success' });
        } catch (e) {
          toastError(e);
        }
      },
    });
  },

  /** 真人节点：待发布的挑分类直接发到驿站，已发布的跳它对应的需求详情 */
  openHumanNode(node: PlanNode) {
    if (this.rejectDemo()) return;
    if (node.status === 'awaiting_human') {
      this.pickCategory(node, 0);
      return;
    }
    if (!node.refTaskId) {
      // 还没轮到它（前置节点未跑完 / 没有真实需求可跳），不把用户带到一个空详情页
      wx.showToast({ title: '这个环节还没开始，先等前置节点', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `/pkg-station/task/index?id=${node.refTaskId}` });
  },

  /**
   * 挑服务分类。
   *
   * `categoryId` 是后端必填项（分类决定"谁能看到这条需求"，服务端不肯兜默认值），
   * 而 `wx.showActionSheet` 一次最多 6 项，所以超出 5 个就翻页。
   * 一个分类都没拉到（接口挂了）时不猜 —— 直接送用户去发布页手填。
   */
  pickCategory(node: PlanNode, offset: number) {
    const all = this.data.categories;
    // 分类接口挂了：categoryId 后端必填，宁可不猜 —— 送用户去发布页自己挑（那条路是真的）
    if (!all.length) {
      const title = encodeURIComponent(node.name);
      wx.navigateTo({ url: `/pkg-station/publish/index?title=${title}&source=os_plan` });
      return;
    }
    const page = all.slice(offset, offset + CATEGORY_PAGE);
    const more = all.length > offset + page.length;
    wx.showActionSheet({
      itemList: [...page.map((c) => c.name), ...(more ? ['更多分类 ›'] : [])],
      success: (res) => {
        if (more && res.tapIndex === page.length) {
          this.pickCategory(node, offset + CATEGORY_PAGE);
          return;
        }
        const cat = page[res.tapIndex];
        if (cat) void this.publishNode(node, cat);
      },
    });
  },

  /** 一键发布到驿站：成功后节点带上后端回写的 refTaskId，可直接跳任务详情 */
  async publishNode(node: PlanNode, cat: ToolCategoryItem) {
    try {
      const res = await osApi.publishNode(this.data.runId, node.nodeId, { categoryId: cat.id });
      this.applyRun(res.run);
      wx.showToast({ title: `已发布：${res.task.taskNo}`, icon: 'none' });
    } catch (e) {
      toastError(e);
    }
  },

  /** 演示数据下拒绝写操作：那些节点 id 在后端不存在，调了只会拿到一个莫名的报错 */
  rejectDemo(): boolean {
    if (!this.data.demo) return false;
    wx.showToast({ title: '演示数据不支持操作', icon: 'none' });
    return true;
  },

  /** 结束动作：交付包 / 追问 / 终止 */
  onPackage() {
    wx.navigateTo({ url: `/pkg-os/result/index?runId=${this.data.runId}` });
  },

  /**
   * 继续追问：回到 AI 页接着聊。
   *
   * ⚠️ 以前一律 `navigateBack` —— 从分享卡 / 深链**直接**进入本页时，
   * 页面栈只有 1 层，返回会退到未知页（表现为"点了没反应"或退出小程序）。
   */
  onAskMore() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }
    openOs(this.data.goal ? `继续刚才的计划：${this.data.goal}` : undefined);
  },

  /**
   * 终止计划。
   *
   * ⚠️ 后端**没有** terminate 路由（`os.controller.ts` 的 runs 系列只有
   * `GET /runs/:id`、`confirm`、`nodes/:nodeId/confirm`、`nodes/:nodeId/publish`），
   * 所以这里确认后只能如实告知，不做任何"看起来成功了"的动作。
   */
  onTerminate() {
    wx.showModal({
      title: '终止计划',
      content: '已完成的节点产物会保留，未开始的节点将不再执行。确定终止吗？',
      success: (res) => {
        if (!res.confirm) return;
        showNotReady('终止计划', '编排引擎尚未开放终止接口，现在点击不会停掉任何真实节点。');
      },
    });
  },

  /* ---------- 指针视差（装饰层动，内容不动） ---------- */
  onFxStart(e: WechatMiniprogram.TouchEvent) {
    fxStart(this, e);
  },
  onFxMove(e: WechatMiniprogram.TouchEvent) {
    fxMove(this, e);
  },
  onFxEnd() {
    fxEnd(this);
  },

  onPullDownRefresh() {
    void this.loadPlan(this.data.runId).finally(() => wx.stopPullDownRefresh());
  },
});
