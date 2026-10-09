/**
 * 练习中心 · 题面渲染（把后端卡片翻译成"这一屏长什么样"）
 *
 * ## 为什么单独成文件
 *
 * 三种模块 × 五种模式的字段组合差异很大，判断逻辑放在页面里会把
 * `session/index.ts` 顶到 300 行上限之外。更重要的是：**这些判断都是纯函数**，
 * 拆出来能单独测（页面文件在 vitest 里跑不起来）。
 *
 * ## ⭐ 渲染形态由服务端给的 `mode` 决定，不由模块猜
 *
 * `chunks`（连词成句）要显示砖块；`recall`（中译英）**不能**显示英文；
 * `speak`（口语）**必须**显示英文。三种模式的差别全压在 `mode` 这一个值上。
 *
 * ⚠️ 界面**不要**按"这个模块大概是哪种模式"来渲染 —— 猜错的表现是
 * "中译英页面上直接显示了英文答案"（等于送分）或"连词成句的砖块是空的"
 * （没法答），**两者都不报错**。
 */
import type { PracticeMode, PracticeSubmitResult, SentenceCard, TopicCard } from './practice-types';

/** 题面形态（界面按它切换整块布局） */
export type ViewKind = 'chunks' | 'recall' | 'listen' | 'speak' | 'write' | 'unknown';

/** 显示用的砖块（**已打乱**，见 shuffleChunks） */
export interface ChunkView {
  /** 打乱后的稳定下标 —— 用来标记"这块被点过了" */
  idx: number;
  en: string;
  zh: string;
}

export interface CardView {
  kind: ViewKind;
  /** 题面提示（说清"这一题要你做什么"） */
  hint: string;
  /** 要不要显示目标英文句 */
  showEn: boolean;
  /** 要不要显示语块（连词成句） */
  showChunks: boolean;
  /** 要不要显示录音按钮（口语） */
  showRecorder: boolean;
  /** 要不要显示音频播放（听写） */
  showSpeaker: boolean;
  /** 要不要显示"显示答案/我读完了"的求救按钮 */
  showReveal: boolean;
}

/**
 * 模式 → 渲染形态。
 *
 * ⚠️ **不认识的模式必须落到 `unknown`** 而不是抛错或当默认值：
 * 后端加一种新模式时，界面要给一句"这个题型暂不支持"，
 * 而不是渲染成空白页（空白是**没有任何报错**的失效）。
 *
 * 实现上按"判别字段表"组织而不是长 switch：五个模式的差别只有
 * 「显示英文 / 显示砖块 / 显示录音 / 显示喇叭 / 显示看答案」这五面旗，
 * 写成表之后加一种模式只需要加一行，也不会漏掉某一面旗（漏了就是静默失效）。
 */
export function viewOf(mode: PracticeMode): CardView {
  const shape = SHAPES[mode];
  if (!shape) return UNKNOWN_VIEW;
  return { kind: mode as ViewKind, ...shape };
}

/** 每个模式的"五面旗" */
const SHAPES: Record<
  string,
  Omit<CardView, 'kind'>
> = {
  // 连词成句：给砖块。`showEn` 只用于答完后对照，题面上不给
  chunks: {
    hint: '把下面的词块排成一句话',
    showEn: false,
    showChunks: true,
    showRecorder: false,
    showSpeaker: false,
    showReveal: true,
  },
  // ⚠️ 中译英**不给英文**：给了就等于把答案印在题面上
  recall: {
    hint: '看中文，写出英文',
    showEn: false,
    showChunks: false,
    showRecorder: false,
    showSpeaker: false,
    showReveal: false,
  },
  // 听写：音频就是题面，不能给文本
  listen: {
    hint: '听音频，写出你听到的句子',
    showEn: false,
    showChunks: false,
    showRecorder: false,
    showSpeaker: true,
    showReveal: false,
  },
  // ⚠️ 口语跟读**必须**给英文：屏幕上没句子就无从开口
  speak: {
    hint: '照着句子读出来，读对 60% 就过关',
    showEn: true,
    showChunks: false,
    showRecorder: true,
    showSpeaker: true,
    showReveal: false,
  },
  write: {
    hint: '按提纲写一篇作文',
    showEn: false,
    showChunks: false,
    showRecorder: false,
    showSpeaker: false,
    showReveal: false,
  },
};

const UNKNOWN_VIEW: CardView = {
  kind: 'unknown',
  hint: '这个题型暂时还不支持',
  showEn: false,
  showChunks: false,
  showRecorder: false,
  showSpeaker: false,
  showReveal: false,
};

/** 模式 → 中文名（与后端 `MODE_TITLES` 同文案；界面切题面的按钮用） */
export function modeTitle(mode: string): string {
  switch (mode) {
    case 'chunks':
      return '连词成句';
    case 'recall':
      return '中译英';
    case 'listen':
      return '听写';
    case 'speak':
      return '跟读';
    case 'write':
      return '写作';
    default:
      return mode;
  }
}

/** "下次什么时候再见"。答错的间隔一律 1 天（见 `@qz/core` 的 sm2.ts） */
export function nextTipOf(intervalDays: number): string {
  if (intervalDays <= 1) return '明天还会再见到它';
  return `${intervalDays} 天后复习`;
}

/**
 * 打乱语块顺序。
 *
 * ## ⚠️ 这里**故意不用** `Math.random()`
 *
 * 两个原因：
 * ① 同一题在"答错 → 重做"之间重新随机，砖块顺序变了会让人以为换了道题；
 * ② `sort(() => Math.random() - 0.5)` 是有偏的（比较函数不满足传递性），
 *    而且**永不报错** —— 看不出偏，就一直偏着。
 *
 * 这里用句子自身的 id 做种子的**确定性洗牌**（Fisher–Yates + xorshift）：
 * 同一句话每次进来顺序一样，不同句子顺序不同。
 */
export function shuffleChunks(card: SentenceCard): ChunkView[] {
  const src = card.chunks ?? [];
  const arr = src.map((c, i) => ({ idx: i, en: c.en, zh: c.zh }));
  if (arr.length < 2) return arr;

  let seed = hashSeed(card.id);
  // Fisher–Yates，随机源是确定性的 xorshift32
  for (let i = arr.length - 1; i > 0; i -= 1) {
    seed = xorshift32(seed);
    const j = seed % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  // ⚠️ 洗完可能恰好还是原序（概率 1/n!，n=2 时是 50%）——
  // 那就**再洗一次**，否则用户看到"打乱后和原句一模一样"会以为功能坏了
  if (isOriginalOrder(arr, src.map((c) => c.en)) && arr.length > 1) {
    arr.push(arr.shift() as ChunkView);
  }
  return arr;
}

/** 洗完之后是不是还没打乱（与原始顺序逐位相同） */
function isOriginalOrder(arr: ChunkView[], origin: string[]): boolean {
  return arr.every((c, i) => c.en === origin[i]);
}

/** djb2：把 uuid 折成一个 32 位种子 */
function hashSeed(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h || 1;
}

/** xorshift32 —— 确定性、分布好、三行写完 */
function xorshift32(x: number): number {
  let v = x >>> 0;
  v ^= v << 13;
  v >>>= 0;
  v ^= v >> 17;
  v ^= v << 5;
  return v >>> 0;
}

/** 作文题面 → 显示行（提纲逐条加序号，WXML 里不能算） */
export interface OutlineRow {
  no: number;
  text: string;
}

export function toOutlineRows(topics: TopicCard[]): OutlineRow[] {
  const t = topics[0];
  if (!t) return [];
  return t.outline.map((text, i) => ({ no: i + 1, text }));
}

/** 作答后高亮用的逐词行（样式类在 TS 里算好，WXML 不能调函数） */
export interface WordRow {
  word: string;
  cls: string;
}

/**
 * 摆一题时的公共外壳（每组题目都要写的那几项）。
 *
 * ⚠️ 与 `baseOf` 分开是因为作文题的题面字段与句子题**完全不相交**：
 * 硬塞进一个函数只会让两边都出现一堆用不上的条件分支。
 */
export interface SlotBase {
  idx: number;
  sentenceId: string;
  en: string;
  zh: string;
  showEn: boolean;
  showChunks: boolean;
  showRecorder: boolean;
  showSpeaker: boolean;
  showReveal: boolean;
}

/**
 * 句子卡 → 题面字段。
 *
 * ⚠️ `en` 可能是 `null`（`recall` 模式后端刻意不下发）—— 兜一句假文案
 * （如"（读出来）"）会让"忘了隐藏答案"这类回归**变得看不出来**，
 * 所以这里如实留空，由 `showEn` 决定显不显示。
 */
export function baseOf(i: number, card: SentenceCard, view: CardView): SlotBase {
  return {
    idx: i,
    sentenceId: card.id,
    en: card.en ?? '',
    zh: card.zh,
    showEn: view.showEn && Boolean(card.en),
    // 砖块要有内容才显示，否则留一个空框（点不了，也不报错）
    showChunks: view.showChunks && (card.chunks?.length ?? 0) > 0,
    showRecorder: view.showRecorder,
    showSpeaker: view.showSpeaker,
    showReveal: view.showReveal,
  };
}

/** 作文题 → 题面字段（与 `baseOf` 同形状，便于共用一套 `setData` 写法） */
export function topicBaseOf(i: number, topic: TopicCard): SlotBase {
  return {
    idx: i,
    sentenceId: topic.id,
    en: '',
    zh: '',
    showEn: false,
    showChunks: false,
    showRecorder: false,
    showSpeaker: false,
    showReveal: false,
  };
}

/** 一块砖被点/取消点击之后的新选中集与拼句结果 */
export function toggleChunk(
  pickedIdx: number[],
  chunks: ChunkView[],
  idx: number,
): { pickedIdx: number[]; assembled: string } {
  const picked = pickedIdx.includes(idx)
    ? pickedIdx.filter((x) => x !== idx)
    : [...pickedIdx, idx];
  return {
    pickedIdx: picked,
    assembled: picked
      .map((i) => chunks[i]?.en ?? '')
      .filter(Boolean)
      .join(' '),
  };
}

/**
 * 批量刷新的"外壳"字段 —— 重新取一批题时要清的历史痕迹。
 *
 * 与 `RESET_ANSWER` 分开：这一组是**队列级**（换了一批题），
 * 那一组是**题目级**（换了一题）。
 */
export function batchShell(res: {
  mode: string;
  modes: string[];
}): {
  mode: string;
  modeText: string;
  modes: string[];
  modeTabs: { mode: string; title: string; on: boolean }[];
  loading: boolean;
  error: string;
  finished: boolean;
  passCount: number;
} {
  return {
    mode: res.mode,
    // ⚠️ 顶部那行进度条右侧显示的是**这个**，不是 `mode`。
    //    服务端给的是 `chunks`/`recall` 这类枚举值 —— 直接渲染会在界面上
    //    露出一个英文单词（截图里就是这么被发现的），而**没有任何报错**。
    modeText: modeTitle(res.mode),
    modes: res.modes,
    modeTabs: res.modes.map((m) => ({ mode: m, title: modeTitle(m), on: m === res.mode })),
    loading: false,
    error: '',
    finished: false,
    passCount: 0,
  };
}

/** 逐词对齐结果 → 高亮行（对/错两种样式类，WXML 不能判断） */
export function toWordRows(words: { word: string; ok: boolean }[]): WordRow[] {
  return words.map((w) => ({ word: w.word, cls: w.ok ? 'sess-word-ok' : 'sess-word-no' }));
}

/** 作答结果里"逐词对齐 + 作文批改"这两块的视图字段 */
export function buildReviewFields(res: PracticeSubmitResult) {
  return {
    showReview: Boolean(res.review),
    reviewTotal: res.review?.total ?? 0,
    reviewDegraded: res.review?.degradedReason ?? '',
    dimensions: res.review?.dimensions ?? [],
    sample: res.review?.sample ?? '',
    sampleZh: res.review?.zhBrief ?? '',
  };
}

/** 词数统计（与后端 `countWords` 同口径：按空白切分后数非空段） */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * 作答反馈的一句话。
 *
 * ⚠️ 三档门槛不同，文案也**必须不同**，否则用户会拿句子的"全对"标准
 * 去要求口语（"我读了 80% 怎么没过"）。
 */
export function feedbackText(kind: ViewKind, pass: boolean, score: number, needScore: number): string {
  if (pass) {
    if (kind === 'speak') return `过关！准确率 ${score}%`;
    if (kind === 'write') return '写完了，看看批改意见';
    return '全对，这句拿下了';
  }
  if (kind === 'speak') {
    return `准确率 ${score}%，还差 ${needScore}%。放慢一点，把每个词都读清楚`;
  }
  if (kind === 'write') return '这次还不算完成，看看下面的建议';
  return `还差一点，正确率 ${score}%`;
}

/**
 * 每换一题都要清掉的作答状态。
 *
 * ⚠️ **写成常量而不是在 `show()` 里逐个写一遍**：漏清某一项会让它**串到下一题**
 * （上一题的批改意见/范文出现在下一题下面），而这类串场**不会有任何报错**。
 * 集中一处之后，"新增一个作答字段"就只会忘在同一个地方。
 */
export const RESET_ANSWER = {
  answered: false,
  pass: false,
  score: 0,
  feedback: '',
  words: [] as { word: string; cls: string }[],
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
  revealed: false,
};
