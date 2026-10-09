/**
 * 记单词 · 学习页（四种题型）
 *
 * ## 题面上不带答案，也不带释义
 *
 * 卡片只有题面（词形 / 释义 / 发音 / 挖空例句）与选项 —— 后端 `VocabCard` 里
 * 没有 `answerKey`，也没有释义。释义与例句要等作答后由 `POST /vocab/answer` 一并返回。
 * 这不是"少传了点数据"，而是出题的前提：答案一旦跟题面一起来，就印在屏幕上了。
 *
 * ## 题型由后端定，界面只负责渲染
 *
 * `card.type` 决定这一屏长什么样（见 `utils/vocab-types.ts` 的取值表）。
 * 界面**不自己挑题型**：题型由 `(词 id, 已复习次数)` 在服务端算出来（确定性），
 * 挑的人换成客户端就会出现"出题与判卷算出的题型不同"—— 那种 bug 表现为
 * "我明明拼对了却判错"，且刷新一下题型又变了，极难复现。
 *
 * ## 对错由服务端判，客户端连答案都不知道
 *
 * 提交只带用户输入（`choice` 或 `text`），返回才知道对错与正确答案。
 * 所以界面无法"提前知道答案"，也就不会有"本地判对了、服务端判错了"这类两处口径不一致。
 *
 * ## 队列顺序：先复习、后新词
 *
 * 先还旧账再借新账是间隔重复的常规做法，也让"今天还欠多少"这一段先被清掉。
 *
 * ## 发音
 *
 * 走 `providers.audio`（侧车 edge-tts），按 `词 + 音色` 在服务端缓存 30 天。
 * 返回 base64（后端统一响应体承载不了二进制流），由 `utils/vocab-audio.ts`
 * 落成沙箱文件再交给 `InnerAudioContext`。**音色不在页面里写死**：不传就取服务端默认，
 * 两处各写一个默认值必然会有一天对不上。
 */
import { vocabApi } from '../../utils/api';
import type {
  VocabAnswerResult,
  VocabCard,
  VocabExample,
  VocabPhrase,
  VocabSense,
  VocabTodayResult,
} from '../../utils/api';
import { VOCAB_TEXT_MAX } from '../../utils/vocab-types';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { playWordAudio, stopWordAudio } from '../../utils/vocab-audio';

import { FALLBACK_TYPE, toCardView, type ViewType } from './card-view';

/** 选项行：`cls` 是作答后补上的对/错/淡出样式（WXML 里不能算函数） */
interface OptionRow {
  key: string;
  text: string;
  cls: string;
}

Page({
  data: {
    loading: true,
    error: '',
    /** 今日队列（复习在前、新词在后）；页面内多处要读，放在 data 里 */
    queue: [] as VocabCard[],
    idx: 0,
    total: 0,
    /**
     * 进页时队列就是空的：没选词书 / 今天已完成 / 词表还在建设。
     * 三种"空"的原因由后端给（`emptyReason`），界面原样转述，不自己编一句
     */
    showEmpty: false,
    emptyText: '',
    goBook: false,

    /* ---------- 题面 ---------- */
    type: FALLBACK_TYPE as ViewType,
    typeLabel: '',
    hint: '',
    showWord: true,
    showPhonetic: true,
    showSense: false,
    hasOptions: true,
    hasInput: false,
    showSpeaker: true,
    spelling: '',
    phonetic: '',
    /** `cloze` 的挖空例句 */
    prompt: '',
    promptZh: '',
    /** `spelling` 的题面释义 */
    senseText: '',
    isNew: false,
    optionRows: [] as OptionRow[],
    /** 选择题：选中的 key */
    picked: '',
    /** 拼写题：输入框里的内容 */
    typed: '',
    /** 输入框的受控值 —— 作答后要清空它，才能真的清掉输入框里的字 */
    inputValue: '',
    answered: false,
    correct: false,
    /** 差一点就对（拼写错一个字母）—— 反馈语气与"答错"不同 */
    nearMiss: false,
    /** 作答后回显的正确答案（拼写/填空用来对照） */
    answerText: '',
    /** 作答后回显的用户提交 */
    submitted: '',

    /* ---------- 作答后摊开的内容 ---------- */
    senses: [] as VocabSense[],
    examples: [] as VocabExample[],
    phrases: [] as VocabPhrase[],
    ukPhonetic: '',
    /** 音标切换：false=美音（`phonetic`）true=英音（`ukPhonetic`） */
    showUk: false,
    /** 有没有英式音标（没有就不渲染切换开关 —— 点了没反应比不给更糟） */
    hasUk: false,
    mnemonic: '',
    nextTip: '',

    /** 正在合成/播放发音（喇叭转起来，避免连点） */
    speaking: false,
    /** 后端 provider 是 `mock-*` = 演示音频，必须如实标注（红线 10） */
    demoAudio: false,

    finished: false,
    rightCount: 0,

    /** 输入长度上限（放进 data 是为了 WXML 的 `maxlength` 能用同一个值） */
    textMax: VOCAB_TEXT_MAX,

    fxStyle: '',
  },

  onLoad() {
    void this.load();
  },

  onShow() {
    fxEnableTilt(this);
  },

  onHide() {
    // 离开页面必须停声：接着播会在列表页里"背后有人念单词"
    fxDisableTilt();
    stopWordAudio();
    this.setData({ speaking: false });
  },

  onUnload() {
    fxDisableTilt();
    stopWordAudio();
  },

  /** 拉今日队列并出第一题 */
  async load() {
    try {
      const res = await vocabApi.today();
      const queue = toQueue(res);
      if (!queue.length) {
        this.setData({
          loading: false,
          error: '',
          showEmpty: true,
          emptyText: emptyTextOf(res),
          goBook: res.needsBook,
        });
        return;
      }
      this.setData({
        queue,
        total: queue.length,
        loading: false,
        error: '',
        showEmpty: false,
        finished: false,
        rightCount: 0,
      });
      this.show(0);
    } catch (e) {
      this.setData({ loading: false, error: (e as Error).message || '加载失败' });
    }
  },

  /** 把第 i 题摆到题面上（清掉上一题的作答痕迹） */
  show(i: number) {
    const card = this.data.queue[i];
    if (!card) return;
    const view = toCardView(card);
    this.setData({
      idx: i,
      type: view.type,
      typeLabel: view.label,
      hint: view.hint,
      showWord: view.showWord,
      showPhonetic: view.showPhonetic,
      showSense: view.showSense,
      hasOptions: view.hasOptions,
      hasInput: view.hasInput,
      showSpeaker: view.showSpeaker,
      spelling: card.spelling,
      phonetic: card.phonetic,
      prompt: card.prompt,
      promptZh: card.promptZh,
      senseText: card.senseText,
      isNew: card.isNew,
      optionRows: card.options.map((o) => ({ key: o.key, text: o.text, cls: '' })),
      picked: '',
      typed: '',
      inputValue: '',
      answered: false,
      correct: false,
      nearMiss: false,
      answerText: '',
      submitted: '',
      senses: [],
      examples: [],
      phrases: [],
      ukPhonetic: '',
      hasUk: false,
      showUk: false,
      mnemonic: '',
      nextTip: '',
    });
    // 听音辨词的题面就是声音 —— 进题即读，不用用户先点一下喇叭
    if (view.autoSpeak) void this.speakCard(card);
  },

  /**
   * 选了一个选项。
   *
   * 判重看 `picked` 而**不是** `answered`：`answered` 要等接口回来才置位，
   * 而这中间有几百毫秒 —— 连点两下就会提交两次（服务端每次提交都会给当天计数 +1，
   * 只是第二次不再算"新学"）。`picked` 在发请求前就写好了，能挡住这个窗口。
   */
  async onPick(e: WechatMiniprogram.TouchEvent) {
    if (this.data.picked || this.data.answered) return;
    const card = this.data.queue[this.data.idx];
    if (!card) return;
    const key = e.currentTarget.dataset.key as string;
    this.setData({ picked: key });
    await this.submit(card, { choice: key }, key);
  },

  /** 拼写题：输入框内容变化（**只改 `typed`，不动 `inputValue`** —— 见 `submit` 的说明） */
  onType(e: WechatMiniprogram.Input) {
    this.setData({ typed: e.detail.value });
  },

  /**
   * 拼写题提交。
   *
   * ⚠️ 空输入**不发请求**：拼写题空提交一定判错，而每次提交都会在服务端
   * 计入一次"答错"（不可逆）。用户手滑点了"提交"不该污染复习计划。
   */
  async onSubmitSpelling() {
    if (this.data.answered) return;
    const card = this.data.queue[this.data.idx];
    if (!card) return;
    const text = this.data.typed.trim();
    if (!text) {
      wx.showToast({ title: '先把这个词拼出来', icon: 'none' });
      return;
    }
    await this.submit(card, { text }, text);
  },

  /**
   * 提交并应用结果（两种题型共用的收口）。
   *
   * `inputValue` 在**成功之后**才同步成用户输入 —— 它只是"输入框当前显示什么"，
   * 不等同于 `typed`（`typed` 是用户实际敲进去的内容）。发出请求到返回之间
   * 输入框必须保持可用（用户可能还在改），所以不在发请求时就锁住它。
   */
  async submit(card: VocabCard, payload: { choice?: string; text?: string }, localEcho: string) {
    try {
      const res = await vocabApi.answer(card.wordId, payload);
      this.applyAnswer(res, localEcho);
    } catch (err) {
      // 没提交成功就不能留在"已选中"的状态：否则用户以为这题做过了
      this.setData({ picked: '', typed: '', inputValue: '' });
      wx.showToast({ title: (err as Error).message || '提交失败', icon: 'none' });
    }
  },

  /** 作答结果 → 视图（高亮对错、摊开释义、给出下次复习时间） */
  applyAnswer(res: VocabAnswerResult, picked: string) {
    this.setData({
      answered: true,
      correct: res.correct,
      nearMiss: res.nearMiss,
      answerText: res.answerText,
      submitted: res.submitted || picked,
      rightCount: this.data.rightCount + (res.correct ? 1 : 0),
      optionRows: markOptions(this.data.optionRows, res.answerKey, picked),
      senses: res.word.senses,
      examples: res.word.examples,
      phrases: res.word.phrases,
      ukPhonetic: res.word.ukPhonetic,
      hasUk: Boolean(res.word.ukPhonetic),
      mnemonic: res.word.mnemonic,
      nextTip: nextTipOf(res.schedule.intervalDays),
    });
  },

  /**
   * 美/英音标切换。
   *
   * 只切**显示**，不重发请求（两个音标早在作答响应里就一起带回来了）。
   * 没有英式音标时开关根本不渲染（`hasUk` 为 false），所以这里不必再判一次空。
   */
  onToggleAccent() {
    this.setData({ showUk: !this.data.showUk });
  },

  /** 继续下一题；已是最后一题就收尾（而不是回首页，那样看不到今天的成果） */
  onNext() {
    if (!this.data.answered) return;
    const next = this.data.idx + 1;
    if (next < this.data.total) {
      this.show(next);
      return;
    }
    this.setData({ finished: true });
  },

  /** 喇叭：合成并播放当前单词 */
  async onSpeak() {
    const card = this.data.queue[this.data.idx];
    if (!card) return;
    await this.speakCard(card);
  },

  /** 播放一张卡片的发音（手动点喇叭与"听音辨词自动读"共用） */
  async speakCard(card: VocabCard) {
    if (this.data.speaking) return;
    this.setData({ speaking: true });
    try {
      const res = await vocabApi.audio(card.wordId);
      // 再点同一个词是"停止"，`playWordAudio` 会立刻返回 —— 喇叭状态照样要放掉
      await playWordAudio(`${card.wordId}:${res.voice}`, res.audioBase64, res.format);
      if (res.provider.startsWith('mock')) this.setData({ demoAudio: true });
    } catch (e) {
      // 听音辨词是"没有声音就没法作答"的题型，所以它的失败必须说出来；
      // 其它题型里发音只是辅助，静默降级、不打断背单词的节奏
      if (this.data.type === 'listening') {
        wx.showToast({ title: (e as Error).message || '发音暂时不可用', icon: 'none' });
      }
    } finally {
      this.setData({ speaking: false });
    }
  },

  onRetry(): Promise<void> {
    this.setData({ loading: true, error: '' });
    return this.load();
  },

  /** 空态：去选词书（本页入口只有首页金刚区，返回即回到词书列表那一步） */
  onBack() {
    wx.navigateBack();
  },

  /** 完成后去统计页（redirectTo：从统计返回应回到首页，而不是回到已做完的题） */
  onGoStats() {
    wx.redirectTo({ url: '/pkg-vocab/stats/index' });
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

/** 队列：到期复习在前、新词在后 */
function toQueue(res: VocabTodayResult): VocabCard[] {
  return [...res.reviewCards, ...res.newCards];
}

/** 三种"空"的说法由后端给（没选词书 / 今天已完成 / 词表建设中），这里只兜一句 */
function emptyTextOf(res: VocabTodayResult): string {
  if (res.needsBook) return '还没有选择词书，先回去选一本再开始';
  return res.emptyReason || '今天没有待学的词，下拉刷新看看';
}

/** 高亮：正确项恒绿、选错的那个标红、其余淡出 */
function markOptions(rows: OptionRow[], answerKey: string, picked: string): OptionRow[] {
  // 拼写题没有选项（`rows` 为空），提前返回省掉一次无意义的 map
  if (rows.length === 0) return rows;
  return rows.map((r) => {
    if (r.key === answerKey) return { ...r, cls: 'study-opt-ok' };
    if (r.key === picked) return { ...r, cls: 'study-opt-no' };
    return { ...r, cls: 'study-opt-dim' };
  });
}

/** "下次什么时候再见"。答错的间隔一律 1 天（见 `@qz/core` 的 `sm2.ts`） */
function nextTipOf(intervalDays: number): string {
  if (intervalDays <= 1) return '明天还会再见到它';
  return `${intervalDays} 天后复习`;
}
