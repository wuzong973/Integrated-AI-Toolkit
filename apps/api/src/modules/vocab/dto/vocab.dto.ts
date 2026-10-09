import type { OptionKey } from '../vocab-options';

/**
 * 记单词模块对外的数据形状（控制器与小程序共用同一份契约）
 *
 * ## 这里最要紧的一条：卡片**不带**释义
 *
 * `VocabCard` 里只有词形、音标、难度与四个选项文本 —— **没有 senses / examples / mnemonic**。
 * 释义与例句要等用户作答后由 `POST /vocab/answer` 一并返回（`VocabAnswerResult.word`）。
 * 不然"答完才看解释"的节奏就没了：答案直接躺在首屏响应里，抓包即得。
 */

export interface VocabSense {
  pos: string;
  meaning: string;
}

export interface VocabExample {
  en: string;
  zh: string;
}

/** 词组搭配（「不背单词」式内容组织的支柱之一，也是例句填空题的素材来源） */
export interface VocabPhrase {
  phrase: string;
  zh: string;
}

/**
 * 题型（四种）。
 *
 * ## 为什么题型必须显式下发，而不是让客户端猜
 *
 * 客户端要决定"渲染成选项列表 / 输入框 / 喇叭"、要决定"提交什么"，
 * 而这两件事**只能由题型决定**。曾经想过用"有没有 options"来推断，
 * 但那会让"选项生成失败"与"这是填空题"变得不可区分 ——
 * 前者应该跳过这道题，后者应该渲染输入框。
 *
 * ## 取值与界面的对照
 *
 * | 值 | 界面 | 用户要做的 | 提交 |
 * |---|---|---|---|
 * | `meaning` | 给词形选释义 | 从 4 个中文释义中挑 | `choice` |
 * | `spelling` | 给中文释义拼词 | 拼出英文词形 | `text` |
 * | `listening` | 给发音选词 | 听音后挑出正确词形 | `choice` |
 * | `cloze` | 给挖空的例句选词 | 选出填进空格的词 | `choice` |
 */
export const VOCAB_QUESTION_TYPES = ['meaning', 'spelling', 'listening', 'cloze'] as const;
export type VocabQuestionType = (typeof VOCAB_QUESTION_TYPES)[number];

/** 填空/拼写题的作答长度上限（前端输入框与服务端校验共用同一个值） */
export const VOCAB_TEXT_MAX = 40;

/** 词书列表项（含"我的"进度；未选也为 0，不省略字段） */
export interface VocabBookItem {
  code: string;
  name: string;
  desc: string;
  level: number;
  /**
   * 界面分组：`foundation` 基础 / `school` 教材 / `exam` 考试 / `abroad` 出国 / `career` 职业。
   *
   * ⚠️ 这是**字符串而不是联合类型**：词书分类由数据（`scripts/db/data/books.json`）决定，
   * 后端不该比数据更早地锁死枚举 —— 加一组新分类不必改代码、不必发版。
   * 小程序侧对**未知分类**要有兜底分组，不能因为多了个值就不显示这本词书。
   */
  category: string;
  wordCount: number;
  /** active | planned —— `planned` 表示词表还没灌完，界面要说"建设中"而不是给个空词书 */
  status: string;
  /** 是否已加入我的词书 */
  selected: boolean;
  /** 是否是当前正在学的这一本 */
  isActive: boolean;
  /** 我在本词书里已学过的词数（有 progress 行即算学过） */
  learned: number;
  /** 我在本词书里今天到期的复习数 */
  due: number;
  /** 已进入"成熟"（间隔 ≥ 60 天）的词数 */
  mastered: number;
}

/**
 * 一道题（不含答案）
 *
 * ## 哪些字段在哪种题型下有意义
 *
 * | 题型 | 用到的字段 |
 * |---|---|
 * | `meaning` | `spelling` `phonetic` `options` |
 * | `spelling` | `senseText`（题面给中文，用户拼英文） |
 * | `listening` | `options`（**`spelling` 一定要为空**，否则答案印在题面上） |
 * | `cloze` | `prompt`（挖空例句） `options` |
 *
 * ⚠️ `listening` 必须清空 `spelling` 与 `phonetic`：这个题型的全部难度就在于
 * "只给声音、不给字"。留一个词形在屏幕上，它就退化成了一道送分题。
 */
export interface VocabCard {
  wordId: string;
  type: VocabQuestionType;
  /**
   * 词形。`listening` 题型下为**空串**（见上方说明）——
   * 界面判断"要不要显示词形"必须看 `type`，不要看这个字段是否为空。
   */
  spelling: string;
  phonetic: string;
  difficulty: number;
  /** true = 今天的新词；false = 到期复习 */
  isNew: boolean;
  /** 四选一题型的选项；`spelling` 题型为空数组 */
  options: { key: OptionKey; text: string }[];
  /** `cloze` 的题面：把目标词挖成下划线后的例句 */
  prompt: string;
  /** `cloze` 的题面翻译（中文），可为空 */
  promptZh: string;
  /** `spelling` 的题面：该词的主释义 */
  senseText: string;
}

/** 作答后才会露出的词条全貌 */
export interface VocabWordDetail {
  wordId: string;
  spelling: string;
  phonetic: string;
  /** 英式音标；上游没给时为空串（界面只在有值时才显示美/英切换） */
  ukPhonetic: string;
  senses: VocabSense[];
  examples: VocabExample[];
  phrases: VocabPhrase[];
  mnemonic: string;
  difficulty: number;
  /** llm | curated —— 界面不得声称这是权威词典（见 schema.prisma 的说明） */
  source: string;
}

/** 今日学习记录（打卡日历的一行） */
export interface VocabDayLog {
  day: string;
  newCount: number;
  reviewCount: number;
  correctCount: number;
  wrongCount: number;
}

export interface VocabTodayResult {
  /** 当前词书；没有选中任何一本时为 null */
  book: { code: string; name: string } | null;
  /** true = 还没有词书（界面去选）；此时 `books` 一并返回，省一次请求 */
  needsBook: boolean;
  books: VocabBookItem[];
  /** 有词书但一个词都没有（词表还在灌）—— 如实说明，不要给一个空的学习页 */
  emptyReason: string;
  dailyNew: number;
  dailyReview: number;
  newCards: VocabCard[];
  reviewCards: VocabCard[];
  /** 今日累计（已作答的部分） */
  today: { newCount: number; reviewCount: number; correctCount: number; wrongCount: number };
  /** 全局累计 */
  totals: { learned: number; mastered: number; due: number };
}

export interface VocabAnswerResult {
  correct: boolean;
  /** 题型。回显它是因为客户端提交后要按同一套规则渲染反馈（填空题不给选项高亮） */
  type: VocabQuestionType;
  /** 正确项的 key（服务端算的，客户端只用来标出对错）。`spelling` 题型为空串 */
  answerKey: OptionKey | '';
  /** 正确答案原文。填空题 / 拼写题用它显示"你拼的是 xxx，正确是 yyy" */
  answerText: string;
  /** 本次提交的原文（服务端回显，避免客户端自己记着用户输入了什么） */
  submitted: string;
  /**
   * 差一点就对（编辑距离 ≤ 阈值）。只在 `spelling` / `cloze` 下可能为 true。
   *
   * ⚠️ 它**不等于** `correct`：拼错一个字母按"有点印象"评分（SM-2 通过线，
   * 但间隔涨得慢），不计入答对。这是刻意的 —— 拼写是四六级作文与翻译的基本功，
   * 把 `acess` 判成对，用户会一直拼错下去。
   */
  nearMiss: boolean;
  word: VocabWordDetail;
  /** 本次调度结果（界面显示"下次复习：3 天后"） */
  schedule: { intervalDays: number; dueDate: string; state: string };
  today: { newCount: number; reviewCount: number; correctCount: number; wrongCount: number };
  /** 今日剩余配额，用于"继续学"还是"今天到此为止" */
  remaining: { newLeft: number; reviewLeft: number };
}

export interface VocabStatsResult {
  book: { code: string; name: string } | null;
  /** 连续打卡天数（今天没学则从昨天往前数） */
  streak: number;
  totalLearned: number;
  mastered: number;
  dueToday: number;
  /** 正确率 0-100（没作答过时为 0，不是 100） */
  accuracy: number;
  /** 最近 N 天，**含没学的那几天**（缺的补零）—— 日历不能只有学过的日子 */
  calendar: VocabDayLog[];
}

/** 发音结果。走 JSON + base64 而不是二进制流：见 `vocab-audio.service.ts` 的说明 */
export interface VocabAudioResult {
  spelling: string;
  voice: string;
  /** mp3 | wav —— Mock 形态产出的是 WAV，客户端按它决定落盘扩展名 */
  format: string;
  audioBase64: string;
  /** 是否命中缓存（首次合成为 false） */
  cached: boolean;
  /** 产出方 provider 名（`mock-*` 即演示产物，界面必须如实标注） */
  provider: string;
}