/**
 * 多题型的**纯逻辑**：挑题型 / 组题面 / 判卷（无 IO —— 因为它必须可测）
 *
 * ## 为什么题型分配要"确定性"
 *
 * 与 `vocab-options.ts` 同源的问题：出题（`GET /vocab/today`）与判卷
 * （`POST /vocab/answer`）是**两次独立调用**，而正确答案只在服务端算。
 * 如果题型用 `Math.random()` 挑：出题时给了填空题、判卷时按选择题重算，
 * 于是"我明明拼对了却被判错"，而且刷新一下题型又变了 —— 极难复现。
 *
 * 所以题型同样**以词 id 为种子**：同一个词，永远是同一个题型。
 * 代价是"同一个词总考同一种能力"（见下方"轮换"一节怎么缓解），
 * 但换来的是"判卷与出题必然自洽"这条不能妥协的性质。
 *
 * ## 拿不到素材就换题型，**不硬凑**
 *
 * 听音辨词要音标、例句填空要带例句的词条 —— 词库里这两项的覆盖率并非 100%
 * （实测 22,313 词里英式音标 20,802、例句 18,710、词组 9,697）。
 * 缺素材时**降级到看词选义**（它的门槛最低，只要有一个释义），
 * 而不是出一道"题面空白"的题 —— 后者用户只能靠排除法猜，是在浪费他的时间。
 *
 * ## 轮换：同一个词在多次复习里会换题型
 *
 * 题型以 `(词 id, 复习轮次)` 为种子：同一个词、同一轮复习，永远是同一个题型
 * （出题与判卷必然自洽）；下一轮复习时种子变了，就会换成另一种考法
 * —— 这正是"不背单词/百词斩"那种"认识的词会越考越难"的手感，纯函数实现、不依赖状态。
 *
 * ## ⚠️ 光有纯函数不够：**同一轮里必须锁住**
 *
 * 纯函数种子 `repetitions` 有个致命细节：**每答一次它就变**（答对 +1、答错归零）。
 * 于是"同一个词在同一次学习里被重复提交"会**当场换题**：
 * 拼写 → 听音 → 填空 → 选义。表现是**"我拼错了再拼一遍，拼对了却判我错"**，
 * 因为服务端已经按新题型在判卷了。全程没有任何报错。
 *
 * 所以真正的规则是两句：
 *   ① 种子用 `repetitions`（复习轮次），**不是**累计作答次数（那样每提交一次就换题）；
 *   ② 题型在**当天第一次出题时定下来**，写进 `UserWordProgress.typeLock`，
 *      当天不再重算 —— 重试永远是同一道题。跨天时 `typeLockDay` 不匹配，才重新抽取。
 *
 * 两句缺一不可：只有 ① 会"答对后重试就换题"，只有 ② 就没有跨轮换的轮换手感。
 * 锁定与读取统一收口在 `VocabQuizService`，见那里的 `resolveType`。
 */

import type { OptionKey } from './vocab-options';
import { OPTION_KEYS, buildOptions, seedHash, type OptionSource } from './vocab-options';
import type { VocabPhrase, VocabQuestionType, VocabSense } from './dto/vocab.dto';

/** 题型枚举（与 DTO 里的取值表一一对应） */
export const QUESTION_TYPES: readonly VocabQuestionType[] = [
  'meaning',
  'spelling',
  'listening',
  'cloze',
];

/**
 * 一道题的**内部**形态（带答案）。
 *
 * 这是服务端的中间产物，**绝不原样下发给客户端** ——
 * 下发给客户端的是 `VocabQuizService` 里剥掉 `answer` 之后的 `VocabCard`。
 * 把"带答案"与"不带答案"做成两个类型，是为了让"不小心把答案发出去"
 * 变成**编译错误**而不是一次安全审计才发现的事故。
 */
export interface Question {
  type: VocabQuestionType;
  answer: string;
  answerKey: OptionKey | '';
  options: { key: OptionKey; text: string }[];
  prompt: string;
  promptZh: string;
  senseText: string;
}

/** 组题所需的一切素材（由 `VocabQuizService` 从词条行里抽出来） */
export interface QuestionSource {
  id: string;
  spelling: string;
  phonetic: string;
  ukPhonetic: string;
  senses: VocabSense[];
  examples: { en: string; zh: string }[];
  phrases: VocabPhrase[];
}

/**
 * 生成选项时**至少**要凑够几个。
 *
 * 与 `vocab-quiz.ts` 的 `MIN_OPTIONS` 是同一个判据（四选一少一个就不成题），
 * 但那个常量是"服务端装不下就丢掉这道题"，这里是在**组装阶段**就知道装不下、
 * 于是直接换题型 —— 能换出题就比丢掉强。
 */
export const MIN_OPTIONS = 4;

/** 缺素材时降级顺序：越靠前越"好考"（对素材要求越低） */
const FALLBACK_ORDER: readonly VocabQuestionType[] = ['meaning', 'cloze', 'listening', 'spelling'];

/**
 * 选题型。
 *
 * @param wordId 词 id（种子的一半）
 * @param round 复习轮次（种子的另一半）。**只在"当天第一次出题"时用**，
 *              已经锁过的词不会再走到这里（见文件头"同一轮里必须锁住"）。
 * @param src 素材（用来判断哪些题型出得了）
 */
export function pickType(wordId: string, round: number, src: QuestionSource): VocabQuestionType {
  const preferred = QUESTION_TYPES[seedHash(`${wordId}|${round}`) % QUESTION_TYPES.length] ?? 'meaning';
  if (canBuild(preferred, src)) return preferred;
  // 首选题型缺素材 → 按固定的降级顺序找第一个出得了的（顺序固定 = 结果可复现）
  return FALLBACK_ORDER.find((t) => canBuild(t, src)) ?? 'meaning';
}

/** 题型取值校验（库里的 `typeLock` 是字符串，读写都要收口，避免脏值进渲染） */
export function isQuestionType(v: unknown): v is VocabQuestionType {
  return typeof v === 'string' && (QUESTION_TYPES as readonly string[]).includes(v);
}

/** 该题型需要的素材是否齐备 */
export function canBuild(type: VocabQuestionType, src: QuestionSource): boolean {
  switch (type) {
    case 'meaning':
      return src.senses.length > 0;
    case 'spelling':
      // 拼写题的题面就是中文释义，缺了就只能给用户一个空白题面
      return src.senses.length > 0 && src.spelling.trim().length > 0;
    case 'listening':
      return hasPhonetic(src);
    case 'cloze':
      return findCloze(src) !== null;
  }
}

/** 有没有可用来朗读的音标（英式优先是给"英音模式"留的，见 audio service 的音色表） */
function hasPhonetic(src: QuestionSource): boolean {
  return Boolean(src.phonetic.trim() || src.ukPhonetic.trim());
}

/**
 * 找一条"能挖空"的例句。
 *
 * 判据是"例子里真的含有这个词**的某个变形**"：
 *   · 直接包含词形 —— `The data is readily **accessible**.`
 *   · 词形是句子里某个词的**词干**（access → accessible / accessibility）
 *
 * 第二种是必要的：词表里的例句大量使用派生形（`access` 的例句是 `accessible`），
 * 只按原词匹配会让绝大多数词条都"没有可用例句"，例句填空题整个失效 ——
 * 而且**不报错**，只是这个题型永远不出现。
 *
 * 匹配统一**转小写**（`Access` 与 `access` 是同一个词）。
 */
export function findCloze(src: QuestionSource): { en: string; zh: string; target: string } | null {
  const spelling = src.spelling.trim().toLowerCase();
  if (!spelling) return null;
  for (const ex of src.examples) {
    const target = matchInSentence(ex.en, spelling);
    if (target) return { en: ex.en, zh: ex.zh, target };
  }
  return null;
}

/**
 * 在句子里找出这个词（或其派生形）的**实际写法**；找不到返回 null
 */
function matchInSentence(sentence: string, spelling: string): string | null {
  // 词边界用 `\b`：否则 `art` 会匹配到 `start`，挖出一个莫名其妙的空
  const exact = new RegExp(`\\b${escapeRe(spelling)}\\b`, 'i').exec(sentence);
  if (exact) return exact[0];

  // ≥ 4 个字母才敢按前缀认（三个字母的词如 `art`/`car` 前缀匹配几乎必然误伤）
  if (spelling.length < 4) return null;
  // 后缀留到 12 个字母：`access` → `accessibility`（+7）、`nation` → `nationalization`（+9）
  // 这类派生在词表例句里很常见。留窄了会让例句填空题大面积失效且不报错。
  const loose = new RegExp(`\\b${escapeRe(spelling)}[a-z]{0,12}\\b`, 'i').exec(sentence);
  return loose ? loose[0] : null;
}

/** 正则元字符转义（词形含 `-` `.` `'` 的词条确实存在，如 `e-mail`、`o'clock`） */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把目标词挖成下划线。
 *
 * `target` 是**例句里的实际写法**（可能是 `accessible` 而不是 `access`），
 * 所以必须按它替换而不是按 `spelling` —— 否则例句原样返回，用户看到的是
 * 一道"没有空"的填空题。替换只做第一次（`replace` 传字符串时就是这个语义）。
 */
export function toClozePrompt(sentence: string, target: string): string {
  return sentence.replace(target, BLANK);
}

/** 空位的写法：连续下划线比 `___` 更像"一个空"，也更不容易和标点混在一起 */
export const BLANK = '______';

/**
 * 判卷（4 种题型的统一入口）。
 *
 * @param q 出题时生成的题（含答案）
 * @param submitted 客户端提交的原文（选择题是选项 key，其余是用户输入）
 */
export interface JudgeResult {
  correct: boolean;
  nearMiss: boolean;
}

export function judge(q: Question, submitted: string): JudgeResult {
  const given = normalize(submitted);
  if (q.type === 'spelling' || q.type === 'cloze') {
    // 拼写/填空按"字母"比对：大小写与首尾空格不该决定对错
    const expected = normalize(q.answer);
    if (given === expected) return { correct: true, nearMiss: false };
    return { correct: false, nearMiss: isNearMiss(given, expected) };
  }
  // 选择题按选项 key 比对（key 是 a~d，没有大小写歧义）
  return { correct: q.answerKey !== '' && submitted.trim() === q.answerKey, nearMiss: false };
}

/** 归一化：小写 + 去首尾空白 + 折叠内部连续空白（用户的输入法常带多余空格） */
function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * "差一点就对"的阈值：编辑距离 ≤ 1。
 *
 * 为什么是 1 而不是 2：双字母的差（`access` → `aces`）已经不属于"手滑"，
 * 而 4 个字母的词在距离 2 时几乎能命中一半的常见拼写错误 ——
 * 判得太宽，"差一点"这个提示就失去意义了。
 */
const NEAR_MISS_DISTANCE = 1;

function isNearMiss(given: string, expected: string): boolean {
  if (!given || !expected) return false;
  // 长度差超过阈值时，编辑距离必然也超过阈值 —— 先短路，省掉一次 O(n²) 计算
  if (Math.abs(given.length - expected.length) > NEAR_MISS_DISTANCE) return false;
  return editDistanceAtMost(given, expected, NEAR_MISS_DISTANCE);
}

/**
 * 编辑距离是否 ≤ 上限（Levenshtein，只问"有没有超过"而不算具体值）。
 *
 * 用滚动两行而不是完整矩阵：这里只需要一个布尔结果，
 * 而拼写题的输入最长 40 字符，完整矩阵没必要。
 *
 * 导出是为了让单测能直接钉边界（"一次替换/插入/删除在阈值内"），
 * 而**不是**给业务代码用的 —— 判卷只用 `judge`。
 */
export function editDistanceAtMost(a: string, b: string, limit: number): boolean {
  if (a === b) return true;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const { row, min } = nextRow(a, b, prev, i);
    // 整行都超过上限 → 后面只会更大，提前退出
    if (min > limit) return false;
    prev = row;
  }
  return (prev[b.length] ?? Number.MAX_SAFE_INTEGER) <= limit;
}

/**
 * 算一行编辑距离（Levenshtein 的动态规划转移）。
 *
 * 拆出来是为了让 `editDistanceAtMost` 的分支数留在红线内 ——
 * 而它本身也只是"一个双层循环里的一次取值"，拆开不影响可读性。
 *
 * @returns `row` 是本行结果，`min` 是本行最小值（供调用方提前退出）
 */
function nextRow(a: string, b: string, prev: number[], i: number): { row: number[]; min: number } {
  const row: number[] = [i];
  let min = i;
  for (let j = 1; j <= b.length; j += 1) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    const v = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    row.push(v);
    if (v < min) min = v;
  }
  return { row, min };
}

/**
 * 组装一道题。
 *
 * @param src 素材
 * @param type 题型（由 `pickType` 决定，调用方保证素材够）
 * @param pool 干扰项池（选择题用；拼写题的选项恒为空数组）
 */
export function buildQuestion(
  src: QuestionSource,
  type: VocabQuestionType,
  pool: OptionSource[],
): Question | null {
  switch (type) {
    case 'meaning':
      return buildMeaning(src, pool);
    case 'listening':
      return buildListening(src, pool);
    case 'cloze':
      return buildCloze(src, pool);
    case 'spelling':
      return buildSpelling(src);
  }
}

/** 看词选义：题面是词形，选项是**释义** */
function buildMeaning(src: QuestionSource, pool: OptionSource[]): Question | null {
  const meaning = src.senses[0]?.meaning;
  if (!meaning) return null;
  const built = buildOptions({ id: src.id, text: meaning }, pool);
  if (built.options.length < MIN_OPTIONS) return null;
  return {
    type: 'meaning',
    answer: meaning,
    answerKey: built.answerKey,
    options: built.options,
    prompt: '',
    promptZh: '',
    senseText: '',
  };
}

/**
 * 听音辨词：题面是**发音**，选项是**词形**。
 *
 * ⚠️ 池子里必须有别的词形 —— 而 `loadPool` 给的是 `OptionSource`，它的 `text`
 * 是**释义**（供看词选义用）。所以这里不能直接用池子，得由调用方传"词形池"。
 * 见 `VocabQuizService.loadSpellingPool`。
 */
function buildListening(src: QuestionSource, pool: OptionSource[]): Question | null {
  if (!hasPhonetic(src)) return null;
  const built = buildOptions({ id: src.id, text: src.spelling }, pool);
  if (built.options.length < MIN_OPTIONS) return null;
  return {
    type: 'listening',
    answer: src.spelling,
    answerKey: built.answerKey,
    options: built.options,
    prompt: '',
    promptZh: '',
    senseText: '',
  };
}

/** 例句填空：题面是挖空的例句，选项是**词形**（与听音辨词共用词形池） */
function buildCloze(src: QuestionSource, pool: OptionSource[]): Question | null {
  const hit = findCloze(src);
  if (!hit) return null;
  const built = buildOptions({ id: src.id, text: src.spelling }, pool);
  if (built.options.length < MIN_OPTIONS) return null;
  return {
    type: 'cloze',
    answer: src.spelling,
    answerKey: built.answerKey,
    options: built.options,
    prompt: toClozePrompt(hit.en, hit.target),
    promptZh: hit.zh,
    senseText: '',
  };
}

/**
 * 拼写：题面是中文释义，用户把词拼出来（**没有选项**，所以不需要池子）。
 *
 * 它是唯一一个"池子再小也出得了"的题型 —— 也正因如此，
 * `pickType` 的降级链把它放在最后：它最好出，但最难答。
 */
function buildSpelling(src: QuestionSource): Question | null {
  const meaning = src.senses[0]?.meaning;
  if (!meaning || !src.spelling.trim()) return null;
  return {
    type: 'spelling',
    answer: src.spelling,
    answerKey: '',
    options: [],
    prompt: '',
    promptZh: '',
    senseText: meaning,
  };
}

/** 供界面标签用的中文题型名（后端也用它拼反馈文案，避免两处各写一份） */
export const TYPE_LABELS: Record<VocabQuestionType, string> = {
  meaning: '看词选义',
  spelling: '看义拼词',
  listening: '听音辨词',
  cloze: '例句填空',
};

/** 选择题的选项 key 清单（透出给需要断言"四个都不同"的用例） */
export const ALL_OPTION_KEYS = OPTION_KEYS;
