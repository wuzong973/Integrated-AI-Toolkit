/**
 * API 封装（按域划分，与后端 9.2 接口清单一一对应）
 * 纪律：页面只调用此处方法，不直接拼 URL。
 */
import { http } from './request';
import { API_BASE, API_PREFIX } from './env';
import type {
  AdminListResult,
  AdminOrderItem,
  AdminOrderQuery,
  AdminReviewBody,
  AdminStats,
  AdminUserItem,
  AdminUserQuery,
  AdminVerificationItem,
  AdminVerificationQuery,
  ApplicationItem,
  FileItem,
  HealthInfo,
  JobItem,
  LoginResult,
  MatchedProvider,
  MeInfo,
  OrderItem,
  OsMessageItem,
  OsRunView,
  OsSessionItem,
  PresignResult,
  ProfileUpdatePayload,
  ProviderProfile,
  PublicConfig,
  PracticeAudioResult,
  PracticeCardsResult,
  PracticeModule,
  PracticeModulesResult,
  PracticeSubmitResult,
  PracticeTodayResult,
  ReviewItem,
  ServiceItem,
  TaskItem,
  ToolCategoryItem,
  ToolItem,
  UploadScene,
  VocabAnswerResult,
  VocabAudioResult,
  VocabBookItem,
  VocabStatsResult,
  VocabTodayResult,
  WithdrawalItem,
} from './api-types';
import type { OsToolCard } from './os';

/**
 * 类型声明统一放在 `./api-types`。
 *
 * 本文件只保留**调用表** —— `audit:api` 靠解析它来核对
 * "客户端调的每个接口后端是否注册"，被类型声明撑到 300 行上限是本末倒置。
 * 这里原样转出，页面继续 `from '../../utils/api'` 导入即可，调用方无需改动。
 *
 * 唯一的例外是消息域（M3-19）：类型与调用一起放在 `./notification-api`，
 * 因为那片契约要成对读才说得清（见该文件头）。
 */
export * from './api-types';

// ---------- 健康检查 ----------
export const healthApi = {
  check: () => http.get<HealthInfo>('/health', { auth: false, loading: false }),
};

// ---------- 公开配置 ----------
/**
 * 公开配置（未登录可访问）。
 * 当前主要是**计费模式**：决定价格位置显示"5 积分"还是"限时免费"。
 * 界面不要自己去猜模式，统一走 `utils/billing.ts` 的缓存读取。
 */
export const configApi = {
  public: () => http.get<PublicConfig>('/config/public', { auth: false, loading: false }),
};

// ---------- 认证 ----------
export const authApi = {
  login: (code: string) =>
    http.post<LoginResult>('/auth/login', { code }, { auth: false, loading: false }),
  me: () => http.get<MeInfo>('/auth/me', { loading: false }),
  refresh: (refreshToken: string) =>
    http.post<LoginResult>('/auth/refresh', { refreshToken }, { auth: false, loading: false }),
};

// ---------- 用户 ----------
export const userApi = {
  /** PATCH 语义：只发改动过的字段，见 `ProfileUpdatePayload` */
  updateProfile: (data: ProfileUpdatePayload) => http.put<MeInfo>('/user/me', data),
  roles: () =>
    http.get<{ role: string; scope: string; status: string }[]>('/user/roles', { loading: false }),
  credit: () => http.get<{ score: number; logs: unknown[] }>('/user/credit', { loading: false }),
  points: () => http.get<{ points: number; logs: unknown[] }>('/user/points', { loading: false }),
  wallet: () =>
    http.get<{
      balance: number;
      frozen: number;
      totalIncome: number;
      points: number;
      ledger: unknown[];
    }>('/user/wallet', { loading: false }),
};

// ---------- 工具箱 ----------
export const toolboxApi = {
  categories: () =>
    http.get<ToolCategoryItem[]>('/tools/categories', { auth: false, loading: false }),
  list: (params?: { categoryId?: string; keyword?: string }) =>
    http.get<ToolItem[]>('/tools', { auth: false, loading: false, params }),
  detail: (name: string) =>
    http.get<ToolItem & { inputSchema?: unknown }>(`/tools/${name}`, { auth: false }),
  invoke: (
    name: string,
    params: Record<string, unknown>,
    fileIds: string[] = [],
    copyrightAck = false,
  ) =>
    http.post<{ jobId: string; status: string; result?: unknown }>(`/tools/${name}/invoke`, {
      params,
      fileIds,
      copyrightAck,
      async: true,
    }),
  job: (jobId: string) => http.get<JobItem>(`/jobs/${jobId}`, { loading: false }),
  jobs: () => http.get<JobItem[]>('/jobs', { loading: false }),
};

// ---------- 文件 ----------
export const fileApi = {
  list: () => http.get<FileItem[]>('/files', { loading: false }),
  detail: (id: string) => http.get<FileItem>(`/files/${id}`, { loading: false }),
  remove: (id: string) => http.del(`/files/${id}`),
  /** ① 取直传签名（服务端在此校验类型与大小） */
  presign: (data: { filename: string; size: number; contentType: string; scene: UploadScene }) =>
    http.post<PresignResult>('/files/presign', data, { loading: false }),
  /** ③ 确认上传完成，生成文件记录 */
  confirm: (data: { objectKey: string; filename: string; size: number; scene: UploadScene }) =>
    http.post<FileItem>('/files/confirm', data, { loading: false }),
  /** 签发短时效下载地址（归属校验在服务端，拿不到别人的文件） */
  download: (id: string) =>
    http.get<{ url: string; expiresIn: number }>(`/files/${id}/download`, { loading: false }),
};

/**
 * 头像的**永久**公开地址（`GET /files/public/:id` → 302 到签名地址）。
 *
 * ## 为什么由客户端拼而不是用后端返回的 URL
 *
 * 后端签发出来的地址基于 `STORAGE_PUBLIC_BASE_URL`，本地没配时会落到
 * `http://localhost:3000` —— 在开发者工具里能显示，发到真机上就是死链
 * （手机上的 localhost 是手机自己）。而小程序知道自己打的是哪个基址，
 * 由它拼出来的地址天然跟着环境走。
 *
 * ## 为什么存进 `user.avatar` 的是这个地址
 *
 * presign 出来的直链时效是 900 秒，存进去等于"头像 15 分钟后变灰"。
 * 这个地址不变，后端 `FileService.publicAvatarUrl` 只放行 `scene === 'avatar'`。
 */
export function avatarPublicUrl(fileId: string): string {
  return `${API_BASE}${API_PREFIX}/files/public/${fileId}`;
}

// ---------- 驿站 ----------
export const stationApi = {
  categories: () =>
    http.get<ToolCategoryItem[]>('/station/categories', { auth: false, loading: false }),
  /**
   * 任务列表。
   *
   * `role` 是**服务端过滤**的"与我相关"，必须登录：
   *   publisher —— 我发布的；provider —— 我接的单。
   * ⚠️ 不要再用 `status: 'assigned'` 当"我的任务" —— 那会拿到**全站所有已选定任务**，
   * 别人的单会出现在我的工作台上（越权看到他人订单，且从界面上看不出是错的）。
   *
   * ⚠️ 这里**不能写 `auth: false`**（曾经写过，是本项目最隐蔽的一个 bug）：
   * 后端 `GET /station/tasks` 是 `@Public()` + `@CurrentUser() user?`，语义是
   * "**有 token 也解析**" —— 匿名浏览照常，登录用户才会拿到属于自己的
   * `matchScore` / `matchReasons`，且 `role` 过滤才拿得到 `viewerId`。
   * 关掉 token 会把两件事同时打死：① `role=provider` 直接 401「需要先登录」；
   * ② 匹配度永远不下发（`station.service.ts` 在 `!viewerId` 时提前 return），
   * 于是工作台只能自己编一个分数 —— 那正是红线 10 的由来。
   */
  tasks: (params?: {
    categoryId?: string;
    keyword?: string;
    status?: string;
    role?: 'publisher' | 'provider';
  }) =>
    http.get<{ list: TaskItem[]; total: number }>('/station/tasks', {
      loading: false,
      params,
    }),
  /** 任务详情。同样带 token：详情页的匹配度与"我是否发布者"都由服务端判定 */
  task: (id: string) => http.get<TaskItem>(`/station/tasks/${id}`),
  publish: (data: Record<string, unknown>) => http.post<TaskItem>('/station/tasks', data),
  parse: (text: string) => http.post<Record<string, unknown>>('/station/parse', { text }),
  apply: (taskId: string, data: { quote?: number; message?: string }) =>
    http.post(`/station/tasks/${taskId}/apply`, data),
  /** 报名者列表 —— **仅发布者可见**（报名留言含报价，不对其他用户公开） */
  applications: (taskId: string) =>
    http.get<ApplicationItem[]>(`/station/tasks/${taskId}/applications`, { loading: false }),
  /**
   * 选定服务者 —— 服务端会在**同一事务**里把任务置为已选定并生成担保订单，
   * 返回的 `orderId` 可直接进支付流程（不要再让用户"选定完再去下一单"）。
   */
  select: (taskId: string, providerId: string, amount?: number) =>
    http.post<{ taskId: string; orderId: string; orderNo: string; amount: number }>(
      `/station/tasks/${taskId}/select`,
      { providerId, amount },
    ),
  /**
   * 关闭需求（仅发布者、且仅在还没选定服务者时可用）。
   *
   * 用 POST 而不是 PATCH：本项目所有"动作型"接口（deliver / accept / refund）
   * 一律用 POST，且客户端 `http` 也没有暴露 patch —— 加一个只为一条路由存在的方法
   * 不如跟随既有约定。
   */
  close: (taskId: string) => http.post<{ status: string }>(`/station/tasks/${taskId}/close`),
  /**
   * 智能匹配：为这条需求推荐服务者（M3-09）。
   *
   * 用在"还没有人报名"时 —— 让发布者知道这条需求适合谁。
   * 返回的 `score` 是服务端真实算的；**界面必须同时展示 `reasons`**，
   * 否则用户只能看到一个没有来源的百分比。
   */
  match: (taskId: string) =>
    http.get<MatchedProvider[]>('/station/match', { params: { taskId }, loading: false }),
};

// ---------- 订单 ----------
export const orderApi = {
  list: (params?: { role?: 'buyer' | 'provider'; status?: string }) =>
    http.get<{ list: OrderItem[]; total: number }>('/orders', { loading: false, params }),
  detail: (id: string) => http.get<OrderItem>(`/orders/${id}`, { loading: false }),
  create: (data: Record<string, unknown>) => http.post<OrderItem>('/orders', data),
  pay: (id: string) => http.post<Record<string, unknown>>(`/orders/${id}/pay`),
  deliver: (id: string, fileIds: string[], remark?: string) =>
    http.post(`/orders/${id}/deliver`, { fileIds, remark }),
  /**
   * 验收放款（M3-12）+ **同一次提交里带评价**（M3-16）。
   *
   * 第二参可以只给星级数字（老调用方），也可以给完整评价对象
   *（对应后端 `packages/core/src/credit/accept-review.ts` 的 `AcceptReviewSchema`，
   * 它是验收契约 `.extend()` 出来的宽版：`rating` / `content` / `tags` / `isAnonymous`）。
   *
   * ⚠️ 评价**必须**跟着验收一次性提交：后端把放款、评价、信用记分放在同一个事务里，
   * 拆成两个接口就会出现"钱已放出去、评价却没写上"且无回滚通道的半状态。
   * 一个参数都不传 = 只放款不评价（`rating` 后端可选；但只写正文不打分会被服务端拒）。
   */
  accept: (
    id: string,
    review?: number | { rating?: number; content?: string; tags?: string[]; isAnonymous?: boolean },
  ) =>
    http.post(
      `/orders/${id}/accept`,
      typeof review === 'number' ? { rating: review } : (review ?? {}),
    ),
  /** 要求修改（待验收 → 服务中回退，最多 3 次；次数超限服务端返回 40001 带原因） */
  revision: (id: string, reason: string) => http.post(`/orders/${id}/revision`, { reason }),
  refund: (id: string, reason: string) => http.post(`/orders/${id}/refund`, { reason }),
  /** 别人给我的评价（匿名项后端已脱敏） */
  reviewsReceived: () =>
    http.get<{ list: ReviewItem[]; total: number }>('/orders/reviews/received', { loading: false }),
  /** 我给出的评价 */
  reviewsGiven: () =>
    http.get<{ list: ReviewItem[]; total: number }>('/orders/reviews/given', { loading: false }),
};

// ---------- 服务商品市场（M3-04） ----------
export const serviceApi = {
  /** 市场列表：公开，只出上架中的 */
  list: (params?: { categoryId?: string; keyword?: string; page?: number; pageSize?: number }) =>
    http.get<{ list: ServiceItem[]; total: number }>('/services', {
      auth: false,
      loading: false,
      params,
    }),
  /** 我上架的（含已下架），仅本人 */
  mine: () =>
    http.get<{ list: ServiceItem[]; total: number }>('/services/mine', { loading: false }),
  /**
   * 服务详情。
   *
   * ⚠️ 这里**必须带 token**：后端 `GET /services/:id` 是 `@Public()` + 可选 `@CurrentUser()`，
   * 服务端会据此判"下架的商品只有本人打得开"。曾经写成 `auth: false`，
   * 结果是**服务者自己也打不开自己的下架服务**（40401 → 页面显示"该服务已下架"），
   * 而下架是软删除，`mine` 列表当时也无人调用 —— 服务一被下架就再也找不回来了。
   */
  detail: (id: string) => http.get<ServiceItem>(`/services/${id}`),
  /** 上架（仅认证服务者；文本服务端送审） */
  create: (data: Record<string, unknown>) => http.post<ServiceItem>('/services', data),
  off: (id: string) => http.post<{ id: string; status: string }>(`/services/${id}/off`),
  on: (id: string) => http.post<{ id: string; status: string }>(`/services/${id}/on`),
};

// ---------- 钱包提现（M3-13） ----------
export const walletApi = {
  /** amount 单位「分」；余额不足/低于起提额由服务端报错，页面如实 toast */
  withdraw: (amount: number) =>
    http.post<{ id: string; status: string; balanceAfter: number }>('/wallet/withdrawals', {
      amount,
    }),
  withdrawals: () =>
    http.get<{ list: WithdrawalItem[]; total: number }>('/wallet/withdrawals', { loading: false }),
};

// ---------- 青智 OS ----------
export const osApi = {
  /**
   * 我的会话列表（历史记录页用）。
   *
   * 后端已按最近活跃 `desc` 排序，并且**只返回有消息的会话** ——
   * 每次进 AI 页都会建一个会话，不过滤的话半年下来列表全是空壳。
   */
  sessions: () => http.get<OsSessionItem[]>('/os/sessions', { loading: false }),
  createSession: (title?: string) => http.post<{ id: string }>('/os/sessions', { title }),
  /** 某一段对话的全部消息（后端按 `createdAt asc`，只读回看用） */
  messages: (sessionId: string) =>
    http.get<OsMessageItem[]>(`/os/sessions/${sessionId}/messages`, { loading: false }),
  /**
   * 发送消息并取回**模型的回复**。
   *
   * `reply.content` 是真实大模型生成的正文（不是罐头文案）——
   * 页面用它作为助手气泡的内容；`messageId` 是回复消息的 id，便于定位/滚动。
   *
   * `reply.cards` 是 AI 能力调用的**结果卡**（有产物时才有）：
   *   · `kind: 'result'` —— 真的执行过了，`jobId` 可进结果页看产物/进度；
   *   · `kind: 'guide'`  —— 没执行（缺文件），`route` 指向执行页；
   *   · `kind: 'files'`  —— 没执行，但名下已有文件，`route` 指向「我的文件」。
   * 三种形态必须分开渲染，把 guide / files 显示成"已完成"就是假成功（红线 9）。
   *
   * 类型直接用 `./os` 的 `OsToolCard`（与后端 `os-tool-card.ts` 同形）——
   * 曾经在这里手写了一份，漏掉了 `files` 这个形态（类型漂移，编译期查不出）。
   *
   * `fileIds` 传当前对话里**已上传**的文件：有了它，"帮我抠图"才能
   * 在对话里直接执行，而不是只能回一张"请先上传"的引导卡。
   */
  send: (sessionId: string, content: string, fileIds: string[] = []) =>
    http.post<{
      messageId: string;
      reply?: {
        id: string;
        role: string;
        kind: string;
        content: string;
        cards?: OsToolCard[];
        createdAt: string;
      };
    }>(`/os/sessions/${sessionId}/messages`, { content, fileIds }),
  /**
   * 意图识别（后端用大模型）。
   *
   * 结构对应 `packages/core/src/validators/index.ts` 的 `OsIntentResult`。
   * 后端可能返回表外取值（已由服务端归一化），但字段仍可能缺失，故全部可选处理。
   */
  intent: (text: string) =>
    http.post<{
      intent: string;
      confidence: number;
      isComposite: boolean;
      entities?: Record<string, string>;
      needsClarification?: boolean;
      questions?: string[];
      subtasks?: { name: string; type: 'ai' | 'human' }[];
    }>('/os/intent', { text }),
  /**
   * 任务规划（后端 `plan` 档 / 深度思考）。
   *
   * 与 `intent` 分开调用：`intent` 只判断"是哪一类事"，`plan` 才把它拆成
   * **带依赖关系的 DAG**。`degraded === true` 表示这次没规划成功，
   * 此时 `nodes` 为空数组，调用方应退回 `intent.subtasks`。
   */
  plan: (goal: string, sessionId?: string) =>
    http.post<{
      goal: string;
      nodes: { id: string; name: string; type: string; dependsOn: string[] }[];
      degraded: boolean;
      degradedReason?: string;
      /** 规划成功且带 sessionId 时后端落库产生；degraded/无会话时缺省 */
      runId?: string;
    }>('/os/plan', { goal, ...(sessionId ? { sessionId } : {}) }),
  run: (runId: string) => http.get<OsRunView>(`/os/runs/${runId}`, { loading: false }),
  confirm: (runId: string) => http.post<OsRunView>(`/os/runs/${runId}/confirm`),
  confirmNode: (runId: string, nodeId: string, decision?: string, note?: string) =>
    http.post<OsRunView>(`/os/runs/${runId}/nodes/${nodeId}/confirm`, {
      ...(decision ? { decision } : {}),
      ...(note ? { note } : {}),
    }),
  publishNode: (runId: string, nodeId: string, params: Record<string, unknown>) =>
    http.post<{ run: OsRunView; task: TaskItem }>(
      `/os/runs/${runId}/nodes/${nodeId}/publish`,
      params,
    ),
};

// ---------- 消息 / 会话 ----------
/**
 * 站内信 `messageApi` 与会话 `conversationApi` 在 `./notification-api` 里
 * （类型 + 调用同文件，按域独立）。此处原样转出，页面继续从 `utils/api` 导入。
 */
export * from './notification-api';
// 地图 / 位置服务：类型与调用一起放在 `./map-api`（理由见该文件头）——
// 与消息域同样的处理，页面照旧 `from '../../utils/api'` 导入即可。
export * from './map-api';

// ---------- 服务者入驻认证（M3-02） ----------
export const providerApi = {
  /** 学校列表（入驻表单的学校选择器，公开接口） */
  schools: () =>
    http.get<{ id: string; name: string; city?: string }[]>('/provider/schools', {
      auth: false,
      loading: false,
    }),
  /** 提交入驻申请 */
  apply: (data: Record<string, unknown>) =>
    http.post<{ verificationId: string; status: string }>('/provider/apply', data),
  /** 我的服务者资料与认证状态 */
  profile: () => http.get<ProviderProfile>('/provider/profile', { loading: false }),
};

// ---------- 记单词 / 四六级词汇训练（M4-15） ----------
export const vocabApi = {
  /** 词书列表（含我的进度）。`status='planned'` 的那几本界面要显示"建设中"且不可选 */
  books: () => http.get<VocabBookItem[]>('/vocab/books', { loading: false }),
  /** 选为当前词书（可顺带改每日目标），返回更新后的列表 —— 选完不必再请求一次 */
  selectBook: (code: string, daily?: { dailyNew?: number; dailyReview?: number }) =>
    http.post<VocabBookItem[]>('/vocab/books/select', { code, ...daily }),
  /**
   * 今日队列（新词 + 到期复习）。
   *
   * 没有词书时后端会 `needsBook: true` 并把 `books` 一并返回，
   * 所以**首页不需要先请求列表**就能一条请求画完整个页面。
   */
  today: () => http.get<VocabTodayResult>('/vocab/today', { loading: false }),
  /**
   * 提交作答。
   *
   * ⚠️ 只传**用户提交的原文**，对错由服务端算 —— 客户端不参与判定。
   * 选择题传 `choice`（选项 key）、拼写/填空传 `text`（用户输入）。
   * 分成两个字段而不是一个 `answer`，是因为服务端要靠**题型**决定读哪个，
   * 而不是靠"这个字符串长不长、像不像 key"来猜（猜错的表现是
   * "拼写题把一个单词当成选项 key 判错"，静默且难查）。
   */
  answer: (wordId: string, payload: { choice?: string; text?: string }) =>
    http.post<VocabAnswerResult>('/vocab/answer', { wordId, ...payload }),
  /** 学习统计（连续天数 / 正确率 / 最近 30 天打卡日历） */
  stats: () => http.get<VocabStatsResult>('/vocab/stats', { loading: false }),
  /**
   * 单词发音。返回 base64（后端统一响应体不能承载二进制流），
   * 由 `utils/vocab-audio.ts` 落成临时文件再交给 `InnerAudioContext` 播放。
   *
   * `loading: false`：点喇叭是高频动作，每次都弹"加载中"会打断背单词的节奏，
   * 页面自己用小喇叭的转动状态表示"正在合成"。
   */
  audio: (wordId: string, voice?: string) =>
    http.get<VocabAudioResult>(`/vocab/words/${wordId}/audio`, {
      params: voice ? { voice } : {},
      loading: false,
    }),
};

// ---------- 练习中心（M4-16：句子 / 口语 / 作文三模块） ----------
/**
 * ## 与词汇模块的两处关键差别
 *
 * ① **题面按模块分开取**：`today` 只给"今天要做哪些、各做多少"，
 *    题面走独立的 `cards`。三种题面的形状差异太大（句子卡 / 句子卡+录音 / 作文题），
 *    合成一个响应会逼客户端对着一堆可空字段判断"我现在到底在做什么题"。
 *
 * ② **选项按模块分流**：同一批句子，`sentence` 模块出的是"连词成句"，
 *    `speak` 模块出的是"看着读" —— 服务端靠 `module` 参数决定下发哪套题面
 *    （以及要不要把 `en` 给出来），客户端**不参与决定**。
 */
export const practiceApi = {
  /**
   * 模块清单（标题 / 说明 / 可用模式）。界面靠它渲染入口，不自己写死一份。
   *
   * ⚠️ 返回的是 `{ modules: [...] }` 而**不是裸数组** —— 请求层只剥外层信封
   * （`data`），不会往里再剥一层。写成 `PracticeModuleItem[]` 会让
   * `res.map(...)` 在运行时炸（`tsc` 查不出来，`.map` 两边都存在）。
   */
  modules: () => http.get<PracticeModulesResult>('/practice/modules', { loading: false }),
  /**
   * 今日总览：三个模块的计划 + 今日计数 + 累计 + 30 天日历。
   * 与 `stats` 返回同一份数据（后端就是同一个方法），单独进入统计页时用后者。
   */
  today: () => http.get<PracticeTodayResult>('/practice/today', { loading: false }),
  stats: () => http.get<PracticeTodayResult>('/practice/stats', { loading: false }),
  /**
   * 某模块的今日题面（**一批**，不是一题一取）。
   *
   * 逐题拉取的单次往返更多，且用户翻回上一题时要重新请求；一批十来题只有几十 KB，
   * 一次给全、界面本地翻页，网络抖一下时用户不会卡在一道题上。
   */
  cards: (module: PracticeModule) =>
    http.get<PracticeCardsResult>('/practice/cards', { params: { module }, loading: false }),
  /**
   * 提交一次练习。**判分与复习调度都在服务端算**，客户端只送原始作答。
   *
   * 分成 `text` / `audioBase64` 两个字段而不是一个 `answer`：
   * 服务端靠**模块**决定读哪个，而不是靠"这个字符串像不像 base64"来猜 ——
   * 猜错的表现是"录音被当成文本判了个 0 分"，静默且难查。
   */
  submit: (payload: {
    refId: string;
    module: PracticeModule;
    text?: string;
    audioBase64?: string;
    audioFormat?: string;
  }) => http.post<PracticeSubmitResult>('/practice/submit', payload),
  /**
   * 句子朗读音频。返回 base64（统一响应体承载不了二进制流），
   * 由 `utils/vocab-audio.ts` 落成临时文件再交给 `InnerAudioContext`。
   *
   * `speed` 只用于**分桶缓存**：上游 TTS 接口只接受音色、不接受语速
   * （见后端 `PracticeAudioService` 的说明），传它不会让音频真的变慢。
   */
  sentenceAudio: (sentenceId: string, speed?: number) =>
    http.get<PracticeAudioResult>(`/practice/sentences/${sentenceId}/audio`, {
      params: speed ? { speed } : {},
      loading: false,
    }),
};

// ---------- 管理后台（M3-20） ----------
/**
 * 小程序内的管理员视图。
 *
 * ## 为什么直接打 `/admin/*` 而不是给小程序单开一套 C 端统计接口
 *
 * 后端 `/admin/*` 的凭据是 `admin_account` 行 + 权限点（`AdminPermissionGuard`
 * 每次请求都回库查），而**不是** JWT 里的 `isAdmin`。同一个微信账号一旦绑定了
 * `admin_account`（`npm run db:grant-admin`），它现有的 Bearer token 就直接能用 ——
 * 再开一套 C 端接口等于把同一份聚合逻辑抄第二遍，抄的那天就开始漂移。
 *
 * ## 权限边界
 *
 * 这里只放"看"和"审核"两类动作，**不放**封号、改余额、管管理员账号 ——
 * 那些留在网页版后台（`apps/admin`）：手机上误触的代价太高，而且小程序也没有
 * 承载复杂表单的空间。入口对用户是隐藏的，但隐藏不是权限（红线在后端）。
 */
export const adminApi = {
  stats: () => http.get<AdminStats>('/admin/dashboard/stats', { loading: false }),
  users: (query?: AdminUserQuery) =>
    http.get<AdminListResult<AdminUserItem>>('/admin/users', { params: query, loading: false }),
  verifications: (query?: AdminVerificationQuery) =>
    http.get<AdminListResult<AdminVerificationItem>>('/admin/content/verifications', {
      params: query,
      loading: false,
    }),
  reviewVerification: (id: string, body: AdminReviewBody) =>
    http.post<AdminVerificationItem>(`/admin/content/verifications/${id}/review`, body),
  orders: (query?: AdminOrderQuery) =>
    http.get<AdminListResult<AdminOrderItem>>('/admin/orders', { params: query, loading: false }),
};
