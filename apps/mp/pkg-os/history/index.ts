/**
 * 聊天记录（AI 页右上角「历史记录」的落点）
 *
 * 两阶段在同一个页面里：
 *   `stage='list'`   → 我的会话（后端按最近活跃 desc，且只出**有消息的**会话）
 *   `stage='detail'` → 某一段对话的**只读**记录（时间正序，按天分段）
 *
 * ## 为什么是独立分包页而不是 AI 页里的抽屉
 *
 * AI 页（`pages/os/index.ts`）已贴着 296/300 行上限，塞不下第二个视图。
 * 独立成页反而更省事：「关闭」就是原生返回 + 页内「‹ 会话列表」胶囊，
 * 不需要自己维护遮罩栈与手势拦截。
 *
 * ## 性能（要求 5）
 *
 * 只在**进入本页**时才发请求 —— AI 页加载时不做任何历史相关拉取；
 * 单段记录一次最多渲染最近 `LOG_LIMIT` 条（见 `utils/os-history.ts`）。
 *
 * 所有"要算一下才能显示"的东西（时间文案、日期分段、角色标签、卡片状态）
 * 都在 `utils/os-history.ts` 里算好 —— WXML 里不能调函数。
 */
import { osApi } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { cardTarget } from '../../utils/os';
import {
  TRUNCATE_TIP,
  buildLog,
  toSessionRows,
  type LogRow,
  type SessionRow,
} from '../../utils/os-history';

/** `list` = 会话列表；`detail` = 某一段对话的只读记录 */
type HistoryStage = 'list' | 'detail';

Page({
  data: {
    stage: 'list' as HistoryStage,
    sessions: [] as SessionRow[],
    log: [] as LogRow[],
    /** 当前打开的那一段对话（标题 + 最近活跃时间，给页头用） */
    activeId: '',
    activeTitle: '',
    activeTime: '',
    /** 记录被截断（只显示了最近 N 条）—— 必须如实标注，不能装作这就是全部 */
    truncated: false,
    truncateTip: TRUNCATE_TIP,
    loading: true,
    error: '',
    /** 装饰层视差位移（由 utils/fx.ts 写入） */
    fxStyle: '',
  },

  onLoad() {
    void this.loadSessions();
  },

  onShow() {
    fxEnableTilt(this);
  },

  onHide() {
    fxDisableTilt();
  },

  onUnload() {
    fxDisableTilt();
  },

  /** 拉会话列表 */
  async loadSessions() {
    this.setData({ loading: true });
    try {
      const list = await osApi.sessions();
      this.setData({ sessions: toSessionRows(list), error: '', loading: false });
    } catch (e) {
      this.setData({
        sessions: [],
        error: (e as Error).message || '加载失败',
        loading: false,
      });
    }
  },

  /**
   * 打开某一段对话的记录。
   *
   * ⚠️ 会话归属由服务端 `requireSession` 校验：拿别人的 sessionId 换不来内容，
   * 只会拿到一句错误 —— 客户端不做"假装能看"的兜底。
   */
  async loadLog(id: string, title: string, timeText: string) {
    this.setData({
      stage: 'detail',
      activeId: id,
      activeTitle: title,
      activeTime: `最近活跃 ${timeText}`,
      log: [],
      truncated: false,
      loading: true,
      error: '',
    });

    try {
      const items = await osApi.messages(id);
      const { rows, truncated } = buildLog(items);
      this.setData({ log: rows, truncated, loading: false });
    } catch (e) {
      this.setData({
        log: [],
        truncated: false,
        error: (e as Error).message || '加载失败',
        loading: false,
      });
    }
  },

  onSessionTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    const s = this.data.sessions.find((x) => x.id === id);
    if (!s) return;
    void this.loadLog(s.id, s.title, s.timeText);
  },

  /**
   * 回到会话列表。
   *
   * 不重新拉取：列表数据在进详情时没被清掉，而**切到别的 tab（AI 页）会销毁本页**
   * ——所以不存在"列表已经过期却还留着"的情况，再拉一次只会白闪一次骨架。
   */
  onBackList() {
    this.setData({
      stage: 'list',
      log: [],
      activeId: '',
      truncated: false,
      error: '',
      loading: false,
    });
  },

  /** 错误条上的「重试」/ 下拉刷新：看当前在哪一阶段就重来哪一段 */
  onRetry(): Promise<void> {
    if (this.data.stage !== 'detail') return this.loadSessions();
    const s = this.data.sessions.find((x) => x.id === this.data.activeId);
    return this.loadLog(this.data.activeId, this.data.activeTitle, s?.timeText ?? '');
  },

  onPullDownRefresh() {
    void this.onRetry().finally(() => wx.stopPullDownRefresh());
  },

  /**
   * 记录里的结果卡 → 去它该去的地方（复用 `cardTarget`，与 AI 页同一套去向）。
   * 没有落点时**不跳空页面**，但要说一声 —— 静默 return 会让人以为卡片坏了。
   */
  onCardTap(e: WechatMiniprogram.TouchEvent) {
    const idx = Number(e.currentTarget.dataset.idx);
    const rowId = e.currentTarget.dataset.rowid as string;
    const card = this.data.log.find((r) => r.id === rowId)?.cards?.[idx];
    if (!card) return;

    const url = cardTarget(card);
    if (!url) {
      wx.showToast({ title: '该卡片暂无可跳转详情', icon: 'none' });
      return;
    }
    wx.navigateTo({ url });
  },

  /** 空态引导：去 AI 页聊第一句（tabBar 页必须用 switchTab） */
  onGoAi() {
    wx.switchTab({ url: '/pages/os/index' });
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
});
