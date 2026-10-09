/**
 * 记单词 / 四六级词汇训练的类型（M4-15）
 *
 * 与后端 `apps/api/src/modules/vocab/dto/vocab.dto.ts` 一一对应。
 * 从这里拆出来的原因和 `api-types.ts` 当初从 `api.ts` 拆出来一样：
 * 一个文件被塞到 300 行上限之后，**真正该被读的那部分会被挤到看不见**。
 *
 * ## 卡片里没有释义，这是出题的前提
 *
 * `VocabCard` 只有词形 / 音标 / 四个选项 —— **没有 `answerKey`，也没有释义**。
 * 判卷在服务端（`POST /vocab/answer`），答对了才把 `VocabWordDetail` 一起给回来。
 * 客户端用 `any` 兜底会把"答案是否泄露"这件事变得不可见，所以这里逐字段写清楚。
 */

// ---------- 词条 ----------

export interface VocabSense {
  pos: string;
  meaning: string;
}

export interface VocabExample {
  en: string;
  zh: string;
}

/** 词组搭配（「不背单词」式内容组织的支柱之一） */
export interface VocabPhrase {
  phrase: string;
  zh: string;
}

/**
 * 题型（与后端 `vocab.dto.ts` 的取值表逐字一致）。
 *
 * | 值 | 界面 | 用户要做的 | 提交 |
 * |---|---|---|---|
 * | `meaning` | 给词形选释义 | 从 4 个释义中挑 | `{choice}` |
 * | `spelling` | 给中文释义拼词 | 拼出英文词形 | `{text}` |
 * | `listening` | 给发音选词 | 听音后挑出正确词形 | `{choice}` |
 * | `cloze` | 给挖空的例句选词 | 选出填进空格的词 | `{choice}` |
 *
 * ⚠️ **按字符串处理，不要写死成联合类型**：题型会随任务迭代增加，
 * 界面必须对不认识的题型有兜底（否则那道题会渲染成一片空白，且**没有任何报错**）。
 * 兜底策略见 `pkg-vocab/study/index.ts` 的 `normalizeCard`。
 */
export type VocabQuestionType = string;

/** 填空/拼写题的作答长度上限（与后端校验共用同一个值） */
export const VOCAB_TEXT_MAX = 40;

// ---------- 词书 ----------

export interface VocabBookItem {
  code: string;
  name: string;
  desc: string;
  level: number;
  /**
   * 界面分组：`school` 教材 / `exam` 考试 / `abroad` 出国 / `career` 职业。
   *
   * ⚠️ **按字符串处理，不要写死成联合类型**：分类由数据决定，
   * 后端随时可能多出一组。界面遇到不认识的分类要有兜底分组
   * （否则那本词书会**整个不显示**，而没有任何报错）。
   */
  category: string;
  wordCount: number;
  /** active | planned —— planned 表示词表还没灌完，界面要说"建设中"且不可选 */
  status: string;
  selected: boolean;
  isActive: boolean;
  learned: number;
  due: number;
  mastered: number;
}

// ---------- 出题 / 作答 ----------

/**
 * 一道题（`answerKey` **不在**这里，只有服务端知道）
 *
 * ⚠️ `listening` 题型下 `spelling` 与 `phonetic` 是**空串**（服务端刻意清空的，
 * 否则答案就印在题面上）。界面判断"要不要显示词形"必须看 `type`，
 * **不要**看 `spelling` 是否为空 —— 两者恰好同义是巧合，不是契约。
 */
export interface VocabCard {
  wordId: string;
  /** 题型。取值见 `VocabQuestionType`；不认识的题型要有兜底渲染 */
  type: VocabQuestionType;
  spelling: string;
  phonetic: string;
  difficulty: number;
  isNew: boolean;
  /** 四选一题型的选项；`spelling` 题型为空数组 */
  options: { key: string; text: string }[];
  /** `cloze` 的题面：把目标词挖成下划线后的例句 */
  prompt: string;
  /** `cloze` 的题面翻译（中文），可为空 */
  promptZh: string;
  /** `spelling` 的题面：该词的主释义 */
  senseText: string;
}

/** 作答后返回的词条详情。**只有答完才拿得到**（答题前给出来等于把答案印在题上） */
export interface VocabWordDetail {
  wordId: string;
  spelling: string;
  phonetic: string;
  /** 英式音标；上游没给时为空串 */
  ukPhonetic: string;
  senses: VocabSense[];
  examples: VocabExample[];
  phrases: VocabPhrase[];
  mnemonic: string;
  difficulty: number;
  /** llm | curated —— 界面不得声称这是权威词典 */
  source: string;
}

// ---------- 今日计划 / 统计 ----------

export interface VocabDayLog {
  day: string;
  newCount: number;
  reviewCount: number;
  correctCount: number;
  wrongCount: number;
}

export interface VocabTodayResult {
  book: { code: string; name: string } | null;
  /** true = 还没选词书，此时 `books` 一并返回 */
  needsBook: boolean;
  books: VocabBookItem[];
  /** 队列为空的原因（已说清是哪一种空），非空时界面必须原样显示 */
  emptyReason: string;
  dailyNew: number;
  dailyReview: number;
  newCards: VocabCard[];
  reviewCards: VocabCard[];
  today: { newCount: number; reviewCount: number; correctCount: number; wrongCount: number };
  totals: { learned: number; mastered: number; due: number };
}

export interface VocabAnswerResult {
  correct: boolean;
  /** 题型（回显）：界面按它决定反馈区怎么画（填空题不给选项高亮） */
  type: VocabQuestionType;
  /** 正确项的 key；`spelling` 题型为空串 */
  answerKey: string;
  /** 正确答案原文（填空题 / 拼写题用它显示"正确是 xxx"） */
  answerText: string;
  /** 本次提交的原文（服务端回显，客户端不必自己记着用户输入了什么） */
  submitted: string;
  /** 差一点就对（编辑距离 ≤ 1）。**不等于** `correct`，只是评分更低 */
  nearMiss: boolean;
  word: VocabWordDetail;
  schedule: { intervalDays: number; dueDate: string; state: string };
  today: { newCount: number; reviewCount: number; correctCount: number; wrongCount: number };
  remaining: { newLeft: number; reviewLeft: number };
}

export interface VocabStatsResult {
  book: { code: string; name: string } | null;
  streak: number;
  totalLearned: number;
  mastered: number;
  dueToday: number;
  accuracy: number;
  /** 最近 30 天，**含没学的那几天**（缺的补零） */
  calendar: VocabDayLog[];
}

// ---------- 发音 ----------

export interface VocabAudioResult {
  spelling: string;
  voice: string;
  /** mp3 | wav —— 决定落盘扩展名，猜错 InnerAudioContext 会打不开 */
  format: string;
  audioBase64: string;
  cached: boolean;
  /** `mock-*` 即演示产物，界面必须如实标注 */
  provider: string;
}