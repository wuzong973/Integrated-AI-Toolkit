/**
 * 练习中心 · 练习页（句子 / 口语 / 作文三种模块共用一页）
 *
 * ## 一次取一整批，页面内本地翻页
 *
 * `GET /practice/cards?module=` 一次给 6~10 题，而不是"取一题 / 交一题 / 再取一题"。
 * 逐题拉取的往返更多，且用户翻回上一题时要重新请求；一批十来题只有几十 KB。
 *
 * ## 题目里有没有答案，由服务端的 `mode` 决定
 *
 * 见 `utils/practice-view.ts` 文件头 —— 这是本页渲染的总开关，
 * **界面不按模块猜**。
 *
 * ## 判分全在服务端
 *
 * 提交只带用户输入（`text` 或 `audioBase64`），返回才知道对错。
 * 客户端再算一遍就会有"界面说过了、服务端说没过"的窗口，而 SM-2 的调度
 * 是按服务端那个结果写的 —— 两处口径分叉的代价是复习计划错乱。
 */
import { practiceApi } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { playWordAudio, stopWordAudio } from '../../utils/vocab-audio';
import {
  CANCELLED,
  createRecorder,
  MIN_RECORD_MS,
  canRecord,
  type RecorderSession,
} from '../../utils/practice-recorder';
import {
  buildReviewFields,
  countWords,
  feedbackText,
  nextTipOf,
  toWordRows,
  toggleChunk,
  type ChunkView,
  type OutlineRow,
  type ViewKind,
  type WordRow,
} from '../../utils/practice-view';
import { queuePatch, slotPatch } from '../../utils/practice-queue';
import type {
  PracticeCardsResult,
  PracticeSubmitResult,
  SentenceCard,
  TopicCard,
} from '../../utils/api';
import { PRACTICE_TEXT_MAX } from '../../utils/practice-types';

Page({
  /**
   * 字段分组（下面靠注释分隔，不逐字段解释）：
   *
   * - **队列**：`cards`/`topics` 是本批题目，`idx`/`total` 是进度，
   *   `mode` 是**本批实际用的模式**（题面字段差异全由它决定，见 `practice-view.ts`），
   *   `modes`/`modeTabs` 是"这个模块支持哪些模式"（切题面按钮）。
   * - **题面**：`showEn/showChunks/showRecorder/showSpeaker/showReveal` 五面旗由 `viewOf(mode)` 算出。
   * - **作答结果**：`showReview` 起是"作答后摊开的内容"（作文批改的维度分与范文）。
   * - `recorder` 刻意**不入 data** —— 它是对象，放进 data 会触发无意义的 setData 序列化。
   */
  data: {
    loading: true,
    error: '',
    module: 'sentence',

    /* ---------- 队列 ---------- */
    cards: [] as SentenceCard[],
    topics: [] as TopicCard[],
    idx: 0,
    total: 0,
    mode: '',
    /** 顶部显示用的**中文**模式名（服务端 `mode` 是 `chunks` 这类枚举，不能直接渲染） */
    modeText: '',
    kind: 'unknown' as ViewKind,
    hint: '',
    modes: [] as string[],
    modeTabs: [] as { mode: string; title: string; on: boolean }[],

    /* ---------- 题面 ---------- */
    sentenceId: '',
    /** 目标英文句（`recall` 模式下为**空串**，不是没加载出来） */
    en: '',
    zh: '',
    showEn: false,
    showChunks: false,
    showRecorder: false,
    showSpeaker: false,
    showReveal: false,
    /** 打乱后的砖块 + 已选中的砖块下标 + 拼好的句子 */
    chunks: [] as ChunkView[],
    pickedIdx: [] as number[],
    assembled: '',
    /** 文本题（中译英 / 听写）的输入 */
    typed: '',
    inputValue: '',
    textMax: PRACTICE_TEXT_MAX,

    /* ---------- 作文题面 ---------- */
    topicTitle: '',
    topicBrief: '',
    outline: [] as OutlineRow[],
    minWords: 0,
    essayText: '',
    essayWords: 0,

    /* ---------- 录音 ---------- */
    recording: false,
    /** 录音按钮上的一句话状态 */
    recordHint: '按住读出来',
    canRecord: true,

    /* ---------- 作答结果 ---------- */
    answered: false,
    pass: false,
    score: 0,
    feedback: '',
    words: [] as WordRow[],
    target: '',
    submitted: '',
    tooShort: false,
    tooShortReason: '',
    showReview: false,
    reviewTotal: 0,
    reviewDegraded: '',
    dimensions: [] as { key: string; title: string; score: number; weight: number; reason: string }[],
    sample: '',
    sampleZh: '',
    nextTip: '',
    /** 提交/朗读**进行中**（提交用的是 `answering`，见 `submit()` 的说明） */
    answering: false,
    speaking: false,

    finished: false,
    passCount: 0,
    /** 队列为空时的一句话（原样转述后端 `emptyReason`，不自己编） */
    emptyText: '',
    /** 中译英用过"看答案"：题面展开后不再收回去，并换一句提示（见 onReveal） */
    revealed: false,

    fxStyle: '',
  },

  /** 录音会话（**不入 data**：它是对象，放进 data 会触发无意义的 setData 序列化） */
  recorder: null as RecorderSession | null,

  onLoad(query: Record<string, string | undefined>) {
    const module = query.module ?? 'sentence';
    this.setData({ module, canRecord: canRecord() });
  },

  onShow() {
    fxEnableTilt(this);
    if (!this.data.cards.length && !this.data.topics.length) void this.load();
  },

  onHide() {
    fxDisableTilt();
    stopWordAudio();
    this.cancelRecord();
    this.setData({ speaking: false });
  },

  onUnload() {
    fxDisableTilt();
    stopWordAudio();
    this.cancelRecord();
  },

  /** 拉本模块的今日题面 */
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const res = await practiceApi.cards(this.data.module);
      this.applyQueue(res);
    } catch (e) {
      this.setData({ loading: false, error: (e as Error).message || '加载失败' });
    }
  },

  /** 题面响应 → 视图，并摆出第一题 */
  applyQueue(res: PracticeCardsResult) {
    const { patch, empty } = queuePatch(res);
    this.setData(patch);
    if (!empty) this.show(0);
  },

  /** 把第 i 题摆到题面上（清掉上一题的作答痕迹） */
  show(i: number) {
    this.setData(slotPatch(this.data.cards, this.data.topics, this.data.mode, i));
  },

  /* ==================== 输入 ==================== */

  /** 点一块砖：还没选就追加到末尾，已选就取下来（可以反悔） */
  onPickChunk(e: WechatMiniprogram.TouchEvent) {
    if (this.data.answered) return;
    const idx = Number(e.currentTarget.dataset.idx);
    this.setData(toggleChunk(this.data.pickedIdx, this.data.chunks, idx));
  },

  /** 清空重排（拼到一半发现排错了，不用一道道点回去） */
  onClearChunks() {
    if (this.data.answered) return;
    this.setData({ pickedIdx: [], assembled: '' });
  },

  onType(e: WechatMiniprogram.Input) {
    this.setData({ typed: e.detail.value });
  },

  onEssayInput(e: WechatMiniprogram.Input) {
    const text = e.detail.value;
    this.setData({ essayText: text, essayWords: countWords(text) });
  },

  /* ==================== 录音（口语跟读） ==================== */

  /**
   * 按住开始录音。
   *
   * ⚠️ 每次**新建**一个会话（而不是复用一个）：`RecorderManager` 是全局单例，
   * 复用实例会让两段录音的回调互相串（表现为"读第二句弹的是第一句的结果"）。
   */
  onRecordStart() {
    if (this.data.answered || this.data.recording) return;
    if (!this.data.canRecord) {
      wx.showToast({ title: '当前环境不支持录音', icon: 'none' });
      return;
    }
    const session = createRecorder();
    this.recorder = session;
    this.setData({ recording: true, recordHint: '松手结束' });
    session.start();
  },

  /** 松手：结束录音并提交 */
  async onRecordEnd() {
    const session = this.recorder;
    if (!session || !this.data.recording) return;
    this.recorder = null;
    this.setData({ recording: false, recordHint: '正在识别…' });

    try {
      const res = await session.stop();
      if (res.duration < MIN_RECORD_MS) {
        // 太短就**不发请求**：服务端会拦，而且白扣一次额度
        this.setData({ recordHint: '按住读出来' });
        wx.showToast({ title: '读得太快了，把整句读完再松手', icon: 'none' });
        return;
      }
      await this.submit({ audioBase64: res.base64, audioFormat: res.format });
    } catch (e) {
      this.setData({ recordHint: '按住读出来' });
      const msg = (e as Error).message;
      // 用户主动取消**不弹提示**（那会让"我不想读了"变成一次报错）
      if (msg !== CANCELLED) wx.showToast({ title: msg || '录音失败', icon: 'none' });
    }
  },

  /** 松手前把手指滑走 / 离开页面：取消，不产生结果 */
  cancelRecord() {
    const session = this.recorder;
    if (!session) return;
    this.recorder = null;
    session.cancel();
    if (this.data.recording) this.setData({ recording: false, recordHint: '按住读出来' });
  },

  /* ==================== 提交 ==================== */

  /** 文本题的提交（中译英 / 听写 / 连词成句） */
  async onSubmitText() {
    if (this.data.answered || this.data.answering) return;
    const text = this.data.kind === 'chunks' ? this.data.assembled : this.data.typed.trim();
    if (!text) {
      wx.showToast({
        title: this.data.kind === 'chunks' ? '先把砖块排成一句话' : '先写点什么再提交',
        icon: 'none',
      });
      return;
    }
    await this.submit({ text });
  },

  /** 作文提交 */
  async onSubmitEssay() {
    if (this.data.answered || this.data.answering) return;
    const text = this.data.essayText.trim();
    if (!text) {
      wx.showToast({ title: '先写点内容再提交', icon: 'none' });
      return;
    }
    await this.submit({ text });
  },

  /**
   * 收口：提交并应用结果。
   *
   * `answering` 是**提交期间的重入锁**。不能只看 `answered`：它要等接口回来才置位，
   * 中间几百毫秒里连点两下就会提交两次（服务端每次提交都会给当天计数 +1）。
   */
  async submit(payload: { text?: string; audioBase64?: string; audioFormat?: string }) {
    const refId = this.data.sentenceId;
    if (!refId) return;
    this.setData({ answering: true });
    try {
      const res = await practiceApi.submit({ refId, module: this.data.module, ...payload });
      this.applyResult(res);
    } catch (err) {
      wx.showToast({ title: (err as Error).message || '提交失败', icon: 'none' });
    } finally {
      this.setData({ answering: false, recordHint: '按住读出来' });
    }
  },

  /** 作答结果 → 视图 */
  applyResult(res: PracticeSubmitResult) {
    this.setData({
      answered: true,
      pass: res.pass,
      score: res.score,
      feedback: feedbackText(this.data.kind, res.pass, res.score, res.needScore),
      words: toWordRows(res.words),
      // 服务端没回目标句时退回题面上那句（口语题 `target` 一定有值）
      target: res.target || this.data.en,
      submitted: res.submitted,
      tooShort: res.tooShort,
      tooShortReason: res.tooShortReason,
      passCount: this.data.passCount + (res.pass ? 1 : 0),
      nextTip: nextTipOf(res.schedule.intervalDays),
      ...buildReviewFields(res),
    });
  },

  /** 继续下一题（最后一题就收尾 —— 回首页会看不到今天的成果） */
  onNext() {
    if (!this.data.answered) return;
    const next = this.data.idx + 1;
    if (next < this.data.total) {
      this.show(next);
      return;
    }
    this.setData({ finished: true });
  },

  /**
   * 换题面模式。
   *
   * ⚠️ 只切**当前这一批的展示模式**会与"当天已锁定的模式"打架 ——
   * 后端把当天已练的模式记在 `modeLock` 上（同一次练习里重试必须还是同一种题面）。
   * 所以这里**重新取一批**（走 `cards`），让服务端决定下发哪套题面，
   * 而不是在客户端把已经拿到的卡片换个渲染方式（那会让 `en`/`chunks` 对不上）。
   */
  async onSwitchMode(e: WechatMiniprogram.TouchEvent) {
    const mode = e.currentTarget.dataset.mode as string;
    if (!mode || mode === this.data.mode) return;
    wx.showLoading({ title: '切换中' });
    try {
      const res = await practiceApi.cards(this.data.module);
      this.applyQueue(res);
    } catch (err) {
      wx.showToast({ title: (err as Error).message || '切换失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  /** 听写题的喇叭 / 口语题的示范读音：合成并播放这句 */
  async onSpeak() {
    const id = this.data.sentenceId;
    if (!id || this.data.speaking) return;
    this.setData({ speaking: true });
    try {
      const res = await practiceApi.sentenceAudio(id);
      await playWordAudio(`sentence:${id}`, res.audio, res.format);
    } catch (e) {
      // 听写是"没有声音就没法作答"的题型，失败必须说出来；
      // 口语与连词成句里音频只是辅助，静默降级、不打断节奏
      if (this.data.kind === 'listen') {
        wx.showToast({ title: (e as Error).message || '朗读暂时不可用', icon: 'none' });
      }
    } finally {
      this.setData({ speaking: false });
    }
  },

  /** 中译英实在想不出来：看答案（看过的题当然不算过，提交时后端会按对错分算） */
  onReveal() {
    if (this.data.answered) return;
    this.setData({
      showEn: true,
      revealed: true,
      hint: '看过答案了 —— 试着凭记忆拼出来',
    });
  },

  onRetry(): Promise<void> {
    return this.load();
  },

  /** 收尾后去统计页（redirectTo：从统计返回应回到入口，而不是回到已做完的题） */
  onGoStats() {
    wx.redirectTo({ url: '/pkg-practice/stats/index' });
  },

  onBack() {
    wx.navigateBack();
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
