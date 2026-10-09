import { z } from 'zod';

/**
 * 练习中心（句子 / 口语 / 作文）共享契约与纯逻辑（任务清单 M4-16）
 *
 * 单独成文件而不是塞进 `validators/index.ts`：那份贴着 300 行红线（理由同 `vocab.ts`）。
 * 由 `validators/index.ts` 统一 `export *` 转出。
 *
 * ## 为什么把"评分"放在 `@qz/core` 而不是后端 service
 *
 * 三个理由，缺一不可：
 *
 * ① **后端与小程序要算同一个值。** 小程序要在录音结束后**立刻**给出
 *    "这句读得怎么样"的反馈（网络没回来之前），所以它本地也要跑一遍评分。
 *    两端各写一份必然分叉 —— 表现是"小程序说 62 分过了、服务端说 58 分没过"。
 *
 * ② **纯函数才能穷举测试。** 评分是"给定目标句 + 识别文本 → 0~100 分"，
 *    没有任何 IO。放在 service 里就要起 Nest 容器、mock 一堆依赖才能测，
 *    而这类边界（全对 / 全错 / 差一个词 / 多一个词）**恰恰是最该穷举的**。
 *
 * ③ **阈值必须只有一处。** 60% 这个数字会出现在：门槛判定、界面文案
 *    （"还需再对 3 个词"）、统计口径、端到端断言。写四遍迟早有一遍忘了改。
 */

/* ==================== 模块与模式 ==================== */

/** 三个练习模块（词汇不在此列 —— 它有自己的 `vocab` 模块） */
export const PRACTICE_MODULES = ['sentence', 'speak', 'write'] as const;
export type PracticeModule = (typeof PRACTICE_MODULES)[number];

/**
 * 练习模式（"同一句话可以怎么练"）。
 *
 * 借鉴句乐部的六模式，但**按本项目的实际能力收敛到五种**：
 * 少了"视频观看"（没有视频素材源）与"阅读全文"（单句素材没有"全文"概念）。
 * 多了一个 `speak`（口语跟读）—— 那是本次需求明确要求的。
 *
 * ⚠️ **不要凭这个名字推断它属于哪个模块**：`chunks` 与 `recall` 都属于句子模块，
 * 是同一句话的两种难度。模块归属见 `MODES_BY_MODULE`。
 */
export const PRACTICE_MODES = ['chunks', 'recall', 'listen', 'speak', 'write'] as const;
export type PracticeMode = (typeof PRACTICE_MODES)[number];

/** 每个模块可用的模式（**顺序即推荐顺序**，界面按它排） */
export const MODES_BY_MODULE: Record<PracticeModule, readonly PracticeMode[]> = {
  // 连词成句（给砖块，拼出整句）→ 中译英（给中文，自己写）→ 听写（给声音，自己写）
  sentence: ['chunks', 'recall', 'listen'],
  // 口语只有一种练法：看着句子读出来，ASR 打分
  speak: ['speak'],
  // 作文：给题目与提纲，写整篇
  write: ['write'],
};

export function isPracticeMode(v: unknown): v is PracticeMode {
  return typeof v === 'string' && (PRACTICE_MODES as readonly string[]).includes(v);
}

/**
 * 模块 → 中文名。
 *
 * ⚠️ 与 `MODE_TITLES` 同一条理由放 core（后端返回"今天练什么"时要用这个文案），
 * 另外还有一层：**"句子练习"这个模块名会和模式名混淆** ——
 * 模块叫"句子练习"，模式里有"连词成句""中译英""听写"。
 * 分散在两处时，界面上很容易出现"句子练习 / 句子练习"这种读不懂的组合。
 */
export const PRACTICE_MODULE_TITLES: Record<PracticeModule, string> = {
  sentence: '句子练习',
  speak: '口语跟读',
  write: '作文练习',
};

/**
 * 模块 → 一句话说明（入口卡片的副标题）。
 *
 * 写进 core 而不是界面：这句文案要同时出现在小程序的入口卡片、
 * 今日空态提示与助手的回复里，三处各写一份必然分叉。
 */
export const PRACTICE_MODULE_HINTS: Record<PracticeModule, string> = {
  sentence: '连词成句 · 中译英 · 听写，四六级高频句',
  speak: '看句朗读，读对 60% 就过关',
  write: '四六级作文提纲 + 多维批改 + 范文',
};

/**
 * 模块的**推荐学习顺序**（界面按它排，也是"先输入后输出"的落点）。
 *
 * 为什么句 → 口 → 文：句子练习给的是"能看见答案的输入与校对"（连词成句有砖块、
 * 中译英有中文），口语是"开口输出但只有一句话"，作文是"整段输出"。
 * 按这个顺序，前面每一步都在给后面铺能力；反过来先写作文会让人无从下手。
 *
 * ⚠️ 放 core 而不是各端各写一份：今日总览、练习中心的入口卡片、
 * 助手的"今天练什么"三处都要按这个顺序排，抄三份必然有一份顺序不同。
 */
export const PRACTICE_MODULE_ORDER: readonly PracticeModule[] = ['sentence', 'speak', 'write'];

/**
 * 模式 → 中文名。
 *
 * ⚠️ 放 core 而不是小程序：后端在返回"今天练什么"时也要用这个文案
 * （如空队列提示"今天的听写已经练完了"）。两处各写一份会出现
 * "后端说'中译英'、界面显示'拼写'"这种对不上的文案。
 */
export const MODE_TITLES: Record<PracticeMode, string> = {
  chunks: '连词成句',
  recall: '中译英',
  listen: '听写',
  speak: '口语跟读',
  write: '作文',
};

/* ==================== 口语门槛 ==================== */

/**
 * 口语过关线：**准确率 ≥ 60%**（产品需求明确指定）。
 *
 * ⚠️ 用"准确率"而不是"读对了几个词"：句子有长有短，8 个词的句子对 5 个
 * 与 16 个词的句子对 9 个，哪个更好？只有比例能比。
 *
 * ⚠️ 60% 是**刻意偏低**的。本项目用的是通用 ASR（不是发音评测引擎），
 * 它对"口音重但内容对"的容忍度不可控。门槛定高会让大量"其实读得不错"
 * 的人卡住，而那类挫败感**没有任何补偿机制**（用户不知道自己错在哪）。
 * 定 60% 的取舍是：宁可放过几个读得不标准的，也不要把人拦在门口。
 * 上线后若有真实数据（通过率 < 50%），这个数字应当按数据调整 —— 所以
 * 它是**常量而不是散落在各处的字面量**。
 */
export const SPEAK_PASS_SCORE = 60;

/**
 * 词级对齐：把"目标句"与"识别到的文本"按词比。
 *
 * ## 算法：先归一化，再按位置对齐，允许一次"跳词"补偿
 *
 * 归一化：小写、去标点、去多余空白、**展开常见缩写**（`it's` → `it is`）。
 * 缩写展开是必须的：ASR 几乎总是把 `I'm` 转成 `I am`，
 * 不展开的话"读得完全正确"会莫名丢掉一个词（实测过，一次丢 8%）。
 *
 * 对齐：逐位比较，**错位时看下一位能不能对上**（识别多词/漏词造成的错位）。
 * 这是简化版的编辑距离，但**不做完整动态规划** —— 目标只是给一个
 * 稳定的分数与"哪个词没读对"的定位，不需要最优对齐。
 *
 * ## 返回值为什么带 `detail`
 *
 * 界面要显示"time 没读对、management 漏了"，只给一个分数的话
 * 用户**只能反复重读全句**（这是最让人放弃的反馈方式）。
 */
export interface SpeakWordResult {
  /** 目标句里的词（原形，用于展示） */
  word: string;
  /** 是否命中 */
  ok: boolean;
}

export interface SpeakScore {
  /** 0~100 的准确率（= 命中词数 / 目标词数） */
  score: number;
  /** 命中词数 */
  hit: number;
  /** 目标句词数 */
  total: number;
  /** 逐词结果，界面用它标出"哪个词没读对" */
  detail: SpeakWordResult[];
  /** 是否达标（`score >= SPEAK_PASS_SCORE`） */
  passed: boolean;
}

/** 常见缩写 → 展开形式。ASR 的输出与目标句在这上面几乎必然不一致 */
const CONTRACTIONS: Record<string, string> = {
  "i'm": 'i am',
  "i've": 'i have',
  "i'll": 'i will',
  "i'd": 'i would',
  "you're": 'you are',
  "you've": 'you have',
  "you'll": 'you will',
  "we're": 'we are',
  "we've": 'we have',
  "we'll": 'we will',
  "they're": 'they are',
  "they've": 'they have',
  "they'll": 'they will',
  "he's": 'he is',
  "she's": 'she is',
  "it's": 'it is',
  "that's": 'that is',
  "there's": 'there is',
  "what's": 'what is',
  "let's": 'let us',
  "don't": 'do not',
  "doesn't": 'does not',
  "didn't": 'did not',
  "isn't": 'is not',
  "aren't": 'are not',
  "wasn't": 'was not',
  "weren't": 'were not',
  "can't": 'can not',
  "cannot": 'can not',
  "couldn't": 'could not',
  "won't": 'will not',
  "wouldn't": 'would not',
  "shouldn't": 'should not',
  "haven't": 'have not',
  "hasn't": 'has not',
  "hadn't": 'had not',
};

/**
 * 归一化成词数组（**导出是为了让测试能直接断言分词结果**）。
 *
 * ⚠️ 去标点用 `[^a-z0-9' ]` 而不是 `\W`：`\W` 在 JS 里**保留下划线**，
 * 而 `_` 在英文句子里几乎总是噪声；同时 `'` 必须留着（否则缩写先被打散，
 * 展开表就永远命中不了）。
 */
export function normalizeWords(text: string): string[] {
  const flat = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return [];
  const out: string[] = [];
  for (const raw of flat.split(' ')) {
    const expanded = CONTRACTIONS[raw];
    if (expanded) out.push(...expanded.split(' '));
    else out.push(raw);
  }
  return out;
}

/**
 * 给一句朗读打分。
 *
 * @param target 目标句（英文原句）
 * @param said   ASR 识别到的文本（可能为空 —— 没听清/没说话）
 *
 * ⚠️ **`said` 为空时返回 0 分而不是"跳过"**：用户按了录音但没出声，
 * 必须如实告诉他"没识别到内容"，而不是给一个中性分。
 * 给中性分会让"什么都不做"和"读了一半"看起来一样。
 */
export function scoreSpoken(target: string, said: string): SpeakScore {
  const want = normalizeWords(target);
  const got = normalizeWords(said);
  const total = want.length;
  if (total === 0) {
    return { score: 0, hit: 0, total: 0, detail: [], passed: false };
  }
  if (got.length === 0) {
    return {
      score: 0,
      hit: 0,
      total,
      detail: want.map((word) => ({ word, ok: false })),
      passed: false,
    };
  }

  const used = new Array<boolean>(got.length).fill(false);
  const detail: SpeakWordResult[] = [];
  let gi = 0;
  for (const word of want) {
    let ok = false;
    // 先看当前位置；不对再"跳过识别里多出来的词"看下一位（漏词/多词的错位补偿）
    if (gi < got.length && got[gi] === word) {
      used[gi] = true;
      gi += 1;
      ok = true;
    } else if (gi + 1 < got.length && got[gi + 1] === word) {
      gi += 2;
      ok = true;
    } else if (gi >= got.length) {
      ok = false;
    }
    detail.push({ word, ok });
  }

  const hit = detail.filter((d) => d.ok).length;
  // 四舍五入：62.5% 显示 63% 而不是 62%（界面与判定用同一个值，避免
  // "显示 60% 却判不过"这种看起来像 bug 的现象）
  const score = Math.round((hit / total) * 100);
  return { score, hit, total, detail, passed: score >= SPEAK_PASS_SCORE };
}

/* ==================== 句子题判定 ==================== */

/** 句子题（连词成句 / 中译英 / 听写）的判定结果 */
export interface SentenceVerdict {
  /** 是否算通过（完全正确才通过 —— 句子题不像口语有"部分正确"的概念） */
  correct: boolean;
  /** 0~100（按命中词比例，用于"这次比上次好"的反馈） */
  score: number;
  /** 逐词对比，界面用它高亮差异 */
  detail: SpeakWordResult[];
}

/**
 * 判一句"用户拼出来的英文"对不对。
 *
 * ## 与口语评分**共用**归一化与对齐（不重复实现）
 *
 * 差别只有一个：句子题**必须完全正确**才算过，口语 60% 就算过。
 * 这个差别是刻意的 —— 打字/拼写没有"口音"这种客观噪声，
 * 拼错就是拼错；而朗读有。
 *
 * ⚠️ 因此这里复用了 `scoreSpoken` 的实现，只把 `passed` 换成 `correct = hit === total`。
 * 抄一份"句子专用对齐"出来的结果是：两边的缩写展开表会慢慢分叉。
 */
export function judgeSentence(target: string, submitted: string): SentenceVerdict {
  const s = scoreSpoken(target, submitted);
  return { correct: s.total > 0 && s.hit === s.total, score: s.score, detail: s.detail };
}

/* ==================== 作文批改 ==================== */

/**
 * 作文批改的四个维度（**权重合计 100**）。
 *
 * ⚠️ 借鉴"不背单词 / 百词斩"的作文批改呈现方式，但**维度是自己定的**：
 * 它们用的是商业评分引擎，这里用 LLM，能给的只有"内容 / 结构 / 语言 / 词汇"
 * 这四个可解释的维度。**不承诺"等同官方评分标准"** —— 那需要人工标注校准，
 * 本项目没有那个数据，写出来就是虚假承诺。
 *
 * ⚠️ 权重合计必须是 100（有单测钉住）。曾出现过"匹配权重合计 105"的同类问题，
 * 当时的表现是"总分偶尔超过 100"，而**没有任何一处报错**。
 */
export const WRITE_DIMENSIONS = [
  { key: 'content', title: '内容', weight: 35, desc: '是否切题、论点是否完整' },
  { key: 'structure', title: '结构', weight: 25, desc: '段落划分与衔接是否清晰' },
  { key: 'language', title: '语言', weight: 25, desc: '语法与句式是否正确' },
  { key: 'vocabulary', title: '词汇', weight: 15, desc: '用词是否准确、有变化' },
] as const;
export type WriteDimensionKey = (typeof WRITE_DIMENSIONS)[number]['key'];

/** 作文长度下限（词数）—— 低于它就只提示"太短"，不进入批改 */
export const WRITE_MIN_WORDS = 80;

/** 统计词数（与 `normalizeWords` 同口径：缩写算两个词，与四六级阅卷一致） */
export function countWords(text: string): number {
  return normalizeWords(text).length;
}

/**
 * 作文批改结果的折算。
 *
 * 各维度给 0~100 的分，**按权重加权**得到总分。
 * 用加权而不是取平均：内容与结构比词汇重要（四六级阅卷的实际倾向）。
 */
export function weightedWriteScore(scores: Record<WriteDimensionKey, number>): number {
  let sum = 0;
  for (const d of WRITE_DIMENSIONS) {
    const v = Math.max(0, Math.min(100, Number(scores[d.key]) || 0));
    sum += (v * d.weight) / 100;
  }
  return Math.round(sum);
}

/* ==================== 校验（HTTP 入参） ==================== */

/** 今日练习队列（`?module=sentence|speak|write` 可选） */
export const PracticeQueueQuerySchema = z.object({
  module: z.enum(PRACTICE_MODULES).optional(),
  level: z.coerce.number().int().min(1).max(3).optional(),
});
export type PracticeQueueQueryDto = z.infer<typeof PracticeQueueQuerySchema>;

/**
 * 提交一次练习。
 *
 * ⚠️ **不传"我过了"** —— 与词汇模块同一条纪律（见 `vocab.ts` 的说明）：
 * 让客户端上报对错，抓包改一个字段就能把 SM-2 的调度刷成任意形状。
 * 口语的 `score` 同理**不由客户端传**，服务端自己跑 ASR 与评分。
 */
export const PracticeSubmitSchema = z.object({
  /** 句子 id（kind=sentence）或作文题 id（kind=write） */
  refId: z.string().min(1).max(36),
  module: z.enum(PRACTICE_MODULES),
  /** `chunks` / `recall` / `listen` 提交拼出的英文；`write` 提交全文 */
  text: z.string().max(4000).optional(),
  /**
   * 口语：录音文件的 base64（不带 data: 前缀）。
   *
   * ⚠️ 上限 2MB（base64 后）：小程序 `wx.getRecorderManager` 默认录 60s 的
   * mp3 约 500KB，base64 膨胀 4/3 → 约 670KB。给 2MB 的余量是为了
   * "用户忘了停、录了 2 分钟"这类情况仍有明确报错，而不是被网关静默截断。
   */
  audioBase64: z.string().max(2_800_000).optional(),
  /** 口语录音格式（小程序给的是 mp3；白名单外一律拒） */
  audioFormat: z.enum(['mp3', 'aac', 'wav', 'm4a']).optional(),
  /** 用时（毫秒），仅用于展示"这次比上次快" */
  elapsedMs: z.number().int().min(0).max(3_600_000).optional(),
});
export type PracticeSubmitDto = z.infer<typeof PracticeSubmitSchema>;

/** 练习统计（与词汇统计分开，模块维度不同） */
export const PracticeStatsQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(90).default(30),
});
export type PracticeStatsQueryDto = z.infer<typeof PracticeStatsQuerySchema>;

/**
 * 句子朗读音频（听写模式与口语跟读的"范读"）。
 *
 * ## 为什么单独定义一个 schema 而不复用 `VocabAudioQuerySchema`
 *
 * 那个只有 `voice`。句子朗读需要 `speed` —— 听写模式的"先慢听再正常"
 * 是句乐部三阶段的核心，单词发音没有这个需求。
 *
 * ⚠️ 加进复用的那个 schema 会让单词发音接口也多出 `speed` 参数，
 * 而它下游的 TTS 缓存键里**没有语速**，于是"传了 speed 但没生效" ——
 * 一个改不动的参数比没有参数更糟。所以两个接口各自持有一份。
 */
export const PracticeAudioQuerySchema = z.object({
  voice: z.string().max(40).optional(),
  /**
   * 语速（0.5~2.0）。
   *
   * ⚠️ 上限与下限都在这里夹死，不靠客户端自觉：上游引擎对越界值
   * 有些会静默回落到默认语速（音频能播但不慢），用户点"慢速"发现没变化
   * 会以为按钮坏了。
   */
  speed: z.coerce.number().min(0.5).max(2).optional(),
});
export type PracticeAudioQueryDto = z.infer<typeof PracticeAudioQuerySchema>;
