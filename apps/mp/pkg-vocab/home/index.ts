/**
 * 记单词 · 首页（首页金刚区「记单词」的落点）
 *
 * 一个页面两种形态：
 *   `needsBook`（后端给的，或用户点了「换词书」）→ 词书列表
 *   否则 → 今日计划 + 开始学习
 *
 * ## 为什么选词书与今日计划在同一个页面
 *
 * 后端 `GET /vocab/today` 在"还没有词书"时会**把词书列表一并返回**
 * （见 `VocabTodayResult.books`）。合成一页就省掉了"先请求 today、发现没词书、
 * 再请求 books"这一串白闪；换词书时复用同一个请求，逻辑也仍然只有一条。
 *
 * ## 要算的东西都在这里算
 *
 * WXML 里不能调函数，所以百分比、进度文案、词书行的标签文字
 * 全部预计算成字符串 —— 页面只负责显示。
 */
import { vocabApi } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import type { VocabBookItem, VocabTodayResult } from '../../utils/api';

/** 词书列表的一行（文案已算好，WXML 直接渲染） */
interface BookRow {
  code: string;
  name: string;
  /** 分组用（见 groupBooks；未知值会落到「其他」） */
  category: string;
  descText: string;
  tagText: string;
  /** `planned` 的词表还没灌完 —— 可选性必须由后端的状态决定，前端不猜 */
  canSelect: boolean;
  /** 正在学的那本（渲染成主题色，与"可切换"的行区分开） */
  isActive: boolean;
  /** 右侧小字：词量。分组标题下用不到，但长列表里它是"这本有多少词"的唯一线索 */
  metaText: string;
}

/** 一个分组（分类标题 + 该分类下的词书） */
interface BookGroup {
  key: string;
  title: string;
  /** 该组词书数，用于标题右侧的计数 */
  count: number;
  books: BookRow[];
}

/**
 * 分类 code → 中文标题。
 *
 * ⚠️ **必须带兜底**：分类由数据（后端 `word_book.category`）决定，
 * 这里没列到的值**不能导致词书消失** —— 落到「其他」分组照样显示。
 * 写死成 switch 且无 else 的话，后端加一组新分类时
 * 那几本词书会**整个从界面上消失，且没有任何报错**。
 */
const CATEGORY_TITLES: Record<string, string> = {
  school: '教材同步',
  exam: '考试',
  abroad: '出国留学',
  career: '职业 / 商务',
  foundation: '基础入门',
};
/** 列表显示顺序（未列出的分类排在最后，见 groupBooks） */
const CATEGORY_ORDER = ['school', 'exam', 'abroad', 'career', 'foundation'];

Page({
  data: {
    loading: true,
    /** 至少成功拉到过一次数据（用来区分"首次骨架"与"后台刷新"） */
    loaded: false,
    error: '',
    /** true = 当前展示词书列表（后端说没词书，或用户点了「换词书」） */
    showBooks: false,
    /** 换词书时列表要现拉一次（today 有词书时不带 books），这是那次请求的状态 */
    loadingBooks: false,
    books: [] as BookRow[],
    /** 按分类分好组的词书（23 本平铺太长，分组才看得清） */
    bookGroups: [] as BookGroup[],
    bookName: '',
    queueNew: 0,
    queueReview: 0,
    due: 0,
    totalLearned: 0,
    mastered: 0,
    todayNew: 0,
    todayReview: 0,
    todayCorrect: 0,
    todayCount: 0,
    percent: 0,
    progressText: '',
    emptyReason: '',
    canStart: false,
    fxStyle: '',
  },

  onShow() {
    fxEnableTilt(this);
    // 从学习页返回时进度会变，所以每次显示都刷一遍；已有数据时不显示骨架
    void this.load(this.data.loaded);
  },

  onHide() {
    fxDisableTilt();
  },

  onUnload() {
    fxDisableTilt();
  },

  async load(silent: boolean) {
    if (!silent) this.setData({ loading: true });
    try {
      const res = await vocabApi.today();
      this.setData({ ...this.toView(res), error: '', loading: false, loaded: true });
    } catch (e) {
      this.setData({ error: (e as Error).message || '加载失败', loading: false });
    }
  },

  /** 后端响应 → 视图字段（所有文案在此算完） */
  toView(res: VocabTodayResult) {
    const target = Math.max(1, res.dailyNew + res.dailyReview);
    const done = res.today.newCount + res.today.reviewCount;
    const queueNew = res.newCards.length;
    const queueReview = res.reviewCards.length;

    return {
      showBooks: res.needsBook,
      books: res.books.map(toBookRow),
      bookGroups: groupBooks(res.books.map(toBookRow)),
      bookName: res.book?.name ?? '',
      queueNew,
      queueReview,
      due: res.totals.due,
      totalLearned: res.totals.learned,
      mastered: res.totals.mastered,
      todayNew: res.today.newCount,
      todayReview: res.today.reviewCount,
      todayCorrect: res.today.correctCount,
      todayCount: res.today.correctCount + res.today.wrongCount,
      percent: Math.min(100, Math.round((done / target) * 100)),
      progressText: `今日目标：新词 ${res.today.newCount}/${res.dailyNew} · 复习 ${res.today.reviewCount}/${res.dailyReview}`,
      emptyReason: res.emptyReason,
      canStart: queueNew + queueReview > 0,
    };
  },

  /**
   * 选词书（`planned` 的不给点，点了也只是白跑一次请求）。
   *
   * 选完**立刻回到今日计划**：这是"选定"而不是"浏览"，留在列表上会让人
   * 以为没生效而再点一次。`selectBook` 的响应就是更新后的完整列表，
   * 拿它刷新 `books` 之后 `load(true)` 会带回新的 today（含新词书身份与队列）。
   */
  async onSelect(e: WechatMiniprogram.TouchEvent) {
    const code = e.currentTarget.dataset.code as string;
    const row = this.data.books.find((b) => b.code === code);
    if (!row || !row.canSelect) return;

    try {
      const rows = (await vocabApi.selectBook(code)).map(toBookRow);
      this.setData({ books: rows, bookGroups: groupBooks(rows), showBooks: false });
      await this.load(true);
      wx.showToast({ title: `已切换到「${row.name}」`, icon: 'none' });
    } catch (err) {
      wx.showToast({ title: (err as Error).message || '选择失败', icon: 'none' });
    }
  },

  /** 开始学习；队列真的是空的就去统计页（而不是进一个空的学习页） */
  onStart() {
    const url = this.data.canStart ? '/pkg-vocab/study/index' : '/pkg-vocab/stats/index';
    wx.navigateTo({ url });
  },

  onStats() {
    wx.navigateTo({ url: '/pkg-vocab/stats/index' });
  },

  /**
   * 换词书。
   *
   * ⚠️ **不能只把 `showBooks` 置 true** —— `GET /vocab/today` 只在"还没有词书"时
   * 才把 `books` 一并返回（见 `VocabTodayResult.books`），有词书时那个数组是空的。
   * 直接切视图会得到一个**空列表 + 一个「取消」按钮**，用户看到的现象就是
   * 「选了六级之后再也回不去四级」。这里必须补一次 `GET /vocab/books`
   * （它本来就带"我的进度"），换书才是一条双向路。
   */
  async onSwitchBook() {
    this.setData({ showBooks: true, loadingBooks: true });
    try {
      const rows = (await vocabApi.books()).map(toBookRow);
      this.setData({ books: rows, bookGroups: groupBooks(rows), loadingBooks: false });
    } catch (err) {
      wx.showToast({ title: (err as Error).message || '词书列表加载失败', icon: 'none' });
      this.setData({ loadingBooks: false });
    }
  },

  /** 放弃换词书，回到今日计划（没有这一步的话「换词书」会是一条单向路） */
  onCancelSwitch() {
    this.setData({ showBooks: false });
  },

  onRetry(): Promise<void> {
    return this.load(false);
  },

  onPullDownRefresh() {
    void this.load(false).finally(() => wx.stopPullDownRefresh());
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

/** 词书行 → 展示行。`planned` 是"词表还没灌完"，必须说清而不是给个空词书 */
function toBookRow(book: VocabBookItem): BookRow {
  const canSelect = book.status === 'active';
  // 正在学的那本：文案给"正在学"，且**依然可点**（重复点等于一次幂等的确认，
  // 不置灰是因为"当前这本"与"可切换的那几本"共用同一行样式，置灰会让
  // 用户误以为整个列表都不可用）
  const tagText = book.isActive ? '正在学' : canSelect ? '选择' : '建设中';
  return {
    code: book.code,
    name: book.name,
    category: book.category,
    descText: canSelect
      ? `${book.wordCount} 词 · 已学 ${book.learned} · 待复习 ${book.due}`
      : `${book.desc || '词表还在建设中'}`,
    tagText,
    canSelect,
    isActive: book.isActive,
    metaText: canSelect ? `${book.wordCount} 词` : '',
  };
}

/**
 * 按分类分组（23 本平铺太长，分组才看得清）。
 *
 * ⚠️ **两条"不让人丢东西"的纪律**：
 *   ① 未知分类落到「其他」而不是被丢掉 —— 后端加一组新分类时，
 *      那几本词书**不能消失**（消失是静默的，没有任何报错）；
 *   ② 空分组不显示 —— 只挂个标题下面什么都没有，看起来像加载失败。
 */
function groupBooks(rows: BookRow[]): BookGroup[] {
  const buckets = new Map<string, BookRow[]>();
  for (const row of rows) {
    const key = row.category && CATEGORY_TITLES[row.category] ? row.category : 'other';
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
  }
  const ordered = [
    ...CATEGORY_ORDER.filter((k) => buckets.has(k)),
    // 未知分类（含 'other'）统一排到最后
    ...[...buckets.keys()].filter((k) => !CATEGORY_ORDER.includes(k)),
  ];
  return ordered
    .filter((k) => (buckets.get(k)?.length ?? 0) > 0)
    .map((k) => ({
      key: k,
      title: CATEGORY_TITLES[k] ?? '其他',
      count: buckets.get(k)?.length ?? 0,
      books: buckets.get(k) ?? [],
    }));
}