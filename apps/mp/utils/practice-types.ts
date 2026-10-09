/**
 * 练习中心的类型（M4-16：句子练习 / 口语跟读 / 作文练习）
 *
 * 与后端 `apps/api/src/modules/practice/dto/practice.dto.ts` 一一对应。
 * 单独成文件的原因与 `vocab-types.ts` 相同：塞进 `api.ts` 会把**真正该读的调用表**
 * 挤到 300 行上限之外。
 *
 * ## ⭐ 这里与词汇模块最大的差别：答案**按模式**决定下不下发
 *
 * 词汇卡片一律不带释义（"答完才看解释"）。练习中心的三种题**不能照抄这套**：
 *
 *   · 连词成句 —— 用户的输入就是"把给到的砖块排好"，不给砖块没法答 → 下发 `en`
 *   · 口语跟读 —— 用户要"看着句子读出来"，屏幕上看不到句子就无从开口 → 下发 `en`
 *   · 中译英 —— 只有这一种模式"给中文不给英文" → `en` 为 `null`
 *
 * 所以**答案是"模式"的属性，不是"模块"的属性**。同理，界面渲染哪一套题面
 * **必须读服务端给的 `mode`**，不能自己按模块猜 —— 猜错的表现是
 * "中译英页面上直接显示了英文答案"或"连词成句的砖块是空的"，**两者都不报错**。
 */

// ---------- 模块与模式 ----------

/**
 * 练习模块（与后端 `PRACTICE_MODULES` 逐字一致）。
 *
 * ⚠️ 按字符串处理，不写死成联合类型：模块会随任务迭代增加，
 * 界面必须对不认识的模块有兜底（否则那个入口渲染成空白，且**没有任何报错**）。
 */
export type PracticeModule = string;

/**
 * 题面模式。
 *
 * | 值 | 属于 | 界面 | 提交 |
 * |---|---|---|---|
 * | `chunks` | sentence | 打乱的语块，拼装成句 | `{text}` 拼好的整句 |
 * | `recall` | sentence | 只给中文，写出英文 | `{text}` |
 * | `listen` | sentence | 播音频，听写英文 | `{text}` |
 * | `speak` | speak | 显示的句子 + 按住录音 | `{audioBase64}` |
 * | `write` | write | 提纲 + 大输入框 | `{text}` 作文正文 |
 */
export type PracticeMode = string;

/** 一个模块的元信息（由 `GET /practice/modules` 返回） */
export interface PracticeModeItem {
  mode: PracticeMode;
  title: string;
}

export interface PracticeModuleItem {
  module: PracticeModule;
  title: string;
  hint: string;
  /** 可用模式（顺序即推荐顺序） */
  modes: PracticeModeItem[];
}

/**
 * `GET /practice/modules` 的响应体。
 *
 * ⚠️ **不是裸数组** —— 后端把它包在 `modules` 键里。请求层只剥掉外层信封
 * （`{code, message, data}`）的 `data`，**不会再往里剥一层**，所以这里拿到的是
 * `{ modules: [...] }`。
 *
 * 声明成 `PracticeModuleItem[]` 的后果是：`res.map is not a function` ——
 * 一个**只在运行时炸**的错误，`tsc` 查不出来（`.map` 在两边都存在）。
 */
export interface PracticeModulesResult {
  modules: PracticeModuleItem[];
}

// ---------- 今日总览 ----------

/** 某模块今天的计划 */
export interface PracticeModulePlan {
  module: PracticeModule;
  title: string;
  /** 可用模式 */
  modes: PracticeMode[];
  /** 今天该练多少（按配额算的剩余量） */
  quota: number;
  /** 今天已经练了几题 */
  done: number;
  /** 还能取到几题 */
  available: number;
  /** 其中有多少是"到期该复习"的 */
  reviewDue: number;
  /**
   * 取不到题的原因。**三种"空"的意义完全不同**（练完了 / 题库没建好 / 还没选书），
   * 兜底成一句"暂无数据"会让用户以为功能坏了 —— 所以界面原样转述后端这句。
   */
  emptyReason: string;
}

/**
 * 今日计数。
 *
 * ⚠️ 后端刻意把它拆成 `PracticeDayCount`（不含 `day`）与 `PracticeDayStat`（含 `day`），
 * 避免"日历补零时忘了填日期却编译通过"。这里如实照搬。
 */
export interface PracticeDayCount {
  sentenceCount: number;
  speakCount: number;
  writeCount: number;
}

export interface PracticeDayStat extends PracticeDayCount {
  /** `YYYY-MM-DD` */
  day: string;
}

export interface PracticeTotals {
  /** 追踪中的题目数（有进度的） */
  tracked: number;
  mastered: number;
  due: number;
  /** 口语平均准确率（0~100）。**一次没练过时是 0 而不是 100** */
  speakAvg: number;
  writeAvg: number;
  /** 句子正确率（0~100） */
  sentenceAccuracy: number;
}

export interface PracticeTodayResult {
  modules: PracticeModulePlan[];
  today: PracticeDayCount;
  totals: PracticeTotals;
  /** 打卡日历（最近 30 天，缺的补零） */
  calendar: PracticeDayStat[];
  /** 连续打卡天数 */
  streak: number;
}

// ---------- 题面 ----------

/**
 * 一个语块（连词成句的"砖块"）。
 *
 * `zh` 刻意可能为空串：逐块译文需要 LLM 或词典，本项目没有那个数据源，
 * **不能编**（编出来的"砖块释义"是用户会照着背的，错了比没有更糟）。
 * 界面在砖块上只显示英文，中文留给整句的 `zh`。
 */
export interface SentenceChunk {
  en: string;
  zh: string;
}

/** 练习队列里的一句 */
export interface SentenceCard {
  id: string;
  /** 题目序号（本轮第几题，从 1 开始） */
  index: number;
  /** 目标英文句。⚠️ `recall`（中译英）模式下为 `null` —— 给了就等于给答案 */
  en: string | null;
  /** 中文释义（三种模式都要显示；它是题干） */
  zh: string;
  /** 语块（仅 `chunks` 模式下发；其它模式为 null） */
  chunks: SentenceChunk[] | null;
  /** 朗读音频（base64）。队列里一律为 null，点喇叭时单独取 */
  audio: string | null;
  level: number;
  wordCount: number;
}

/** 作文题面 */
export interface TopicCard {
  id: string;
  code: string;
  /** `exam` 真题 / `mock` 模拟 */
  kind: string;
  level: string;
  title: string;
  /** 中文题意说明 */
  zhBrief: string;
  /** 提纲（该写哪几点）。`Json` 列，后端已逐项校验 */
  outline: string[];
  /** 建议词数下限 */
  minWords: number;
  /** ⚠️ `null` 表示题面上**不含范文**（提前下发等于把答案放在首屏） */
  sample: string | null;
  /** 我已经练过几次（用于排序，不随机抽） */
  practicedCount: number;
}

/** `GET /practice/cards` 的响应 */
export interface PracticeCardsResult {
  module: PracticeModule;
  /** 该模块**支持**哪些模式（用于切题面的按钮） */
  modes: PracticeMode[];
  /**
   * 本批卡片**此刻实际**用的是哪种模式。
   *
   * ⚠️ 与 `modes` 不是一回事，**渲染必须按它来**：
   * `modes` 是"能切成哪些"，`mode` 是"这一批现在是什么"。
   */
  mode: PracticeMode;
  quota: number;
  cards: SentenceCard[];
  topics: TopicCard[];
  emptyReason: string;
}

// ---------- 提交结果 ----------

/** 逐词对比（句子题：用户要知道哪个词错了） */
export interface PracticeWordResult {
  word: string;
  ok: boolean;
}

/** 作文批改的一个维度 */
export interface WriteDimensionResult {
  key: string;
  title: string;
  /** 0~100 */
  score: number;
  /** 权重（各维度合计 100） */
  weight: number;
  /** 为什么要给这个分（只给分数用户不知道从哪改） */
  reason: string;
}

export interface WriteReview {
  /** 各维度得分与理由 */
  dimensions: WriteDimensionResult[];
  /** 加权总分（**服务端算的，不是模型直接给的**） */
  total: number;
  /** 批改不可用时的说明（降级路径：**不阻断提交**，但必须说清） */
  degradedReason: string;
  /** 参考范文（AI 生成，必须标注） */
  sample: string;
  /** 中文题意 */
  zhBrief: string;
}

export interface PracticeSubmitResult {
  module: PracticeModule;
  mode: PracticeMode;
  /**
   * 是否通过。
   * ⚠️ 三档门槛**刻意不同**：句子=全对；口语=准确率≥60%；作文=按维度判定。
   * 这个值是**服务端算的**，界面不要自己再判一次（两处口径必然有一天不一致）。
   */
  pass: boolean;
  /** 0~100 */
  score: number;
  /** 命中词数（句子/口语用） */
  hit: number;
  /** 总词数 */
  total: number;
  /** 逐词对比（句子/口语） */
  words: PracticeWordResult[];
  /** 目标句原文（答完后回显对照用） */
  target: string;
  /** 用户提交的内容 */
  submitted: string;
  /** 未通过时"还差多少分"；已通过为 0 */
  needScore: number;
  /** 作文：提交的作文太短（**内容不丢，只是不算完成一次练习**） */
  tooShort: boolean;
  /** 作文：太短时的说明 */
  tooShortReason: string;
  /** 作文批改结果（仅 `write` 模块） */
  review: WriteReview | null;
  /** 本次作答后的复习计划 */
  schedule: { intervalDays: number; dueDate: string; state: string };
  /** 今天的计数（作答后） */
  today: PracticeDayCount;
}

// ---------- 音频 ----------

export interface PracticeAudioResult {
  /** base64（**不带 `data:` 前缀**） */
  audio: string;
  format: string;
  cached: boolean;
}

/* ---------- 界面本地常量（与后端共用同一个值的地方集中在这里） ---------- */

/**
 * 口语过关线（%）。与 `@qz/core` 的 `SPEAK_PASS_SCORE` 同值。
 *
 * ⚠️ **它只用于"文案里说清门槛是多少"**，判定本身仍然读服务端的 `pass` ——
 * 客户端再算一次就会有"界面说过了、服务端说没过"的窗口。
 */
export const SPEAK_PASS_SCORE = 60;

/** 朗读文本长度上限（作文正文）：与后端 `ATTEMPT_TEXT_MAX` 同值 */
export const PRACTICE_TEXT_MAX = 4000;

/** 录音最短时长（毫秒）。太短的录音在服务端会被拦掉，先在客户端提示更友好 */
export const MIN_RECORD_MS = 800;
