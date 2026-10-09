/**
 * 发布需求（文档 5.3.8）
 *
 * 双入口：
 *  ① AI 极速发布：一句话 → 结构化草稿 → 用户确认（可改）
 *  ② 标准表单发布
 * 纪律：AI 只是加速填表，不替用户做决定 —— 预填后必须允许修改。
 * 视觉：装饰层随指针视差（utils/fx.ts），内容区不跟随。
 *
 * ## 「时间」这个词在这一页其实对应两件东西（曾是本页最容易搞混的一处）
 *
 *  · **口语时间**（"周五晚上"、"6月10日"）：模型与本地兜底解析出来的原话，
 *    只能展示，**不能提交** —— 后端 `PublishTaskSchema.deadline` 是
 *    `z.string().datetime()`，只认 ISO datetime（`verify:parse` 实测：直接发口语时间是 400）。
 *  · **截止日期** `form.deadline`（`YYYY-MM-DD`）：只来自日期选择器，用户不选就不发。
 *
 * 曾经两者都没落地：AI 解析出的时间被塞进「时间」输入框，而 onSubmit 根本不发送它，
 * 于是"AI 听懂了但什么都没记下"，用户以为填好了。现在原话显示在选择器旁边，
 * 两者各走各的通道。
 *
 * 断网时的关键词兜底在 `utils/publish-guess.ts`（纯函数、可单测），
 * 「日期不是钱」这条金额规则由 `tests/mp/publish-guess.spec.ts` 钉住。
 */
import type { TaskItem } from '../../utils/api';
import { stationApi } from '../../utils/api';
import { pickFile, uploadFile, type PickedFile } from '../../utils/file-transfer';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { localParse } from '../../utils/publish-guess';
import { toastError } from '../../utils/request';

/**
 * 分类**兜底**列表（后端 `GET /station/categories` 不可用时才用）。
 *
 * ⚠️ 这份列表是**第三份**分类拷贝（另两份在 `seed.ts` 与大厅页），
 * 而 `check:categories` 守卫只校验大厅页那一份 —— 也就是说这里漂移了没人会发现。
 * 所以正常情况下从接口读（唯一真源），这份只在离线/接口异常时兜底。
 */
const FALLBACK_CATEGORIES = [
  { id: 'photo', name: '摄影摄像' },
  { id: 'design', name: 'PPT设计' },
  { id: 'copy', name: '文案' },
  { id: 'code', name: '编程' },
  { id: 'tutor', name: '家教' },
  { id: 'host', name: '主持' },
  { id: 'video', name: '剪辑' },
  { id: 'rent', name: '跑腿' },
  { id: 'other', name: '其他' },
];

const BUDGET_TYPES = [
  { id: 'fixed', name: '一口价' },
  { id: 'negotiable', name: '可议价' },
  { id: 'hourly', name: '按小时' },
];

/**
 * 表单初值 —— 同时是表单的**类型来源**。
 *
 * ⚠️ `budgetType` 必须在这里声明：只靠 `setData({'form.budgetType': …})` 写进去的
 * 字段拿不到类型，提交时读它会被静默丢掉（曾经的 bug：一律发 `fixed`）。
 * ⚠️ `deadline` 同理 —— 而且它是**唯一**会真正提交到后端的时间字段，
 * 只能由日期选择器写入（口语时间进不了后端，见文件头）。
 */
const DEFAULT_FORM = {
  title: '',
  categoryId: 'photo',
  description: '',
  budget: '',
  time: '',
  deadline: '',
  location: '',
  skillTags: '',
  budgetType: 'fixed',
};

/**
 * 提交前校验（与后端 `PublishTaskSchema` 对齐）。
 * 返回 `null` 表示通过，否则返回要提示给用户的那句话。
 */
function validateForm(form: typeof DEFAULT_FORM): string | null {
  if (form.title.trim().length < 4) return '标题至少 4 个字';
  if (form.description.trim().length < 10) return '请把需求描述得再详细一些';
  const yuan = Number(form.budget);
  if (!Number.isFinite(yuan) || yuan < 0) return '请填写正确的预算金额';
  return null;
}

/**
 * 解析结果里**不进表单、只负责"说清楚"**的两项。
 *
 * ⚠️ `time` 之所以只做成回显而不是字段值：它是用户原话（"周五晚上"、"6月10日"），
 * 而后端 `PublishTaskSchema.deadline` 是 `z.string().datetime()` —— 只认 ISO。
 * 以前这里两头都没接上：原话被塞进一个根本不提交的输入框，
 * 于是"AI 明明听懂了，发出去的任务却没有任何时间"，而界面上看不出来。
 * 自行换算（"下周五" → 某个日期）同样不行 —— 那是替用户做决定，猜错就是假截止日。
 *
 * `budgetGuessed` 同理是"坦白"而不是"装饰"：断网兜底走的是关键词正则，
 * 猜出来的价格必须自己说明白是猜的（红线 10：假数据不得冒充真实结果）。
 */
function displayNotes(parsed: Record<string, unknown>, fromLocal: boolean) {
  const spoken = typeof parsed.time === 'string' ? parsed.time.trim() : '';
  const label = fromLocal ? '本地关键词识别的时间' : 'AI 理解的时间';
  return {
    parsedTimeNote: spoken ? `${label}：${spoken}（正式截止需选择日期）` : '',
    budgetGuessed: fromLocal && typeof parsed.budget === 'number',
  };
}

Page({
  data: {
    /** 入口来源：os_plan（来自编排）/ result（来自工具箱结果页）/ ai_generated（走过模型解析，见 onParse） */
    source: 'manual',
    categories: FALLBACK_CATEGORIES,
    categoryNames: FALLBACK_CATEGORIES.map((c) => c.name),
    categoryIndex: 0,
    budgetTypes: BUDGET_TYPES,
    budgetTypeNames: BUDGET_TYPES.map((b) => b.name),
    budgetTypeIndex: 0,

    /** AI 极速发布 */
    rawText: '',
    parsing: false,
    parsed: false,
    /** 解析出的**口语**时间原话（"周五晚上"）：只能展示，不能当 deadline 提交 */
    parsedTimeNote: '',
    /** 当前预算是本地关键词猜的吗 —— 是就在字段旁挂"请核对"，不冒充 AI 估价 */
    budgetGuessed: false,

    /** 表单（初值与类型见 DEFAULT_FORM） */
    form: { ...DEFAULT_FORM },

    /** 日期选择器的下限（北京时间口径）：别让人选出已经过去的截止日 */
    today: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10),

    /** 从任务详情「编辑」进来时的说明：后端没有更新接口，提交等于新发一条 */
    editNotice: '',
    /** 分类接口不可用时说明当前下拉是内置兜底列表（不静默顶替真实分类） */
    catNotice: '',

    /** 估价提示（无历史数据时隐藏，不编造） */
    priceHint: '',

    /** 已上传的参考附件（提交时作为 attachmentIds 带上） */
    attachmentIds: [] as string[],
    /** 附件的展示文案（WXML 不支持 join，这里预拼好） */
    attachmentText: '',

    submitting: false,

    /** 装饰层视差位移（由 utils/fx.ts 写入） */
    fxStyle: '',
  },

  onLoad(query: Record<string, string>) {
    const source = query.source || 'manual';
    const form = { ...this.data.form };

    // 来自 OS 编排：预填标题与预算
    if (query.title) form.title = decodeURIComponent(query.title);
    if (query.budget) form.budget = String(Number(query.budget) / 100);
    if (source === 'os_plan') form.description = '（由青智 OS 编排生成的任务，请补充具体要求）';

    this.setData({ source, form });
    // taskId 来自任务详情页的「编辑」：先拉分类，再把原任务回填进表单
    void this.bootstrap(query.taskId);
  },

  /** 分类必须**先于**回填拿到 —— 原任务的分类要在接口返回的那份列表里定位 */
  async bootstrap(taskId?: string) {
    await this.loadCategories();
    if (!taskId) return;
    /**
     * ⚠️ 后端只有 `POST /station/tasks`（新建），**没有更新接口** ——
     * 所以这里能做的只是把原任务抄进表单，提交仍是"再发一条新需求"。
     * 这点必须在页面顶部说清楚，否则用户按「编辑」改完提交，
     * 会以为原任务已更新，实际大厅里多出一条重复需求。
     */
    this.setData({ editNotice: '原任务编辑暂未开放，将以新需求发布' });
    await this.loadTask(taskId);
  },

  /** 拉一条已有任务并回填表单（`GET /station/tasks/:id` 是真实接口） */
  async loadTask(id: string) {
    try {
      this.applyTask(await stationApi.task(id));
    } catch (e) {
      toastError(e);
    }
  },

  /**
   * 原任务 → 表单初值（预算：分 → 元；标签：数组 → 顿号串）。
   *
   * `deadline` 必须一起抄过来 —— 它是新加的日期选择器的值，
   * 不抄就等于"编辑一条带截止日的需求"会把截止日悄悄丢掉。
   * ISO 串截前 10 位即可：写入时取的是北京时间当天 23:59（见 `toDeadlineIso`），
   * 换算回 UTC 仍是同一天，不会跨到前一天。
   */
  applyTask(t: TaskItem) {
    const idx = BUDGET_TYPES.findIndex((b) => b.id === t.budgetType);
    this.setData({
      form: {
        ...this.data.form,
        title: t.title,
        description: t.description,
        budget: String(t.budget / 100),
        deadline: t.deadline?.slice(0, 10) ?? '',
        location: t.location ?? '',
        skillTags: (t.skillTags ?? []).join('、'),
        budgetType: idx >= 0 ? BUDGET_TYPES[idx].id : 'fixed',
      },
      budgetTypeIndex: idx >= 0 ? idx : 0,
    });
  },

  /**
   * 分类从接口读（唯一真源）。
   *
   * 失败时保留兜底列表，但**必须说明当前用的是兜底** —— 静默顶替会让用户
   * 以为自己选的是平台真实分类（分类名与 seed 漂移时尤其坑：发出去的任务
   * 在大厅里"查不到"）。下拉为空时其余字段仍可填写，所以不弹错误打断填写。
   */
  async loadCategories() {
    try {
      const list = await stationApi.categories();
      if (!list?.length) return;
      const categories = list.map((c) => ({ id: c.id, name: c.name }));
      this.setData({
        categories,
        categoryNames: categories.map((c) => c.name),
        catNotice: '',
      });
    } catch {
      this.setData({ catNotice: '分类列表加载失败，当前为内置常用分类' });
    }
  },

  onShow() {
    // 真机上开启陀螺仪倾斜视差；开发者工具无传感器时会静默跳过
    fxEnableTilt(this);
  },

  onHide() {
    fxDisableTilt();
  },

  onUnload() {
    fxDisableTilt();
  },

  onRawInput(e: WechatMiniprogram.Input) {
    this.setData({ rawText: e.detail.value });
  },

  /**
   * AI 解析：一句话 → 结构化草稿
   * 后端不可用时用本地规则兜底（保证演示可用）
   */
  async onParse() {
    const text = this.data.rawText.trim();
    if (text.length < 4) {
      wx.showToast({ title: '请多描述一些需求', icon: 'none' });
      return;
    }

    this.setData({ parsing: true });
    let parsed: Record<string, unknown>;
    /** 这份草稿是**模型**给的还是**正则**给的 —— 决定来源统计、文案与标注三件事 */
    let byAi = true;

    try {
      parsed = await stationApi.parse(text);
    } catch {
      parsed = localParse(text);
      byAi = false;
    }

    this.applyParsed(parsed, !byAi);

    /**
     * 来源标记：真的走过模型才记 `ai_generated`。
     *
     * 以前 onParse 从不碰 `source`（它只来自页面 query），所以 AI 发布的任务也落成
     * `manual`，"AI 发布占比"这个指标恒为 0 —— 后端 `PublishTaskSchema.source`
     * 早就支持 ai_generated，缺的只是这一行 setData。
     *
     * 两处刻意保守：
     *  · 断网走本地正则时**不记**：那是关键词猜的，记成 ai_generated 就是假统计（红线 10）；
     *  · `os_plan` / `result` 入口不覆盖：那两条归因（编排闭环、工具箱回流）比
     *    "这次顺手用了 AI 填表"更有信息量，覆盖掉还会让页顶「来自青智 OS」的提示凭空消失。
     *
     * ⚠️ 用户事后手动清空预填项**不回落** source —— 来源记录的是"这条需求当初怎么产生的"，
     * 不是"最后每个字段谁写的"；回落会把真实的 AI 使用量重新抹成 0。
     */
    if (byAi && this.data.source === 'manual') this.setData({ source: 'ai_generated' });

    this.setData({ parsing: false, parsed: true });
    // 兜底路径不能再报"已为你填好表单"：那是把正则的结果冒充 AI 的结果
    wx.showToast({
      title: byAi ? '已为你填好表单，可直接修改' : '网络不可用，已按关键词预填，请核对',
      icon: 'none',
    });
  },

  /**
   * 把解析结果写入表单（AI 预填后用户仍可修改）。
   *
   * 只填"模型/正则真的给了"的字段；拿不准的两项（口语时间、本地猜的价格）
   * 不做成字段值，而是走 `displayNotes` 如实回显。
   *
   * @param fromLocal 这份草稿来自本地关键词兜底而非模型
   */
  applyParsed(parsed: Record<string, unknown>, fromLocal: boolean) {
    const form = { ...this.data.form };

    if (typeof parsed.title === 'string') form.title = parsed.title;
    if (typeof parsed.description === 'string') form.description = parsed.description;
    // ⚠️ 后端给的是**分**（红线：金额一律用分），而表单填的是**元**。
    // 这里以前直接 `String(parsed.budget)`，等于把 300 元预填成 30000 元 ——
    // 而"预算 ¥30000"在表单上看起来只是一个偏高的正常数字，不会有人发现。
    if (typeof parsed.budget === 'number') form.budget = String(parsed.budget / 100);
    if (typeof parsed.time === 'string') form.time = parsed.time;
    if (typeof parsed.location === 'string') form.location = parsed.location;
    if (Array.isArray(parsed.skillTags)) form.skillTags = (parsed.skillTags as string[]).join('、');

    let categoryIndex = this.data.categoryIndex;
    if (typeof parsed.categoryId === 'string') {
      // 用**当前生效**的分类列表（可能来自接口）而不是写死的那份
      const idx = this.data.categories.findIndex((c) => c.id === parsed.categoryId);
      if (idx >= 0) {
        categoryIndex = idx;
        form.categoryId = this.data.categories[idx].id;
      }
    }

    this.setData({
      form,
      categoryIndex,
      // 口语时间与"本地估算"标记：见 displayNotes 的理由，别改成直接塞进 form
      ...displayNotes(parsed, fromLocal),
      // 估价提示仅在拿到建议区间时展示（避免编造价格）
      priceHint: typeof parsed.priceHint === 'string' ? parsed.priceHint : '',
    });
  },

  // ---------- 表单输入 ----------
  onInput(e: WechatMiniprogram.Input) {
    const key = e.currentTarget.dataset.key as string;
    // 用户改过预算之后，「本地估算，请核对」的标注必须立刻消失 ——
    // 否则一个真实填写的金额会一直挂着"猜出来的"标签，用户反而会把对的数改错
    const budgetGuessed = key === 'budget' ? false : this.data.budgetGuessed;
    this.setData({ [`form.${key}`]: e.detail.value, budgetGuessed });
  },

  onCategoryChange(e: WechatMiniprogram.PickerChange) {
    const idx = Number(e.detail.value);
    const picked = this.data.categories[idx];
    // 越界时不写 `form.categoryId`：那会让提交带着上一次的分类，
    // 而用户看到的是他刚选的那一项 —— 提交后的任务分类与预期不符且无提示
    if (!picked) return;
    this.setData({ categoryIndex: idx, 'form.categoryId': picked.id });
  },

  /**
   * 正式截止日期（选填）。
   *
   * 这是 `deadline` 的**唯一**写入口：口语时间永远不进这里（后端只认 ISO，见文件头），
   * 用户没选就一个字节都不发，让 `deadline` 保持缺省而不是填个猜出来的日子。
   */
  onDeadlineChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ 'form.deadline': String(e.detail.value) });
  },

  onBudgetTypeChange(e: WechatMiniprogram.PickerChange) {
    const idx = Number(e.detail.value);
    this.setData({ budgetTypeIndex: idx, 'form.budgetType': BUDGET_TYPES[idx].id });
  },

  /**
   * 选择参考附件（图片）。
   *
   * 以前这里只弹一句"附件上传将在 M1-13 接入"，且**没有记录任何东西** ——
   * 而 `PublishTaskSchema` 早就支持 `attachmentIds`，等于让用户白选一次。
   * 现在走真实上传，成功后才记进 `attachmentIds`，提交时一并带上。
   */
  async onChooseImage() {
    let picked: PickedFile | null;
    try {
      picked = await pickFile('image');
    } catch (e) {
      toastError(e);
      return;
    }
    if (!picked) return; // 用户取消，不打扰

    wx.showLoading({ title: '上传中…', mask: true });
    try {
      const file = await uploadFile(picked);
      const names = this.data.attachmentText
        ? `${this.data.attachmentText}、${file.name}`
        : file.name;
      this.setData({
        attachmentIds: [...this.data.attachmentIds, file.id],
        attachmentText: names,
      });
      wx.showToast({ title: '已添加参考图', icon: 'none' });
    } catch (e) {
      toastError(e);
    } finally {
      wx.hideLoading();
    }
  },

  /** 提交发布 */
  async onSubmit() {
    const { form, source } = this.data;

    // 校验（与后端 PublishTaskSchema 对齐）
    const bad = validateForm(form);
    if (bad) {
      wx.showToast({ title: bad, icon: 'none' });
      return;
    }
    const budgetYuan = Number(form.budget);

    if (this.data.submitting) return;
    this.setData({ submitting: true });

    try {
      await stationApi.publish({
        title: form.title.trim(),
        categoryId: form.categoryId,
        description: form.description.trim(),
        budget: Math.round(budgetYuan * 100), // 元 → 分
        /**
         * ⚠️ 这里以前硬编码 `budgetType: 'fixed'` —— 用户在计价方式里选的
         * 「可议价 / 按小时」被静默丢弃，发出去却是一口价（后端 schema
         * 支持 fixed|negotiable|hourly，属于纯前端丢字段）。
         */
        budgetType: form.budgetType || 'fixed',
        /**
         * ⚠️ 时间字段分两条通道（详见文件头）：这里发的**只**是日期选择器选出来的
         * `form.deadline`，换算成后端要的 ISO datetime；表单里那行口语「时间」不发 ——
         * 后端 `deadline` 是 `z.string().datetime()`，"周五晚上"发过去就是 400，
         * 所以口语时间只做展示（`parsedTimeNote`），能落库的截止日一律由用户点选。
         */
        deadline: form.deadline ? toDeadlineIso(form.deadline) : undefined,
        location: form.location || undefined,
        skillTags: form.skillTags ? form.skillTags.split(/[、,，\s]+/).filter(Boolean) : [],
        attachmentIds: this.data.attachmentIds,
        source: source === 'manual' ? 'manual' : source,
      });

      wx.showToast({ title: '发布成功', icon: 'success' });
      setTimeout(() => {
        wx.switchTab({ url: '/pages/station/index' });
      }, 800);
    } catch (e) {
      toastError(e);
    } finally {
      this.setData({ submitting: false });
    }
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

/**
 * 选中的日期（`YYYY-MM-DD`）→ 后端要的 ISO datetime。
 *
 * 取**北京时间**当天 23:59:59：本平台用户都在国内，若直接用 `new Date(date)`
 * （按 UTC 零点解析）会让截止日凭空提前 8 小时 —— 用户在"6月10日"当天上午就发不进去了，
 * 而这种差 8 小时的错不会报错，只会显示成"已截止"。
 * 输出末尾的 `Z`（UTC）也是 `z.string().datetime()` 唯一接受的写法。
 */
function toDeadlineIso(date: string): string {
  return new Date(`${date}T23:59:59+08:00`).toISOString();
}
