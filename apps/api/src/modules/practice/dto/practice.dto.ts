import type { PracticeMode, PracticeModule, WriteDimensionKey } from '@qz/core';

/**
 * 练习中心对外的数据形状（控制器与小程序共用同一份契约）
 *
 * ## 与 `vocab.dto.ts` 的关键差别：这里**不隐藏答案**
 *
 * 词汇模块的卡片刻意不带释义（"答完才看解释"的节奏，见该文件头）。而练习中心的
 * 三道题**必须带目标句**：
 *
 *   · 连词成句 —— 用户的输入就是"把给到的砖块排好"，不给砖块没法答；
 *   · 口语跟读 —— 用户要"看着句子读出来"，屏幕上看不到句子就无从开口；
 *   · 中译英 —— 只有这一种模式是"给中文、不给英文"，此时 `en` 为 null。
 *
 * 所以**答案是否下发由模式决定**，不是由模块决定。硬套词汇模块那套
 * （统一不下发）会让口语跟读变成盲读，直接废掉这个功能。
 */

/* ==================== 句子 ==================== */

/** 语块（连词成句的"砖块"）：一块英文 + 它对应的中文（有则显示） */
export interface SentenceChunk {
  en: string;
  zh: string;
}

/** 练习队列里的一句 */
export interface SentenceCard {
  id: string;
  /** 题目序号（本轮第几题，从 1 开始；界面显示"3/10"用） */
  index: number;
  /**
   * 目标英文句。
   *
   * ⚠️ `recall`（中译英）模式下为 `null` —— 给了就等于给答案。
   * 判卷与复习都不依赖它下发（服务端自己查库），所以置空是安全的。
   */
  en: string | null;
  /** 中文释义（三种模式都要显示；它是题干） */
  zh: string;
  /** 语块（仅 `chunks` 模式下发；其它模式为 null） */
  chunks: SentenceChunk[] | null;
  /** 朗读用音频（仅 `listen` 模式需要；`null` 表示合成失败，界面应降级为直接显示文本） */
  audio: string | null;
  /** 难度 1~3（1 基础 / 2 进阶 / 3 挑战） */
  level: number;
  /** 词数（界面显示"12 词"，也让用户预估难度） */
  wordCount: number;
}

/** 今日练习队列（按模块组织） */
export interface PracticeTodayResult {  /** 今天要做哪些模块（顺序即推荐顺序，见 `PracticeQueueService.MODULE_ORDER`） */
  modules: PracticeModulePlan[];
  today: PracticeDayCount;
  /** 全局累计（所有模块合计） */
  totals: PracticeTotals;
  /** 打卡日历（最近 30 天） */
  calendar: PracticeDayStat[];
  /** 连续打卡天数 */
  streak: number;
}

/** 一个模块今天的计划（界面上的一个入口卡片） */
export interface PracticeModulePlan {
  module: PracticeModule;
  /** 可用模式（顺序即推荐顺序） */
  modes: PracticeMode[];
  /** 我今天该练多少（**按配额算的剩余量**，不是固定值） */
  quota: number;
  /** 今天已经练了几题 */
  done: number;
  /**
   * 队列里实际取到的题数（可能小于 quota）。
   *
   * ⚠️ 与 `quota` 分开返回而不是取小值：`quota > 0` 但 `available === 0`
   * 意味着"题库空了"，界面该说"题库已练完"；只有 `quota === 0` 才是"今天够了"。
   * 合成一个数字之后这两种情况就分不出来了 —— 而它们对用户的意义完全不同。
   */
  available: number;
  /** 今天到期的复习题数（"巩固"部分） */
  reviewDue: number;
  /** 队列为空时的原因（非空表示"空"，且说清是哪一种空） */
  emptyReason: string;
}

/**
 * 某一天的练习计数（`practice_study_log` 的一行）。
 *
 * ## 为什么拆成两个类型而不是一个带可选 `day` 的
 *
 * "今天做了多少"（`PracticeDayCount`）与"日历里的某一天"（`PracticeDayStat`）
 * 是两件事：前者**没有日期**（它就是"现在"），后者必须有。
 * 合成一个 `day?: string` 会让日历补零时忘记填日期也编译通过 ——
 * 而那种缺陷的表现是"日历上所有日子都显示同一个数字"，
 * 查起来得一路追到渲染层。
 */
export interface PracticeDayStat {
  /** 业务日（YYYY-MM-DD） */
  day: string;
  sentenceCount: number;
  speakCount: number;
  writeCount: number;
  passCount: number;
  failCount: number;
}

/** 今天的计数（提交结果与今日总览里返回，没有日期字段 —— 它就是"今天"） */
export type PracticeDayCount = Omit<PracticeDayStat, 'day'>;

/** 全局累计 */
export interface PracticeTotals {
  /** 已进入复习计划的题数（有 progress 行的） */
  tracked: number;
  /** 已掌握（间隔 ≥ 60 天） */
  mastered: number;
  /** 今天到期 */
  due: number;
  /** 口语平均分（一次没练时为 0，不是 100） */
  speakAvg: number;
  /** 作文平均分（同上） */
  writeAvg: number;
  /** 句子练习正确率 */
  sentenceAccuracy: number;
}

/* ==================== 作文题面 ==================== */

/**
 * 作文题（`GET /practice/cards?module=write` 下发）。
 *
 * ## 为什么**不含**范文
 *
 * 范文是"批改后展示"的东西 —— 提前下发等于把答案放在首屏，
 * 抓包即得，用户会直接抄。所以 `sample` 只在 `POST /practice/submit`
 * 的返回里出现（见 `WriteReview.sample`）。
 *
 * ## 提纲也不含参考表达
 *
 * `outline` 只写"该写哪几点"，不给"该用哪个句型"。给了句型的提纲
 * 会让所有学生交出同一篇作文，"词汇 / 结构"两个批改维度就失效了。
 */
export interface TopicCard {
  id: string;
  /** 题目序号（本轮第几题） */
  index: number;
  code: string;
  /** `exam` 真题 / `mock` 模拟 */
  kind: string;
  /** `cet4` / `cet6` / `general` */
  level: string;
  title: string;
  /** 中文题意说明（用户在写之前要知道题在问什么） */
  zhBrief: string;
  /** 提纲：该写哪几点 */
  outline: string[];
  /** 词数下限 */
  minWords: number;
  /** 我已经练过几次 */
  attempts: number;
}

/**
 * 一次题面下发（`GET /practice/cards`）。
 *
 * `cards` 与 `topics` **必有一空**：句子/口语用 `cards`，作文用 `topics`。
 * 不合并成一个联合数组是刻意的 —— 界面渲染的是完全不同的组件，
 * 让它在同一个数组里按字段判断"这是句子还是作文"会把类型安全丢掉。
 */
export interface PracticeCardsResult {
  module: PracticeModule;
  modes: PracticeMode[];
  /**
   * 本批卡片**实际是哪种模式**出的题。
   *
   * ⚠️ 它和 `modes` 不是一回事：`modes` 是"这个模块支持哪些模式"（用于切题面按钮），
   * 而 `mode` 是"这一批卡片此刻用的是哪种" —— 题面上的字段差异（`en` 是否下发、
   * `chunks` 是否有值）全由它决定。
   *
   * 客户端**必须**按它渲染，不能自己猜：猜错的表现是"中译英页面上直接显示了英文答案"
   * 或"连词成句页面上砖块是空的"，两者都不报错。
   */
  mode: PracticeMode;
  /** 本批最多给多少（配额剩余量） */
  quota: number;
  cards: SentenceCard[];
  topics: TopicCard[];
  emptyReason: string;
}

/* ==================== 提交结果 ==================== */

/** 一个词的朗读/拼写结果 */
export interface PracticeWordResult {
  word: string;
  ok: boolean;
}

/**
 * 提交结果。
 *
 * ⚠️ `pass` 是**服务端算的**（`score >= SPEAK_PASS_SCORE`），
 * 但同时也把 `score` / `hit` / `total` 一起下发 —— 界面要显示
 * "命中 9/14 词（64%）"，只给一个布尔值用户看不出差多少。
 */
export interface PracticeSubmitResult {
  module: PracticeModule;
  mode: PracticeMode;
  /** 是否通过（句子=全对；口语=准确率≥60%；作文=按维度判定，见 `write`） */
  pass: boolean;
  /** 0~100 */
  score: number;
  /** 逐词对比（句子 / 口语用；作文为 null） */
  words: PracticeWordResult[] | null;
  /** 目标文本（答完才回，句子/口语用） */
  target: string | null;
  /** 中文参考（作文用 `zhBrief`） */
  reference: string | null;
  /** 口语：ASR 转写出的文本（用户要看到"机器听成了什么"） */
  transcript: string | null;
  /**
   * 口语：还差多少分才过。
   *
   * 不下发这个数字的话，用户看到的只有"没过"，只能反复重读 ——
   * 那是让人放弃的反馈。`0` 表示已过。
   */
  needScore: number;
  /** 作文：逐维度批改（非作文为 null） */
  write: WriteReview | null;
  /** 复习调度结果 */
  schedule: { intervalDays: number; dueDate: string; state: string };
  /** 今天的计数（提交后回读，供界面就地更新） */
  today: PracticeDayCount;
}

/** 作文批改结果 */
export interface WriteReview {
  /** 加权总分 0~100 */
  total: number;
  /** 各维度评分 */
  dimensions: WriteDimensionResult[];
  /** 逐条点评（与维度对应，用户要看到"为什么给这个分"） */
  comments: string[];
  /** 改写建议（挑 2~3 处具体句子，不整篇重写） */
  suggestions: string[];
  /** 范文（题目自带；不调 LLM 也能给） */
  sample: string;
  /** 词数 */ 
  wordCount: number;
  /** 是否因太短而未批改 */
  tooShort: boolean;
}

export interface WriteDimensionResult {
  key: WriteDimensionKey;
  title: string;
  /** 权重（%） */
  weight: number;
  /** 0~100 */
  score: number;
  /** 该维度的说明（为什么是这个分） */
  comment: string;
}

/* ==================== 练习详情 ==================== */

/** 单题详情（历史回看用） */
export interface PracticeDetailResult {
  refId: string;
  module: PracticeModule;
  target: string;
  reference: string;
  /** 最近若干次作答 */
  attempts: {
    mode: PracticeMode;
    pass: boolean;
    score: number;
    submitted: string;
    createdAt: string;
  }[];
}
