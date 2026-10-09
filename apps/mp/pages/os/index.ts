/**
 * 青智 OS 会话页（文档 5.3.2）
 *
 * 覆盖：
 *  - 带指令进入时预填并自动发送（首页搜索框/快捷指令/悬浮球、工具箱智能搜索、
 *    结果页"用 AI 修改"与"生成会议纪要"共 6 个入口）
 *  - 意图识别：**后端大模型优先**，失败才退回本地关键词规则（`utils/os.ts`）
 *  - 复合意图 → 计划卡（节点来自模型的真实拆解，不伪造"已完成"）
 *  - 工具路由：按意图给出已上线工具的直达按钮
 *
 * ⚠️ 本页是 **tabBar 页**：其他页面只能用 `wx.switchTab` 跳进来，而它**不能带 query**。
 *    所以入口参数经 `utils/nav.ts` 落本地存储，本页在 `onShow` 里取走。
 *
 * 类型与纯逻辑（意图映射、离线兜底、计划卡构建）在 `utils/os.ts` ——
 * 本文件已贴着 300 行上限，只保留渲染与事件。
 */
import { osApi } from '../../utils/api';
import {
  formatBytes,
  pickFile,
  uploadFile,
  type PickKind,
  type PickedFile,
} from '../../utils/file-transfer';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { takePendingQuery } from '../../utils/nav';
import {
  GUIDE_CARDS,
  INTENT_TOOL_MAP,
  buildHelloMessage,
  buildPlanFromNodes,
  buildPlanFromSubtasks,
  cardTarget,
  intentFallbackText,
  localIntent,
  toCardView,
  toPlanNodeType,
  withDeadline,
  type ChatMessage,
  type OsIntent,
  type OsPlanNode,
  type OsToolCard,
  type PlanCard,
  type ReplyPayload,
} from '../../utils/os';
import { toastError } from '../../utils/request';

/** 会话初始化（模块级缓存：onLoad 建立、onShow 复用，避免重复建会话） */
let sessionReady: Promise<void> | null = null;

/**
 * 意图识别的等待上限（毫秒）。
 *
 * 意图只决定"挂哪个工具按钮"，不是用户真正要看的东西 ——
 * 所以给它一个上限，超时就退回本地关键词规则。
 * 实测后端主模型过载降级时，意图识别可以拖到 30s+，而正文几秒就回来了；
 * 没有这个上限，用户会被一个"锦上添花"的请求卡住。
 */
const INTENT_WAIT_MS = 8000;

/**
 * 对话**正文**的等待上限。
 *
 * ⚠️ 为什么正文也要上限：主模型（实测 `deepseek-ai/DeepSeek-V4-Flash`）延迟长尾很长 ——
 * 同一条对话实测 1.5s / 4.2s / 23.5s / 27.8s，最长到过 **65s**。
 * 没有上限时用户只能对着转圈干等，这正是最初"青小智转圈很久"的体验。
 *
 * ⭐ **超时不是放弃**：请求仍在后台跑，真回复到了会把气泡内容补上（见 `onSend`）——
 * 所以既不用干等，也**不会丢信息**。这比"超时就报错"或"超时就给个可能被推翻的答案"都好。
 */
const REPLY_WAIT_MS = 15000;

/**
 * 任务规划（`plan` 档 / 深度思考）的等待上限。
 *
 * ⚠️ 它**不阻塞用户**：计划卡先由意图识别给的子任务渲染出来（`degraded: true`），
 * 规划结果回来了再**原地升级**成带依赖的 DAG（见 `upgradePlan`）。
 * 超时就保持子任务清单，不报错、不打扰 —— 用户手上已经有一份可用的清单了。
 *
 * 比意图识别的上限宽松：规划要产出 12 个节点 × 依赖关系的 JSON，
 * 且是推理型任务，给太紧只会拿到一堆降级。
 */
const PLAN_WAIT_MS = 12000;

/**
 * 正文等待超时时的**占位**文案。
 *
 * 刻意只说"还在生成"，不先给一个可能被推翻的答案 ——
 * 否则用户会看到一句话、十几秒后它自己变了，比转圈更让人困惑。
 */
const REPLY_PENDING_TEXT = '正在生成回复，模型响应较慢，请稍候…';

Page({
  data: {
    sessionId: '',
    messages: [] as ChatMessage[],
    input: '',
    sending: false,
    guideCards: GUIDE_CARDS,
    scrollIntoView: '',
    backendReady: true,
    fxStyle: '',
    /**
     * 当前对话里**已上传**的文件 id。
     *
     * 为什么要攒着：用户先传了一张图、再说"帮我抠图"时，后端要知道那张图是哪张。
     * 传过去之后，助手就能在对话里**直接执行**，而不是只能回一句"请先上传"——
     * 后者虽然也不算错，但用户刚刚才传过，再被要求传一次是明显的体验断裂。
     */
    sessionFileIds: [] as string[],
  },

  onLoad() {
    sessionReady = this.initSession();
  },

  /**
   * 每次显示都检查有没有"待处理指令"。
   * 放在 `onShow` 而非 `onLoad`：tabBar 页来回切换**不会**重新 onLoad，
   * 而入口可能来自任意其他 tab。`takePendingQuery()` 取走即清空，不会重复触发。
   */
  async onShow() {
    fxEnableTilt(this);
    const q = takePendingQuery();
    if (!q) return;
    await sessionReady; // 等会话就绪再发，避免消息落进还没建立的会话
    this.setData({ input: q });
    await this.onSend();
  },

  onHide() {
    fxDisableTilt();
  },

  onUnload() {
    fxDisableTilt();
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

  /** 建立会话；后端不可用时降级为本地会话（演示不中断） */
  async initSession() {
    let sessionId = `local_${Date.now()}`;
    let backendReady = false;

    try {
      const s = await osApi.createSession('青智 OS');
      sessionId = s.id;
      backendReady = true;
    } catch {
      // 降级：本地会话
    }

    this.setData({ sessionId, backendReady });
    this.pushMessage(buildHelloMessage(backendReady));
  },

  pushMessage(msg: ChatMessage) {
    this.setData({
      messages: [...this.data.messages, msg],
      scrollIntoView: `msg_${msg.id}`,
    });
  },

  onInput(e: WechatMiniprogram.Input) {
    this.setData({ input: e.detail.value });
  },

  /**
   * 快捷栏：选文件 / 相册 / 拍照 → **真实上传** → 记一条消息。
   *
   * 上传链路（presign → 直传 → confirm）后端早已就绪，缺的只是客户端这一侧。
   * 所以这里不做"已选择 N 个文件（上传待接入）"那种假反馈 ——
   * 要么真的传上去，要么如实报错。
   *
   * 三个按钮共用本方法，靠 `data-kind` 区分入口（见 wxml 的 quick-bar）。
   */
  async onQuickPick(e: WechatMiniprogram.TouchEvent) {
    const kind = e.currentTarget.dataset.kind as PickKind;

    let picked: PickedFile | null;
    try {
      picked = await pickFile(kind);
    } catch (err) {
      toastError(err);
      return;
    }
    if (!picked) return; // 用户取消，不打扰

    wx.showLoading({ title: '上传中…', mask: true });
    try {
      const file = await uploadFile(picked);
      // 记下文件 id：接下来的那句"帮我抠图/压缩"才能真的作用在这张图上
      this.setData({ sessionFileIds: [...this.data.sessionFileIds, file.id].slice(-9) });
      this.pushMessage({
        id: `f_${Date.now()}`,
        role: 'user',
        kind: 'file',
        content: `已上传文件：${file.name}（${formatBytes(file.size)}）`,
        createdAt: new Date().toISOString(),
      });
      wx.showToast({ title: '上传成功，可继续补充需求', icon: 'none' });
    } catch (err) {
      toastError(err);
    } finally {
      wx.hideLoading();
    }
  },

  /** 我的文件：分包页（非 tabBar），可直接 navigateTo */
  onQuickFiles() {
    wx.navigateTo({ url: '/pkg-toolbox/files/index' });
  },

  /**
   * 发送消息。
   *
   * 两件事**并行**发起（互不依赖，串行只是白等）：
   *   · `intent` —— 结构化理解，决定挂哪个工具按钮 / 是否出计划卡；
   *   · `send`   —— 真实模型回复的正文。
   * 任一失败都退化为本地兜底，保证"断网 / 后端没起"时 AI 页仍然可用。
   *
   * ⚠️ 意图识别**有等待上限**：它只用来决定"挂哪个按钮"，
   * 不值得让用户为它多等 —— 后端主模型过载触发降级时，意图可能拖到几十秒，
   * 而正文早就回来了。超时就先用本地规则出结果（见 `INTENT_WAIT_MS`）。
   *
   * ⚠️ 正文同样有上限（`REPLY_WAIT_MS`）。两者并行、上限同时起算，
   * 所以用户实际等待 ≈ max(8s, 15s) = 15s，不是两者相加。
   * 正文超时**不丢信息**：先出一个"正在生成"的占位气泡，真回复到了原地补上；
   * 若最终失败，再换成按意图的兜底文案。
   */
  async onSend() {
    const content = this.data.input.trim();
    if (!content || this.data.sending) return;

    this.setData({ sending: true, input: '' });
    this.pushMessage({
      id: `u_${Date.now()}`,
      role: 'user',
      kind: 'text',
      content,
      createdAt: new Date().toISOString(),
    });

    // 两件事**并行**发起（互不依赖，串行只是白等），各自带等待上限。
    // ⚠️ 两个上限都从**发起时刻**算起（在同一处构造），所以用户实际等待
    //    ≈ max(8s, 15s) = 15s，而不是 8s + 15s = 23s。
    const replyPromise = this.sendToBackend(content);
    const [intentRaw, reply] = await Promise.all([
      withDeadline(osApi.intent(content), INTENT_WAIT_MS),
      withDeadline(replyPromise, REPLY_WAIT_MS),
    ]);

    const intent: OsIntent = (intentRaw as OsIntent | null) ?? localIntent(content);
    const msgId = this.renderReply(intent, reply?.text ?? '', reply === null, reply?.cards ?? []);
    this.setData({ sending: false });

    // 复合意图：卡片已用子任务清单顶上，再让 `plan` 档补上真实的依赖关系
    if (intent.isComposite && intent.subtasks?.length) {
      void this.upgradePlan(msgId, content);
    }

    if (reply !== null) return;

    // 超时了：等真回复到了再补上（成功 → 真实正文；失败 → 按意图的兜底文案）
    // ⚠️ 结果卡也要一起补：PPT / 视频这类长任务很可能晚于 15s 才回来，
    //    只补文字不补卡，用户会看到"已经做好了"却没有任何入口 —— 比不回答更让人困惑。
    void replyPromise.then((late) => {
      this.replaceMessage(msgId, late?.text || intentFallbackText(intent));
      if (late?.cards?.length) this.replaceCards(msgId, late.cards);
    });
  },

  /**
   * 走后端真实模型取回复正文（与结果卡）。
   *
   * 失败返回 `null`（由调用方决定兜底文案）—— 注意**不能返回空对象**：
   * 那会被当成"后端答了，只是内容是空的"，于是兜底文案不会生效、用户看到空气泡。
   */
  async sendToBackend(content: string): Promise<ReplyPayload | null> {
    const sessionId = this.data.sessionId;
    // 后端不可用时 initSession 会退化成 `local_` 前缀的本地会话，此时不必白跑一次请求
    if (!sessionId || sessionId.startsWith('local_')) return null;
    try {
      const res = await osApi.send(sessionId, content, this.data.sessionFileIds);
      return { text: res.reply?.content?.trim() ?? '', cards: res.reply?.cards ?? [] };
    } catch {
      return null;
    }
  },

  /**
   * 渲染回复：**模型负责"说话"，后端负责"给入口"，本地负责"兜底"**。
   *
   * 正文来自大模型；结果卡来自后端（AI 能力真的执行过才会有）；
   * 按钮来自 `INTENT_TOOL_MAP`（本地映射表，只在后端不可用时用得上）。
   * 不把"挂哪个工具按钮"也交给模型，是因为按钮只是路由，
   * 本地表既准确又零延迟，而模型有挑到"尚未上线工具"的风险。
   *
   * @param pending 正文还没到（等待超时）。出占位文案，等真回复到了
   *                由 `replaceMessage` 原地补上 —— 见 `REPLY_WAIT_MS`
   * @returns 这条消息的 id（调用方靠它"原地补内容"）
   */
  renderReply(
    intent: OsIntent,
    replyText: string,
    pending = false,
    cards: OsToolCard[] = [],
  ): string {
    // 已经有结果卡时就不再挂"建议入口"按钮了：卡本身就是入口，
    // 再挂一个工具按钮会让用户面对两个都能点的东西、不知道该点哪个
    const action = cards.length ? undefined : INTENT_TOOL_MAP[intent.intent];
    const content = pending ? REPLY_PENDING_TEXT : replyText || intentFallbackText(intent);

    if (intent.isComposite && intent.subtasks?.length) {
      const id = `plan_${Date.now()}`;
      this.pushMessage({
        id,
        role: 'assistant',
        agentName: 'coordinator',
        kind: 'card',
        content,
        plan: buildPlanFromSubtasks(intent.subtasks),
        buttons: action ? [action] : undefined,
        createdAt: new Date().toISOString(),
      });
      return id;
    }

    const id = `a_${Date.now()}`;
    this.pushMessage({
      id,
      role: 'assistant',
      agentName: 'coordinator',
      kind: action ? 'buttons' : 'text',
      content,
      ...(action ? { buttons: [action] } : {}),
      ...(cards.length ? { cards: cards.map(toCardView) } : {}),
      createdAt: new Date().toISOString(),
    });
    return id;
  },

  /**
   * 原地替换某条助手消息的正文（"超时占位 → 真回复到了"）。
   *
   * 只改 `content`：按钮与计划卡由**意图**决定，不会变。
   * 用 `messages[i].content` 路径写法，避免整列表重渲染。
   * 消息已被清空（新建会话 / 切走）时静默跳过。
   */
  replaceMessage(id: string, content: string) {
    const idx = this.data.messages.findIndex((m) => m.id === id);
    if (idx === -1) return;
    this.setData({ [`messages[${idx}].content`]: content });
  },

  /**
   * 用 `plan` 档（深度思考）把目标拆成**带依赖关系的 DAG**，回来后原地升级计划卡。
   *
   * 与正文的"占位 → 真回复到了补上"是同一套思路：先用**已知的真实信息**
   *（意图识别给出的子任务）把界面填满，再让更慢但更准的那一路补上，
   * 用户既不用多等，也不会丢信息。
   *
   * 失败 / 超时 / 后端返回 `degraded` 时**什么都不做** —— 卡片已经是可用的清单，
   * 不需要用一个报错去打扰用户。后端那边也已经把降级原因写进日志了。
   *
   * ⭐ **带上 sessionId 才拿得到 runId**（M2-06）：服务端只在这种情况下把这张计划
   * 落成 Run，看板的三条读写路由（`GET /os/runs/:id` 与节点 confirm / publish）
   * 全都以 runId 为入口 —— 不给会话就是"一次性的计划文本"，看板按钮不会出现。
   */
  async upgradePlan(msgId: string, goal: string) {
    const res = await withDeadline(osApi.plan(goal, this.data.sessionId), PLAN_WAIT_MS);
    if (!res || res.degraded || !res.nodes?.length) return;

    // 不信任后端输出：类型逐个过白名单，依赖数组缺了就当空
    const nodes: OsPlanNode[] = res.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      type: toPlanNodeType(n.type),
      dependsOn: Array.isArray(n.dependsOn) ? n.dependsOn : [],
    }));
    // runId 一并挂到这张卡上：计划卡上的「看板 ›」入口据此出现（无 runId 时不显示）
    this.replacePlan(msgId, { ...buildPlanFromNodes(nodes), runId: res.runId ?? '' });
  },

  /**
   * 原地替换某条助手消息的计划卡（"子任务清单 → 带依赖的 DAG"）。
   *
   * 只改 `plan`：正文与工具按钮由**意图**决定，不会变。
   * 消息已被清空（新建会话 / 切走）时静默跳过。
   */
  replacePlan(id: string, plan: PlanCard) {
    const idx = this.data.messages.findIndex((m) => m.id === id);
    if (idx === -1) return;
    this.setData({ [`messages[${idx}].plan`]: plan });
  },

  /**
   * 原地补上结果卡（"正文先到、产物卡后到"）。
   *
   * 为什么会晚到：PPT / 视频这类长任务的执行结果跟在模型回复之后回来，
   * 可能晚于 `REPLY_WAIT_MS` 才拿到。只补正文不补卡，用户会看到
   * "已经做好了，点下面卡片查看" —— 而**下面没有卡片**。那比不回答更糟。
   */
  replaceCards(id: string, cards: OsToolCard[]) {
    const idx = this.data.messages.findIndex((m) => m.id === id);
    if (idx === -1) return;
    this.setData({ [`messages[${idx}].cards`]: cards.map(toCardView) });
  },

  /**
   * 点击结果卡 → 去它该去的地方。
   *
   * 两种形态的落点不同（见 `cardTarget`）：结果卡去结果页看产物/进度，引导卡去执行页选文件。
   * 没有落点时**不跳空页面**，但必须说一声 —— 静默 return 的话用户只会觉得"卡片坏了"。
   */
  onCardTap(e: WechatMiniprogram.TouchEvent) {
    const idx = Number(e.currentTarget.dataset.idx);
    const msgId = e.currentTarget.dataset.msgid as string;
    const card = this.data.messages.find((m) => m.id === msgId)?.cards?.[idx];
    if (!card) return;

    const url = cardTarget(card);
    if (!url) {
      wx.showToast({ title: '该卡片暂无可跳转详情', icon: 'none' });
      return;
    }
    wx.navigateTo({ url });
  },

  /** 点击动作按钮 → 直达工具执行页 */
  onActionTap(e: WechatMiniprogram.TouchEvent) {
    const { tool } = e.currentTarget.dataset as { tool: string };
    if (tool === 'create_task') {
      wx.switchTab({ url: '/pages/station/index' });
      return;
    }
    // 多工具意图（文件处理 / 音视频）没有"唯一正确的那一个工具"，
    // 所以送到工具箱让用户自己挑，而不是替他猜一个
    if (tool === 'toolbox') {
      wx.switchTab({ url: '/pages/toolbox/index' });
      return;
    }
    wx.navigateTo({ url: `/pkg-toolbox/run/index?toolName=${tool}` });
  },

  /** HITL：一键发布全部人力节点 */
  /**
   * 批量发布人力节点到驿站。
   *
   * ⚠️ **这里以前是"假成功"**：只弹了个"已发布 N 个任务到驿站"的提示、
   * 把计划卡标成已发布，**却从没调用任何接口** —— 用户以为任务发出去了，
   * 实际什么都没发生（违反红线 9）。
   *
   * 批量发布接口尚未实现，所以现在做**真实能做的事**：
   * 把用户带到驿站发布页（那条路径是真的），并如实说明需要逐个发布。
   */
  onPublishAll(e: WechatMiniprogram.TouchEvent) {
    const msgId = e.currentTarget.dataset.msgid as string;
    const plan = this.data.messages.find((m) => m.id === msgId)?.plan;
    const count = plan?.needHumanCount ?? 0;
    if (!count) return;

    this.pushMessage({
      id: `t_${Date.now()}`,
      role: 'assistant',
      kind: 'text',
      content:
        `有 ${count} 项需要真人完成。批量发布还没上线，我先带你去驿站发布页，` +
        `逐条发布即可（也可以点计划里每一项后面的「发布」）。`,
      createdAt: new Date().toISOString(),
    });
    wx.navigateTo({ url: '/pkg-station/publish/index?source=os_plan' });
  },

  onLater(e: WechatMiniprogram.TouchEvent) {
    const msgId = e.currentTarget.dataset.msgid as string;
    this.setData({
      messages: this.data.messages.map((m) =>
        m.id === msgId ? { ...m, content: '好的，需要发布时随时点「去驿站发布」。' } : m,
      ),
    });
  },

  /** 单个节点发布 → 驿站发布页（预填） */
  onPublishNode(e: WechatMiniprogram.TouchEvent) {
    const { name, budget } = e.currentTarget.dataset as { name: string; budget?: number };
    const b = budget ?? 0;
    wx.navigateTo({
      url: `/pkg-station/publish/index?title=${encodeURIComponent(name)}&budget=${b}&source=os_plan`,
    });
  },

  onGuideTap(e: WechatMiniprogram.TouchEvent) {
    this.setData({ input: e.currentTarget.dataset.text as string });
    void this.onSend();
  },

  onViewPlan(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pkg-os/plan/index?runId=${e.currentTarget.dataset.runid}` });
  },

  /** 历史记录：只读回看的独立分包页（非 tabBar 页，可直接 navigateTo） */
  onOpenHistory() {
    wx.navigateTo({ url: '/pkg-os/history/index' });
  },

  onNewSession() {
    // 会话换了，之前上传的文件不再属于新会话 —— 不清掉会让下一轮的
    // "帮我抠图"作用在上一个会话的图上（用户完全不知道自己在处理哪张图）
    this.setData({ messages: [], sessionId: '', sessionFileIds: [] });
    void this.initSession();
  },

  onShareAppMessage() {
    return { title: '青智 OS · 一句话完成复杂任务', path: '/pages/os/index' };
  },
});
