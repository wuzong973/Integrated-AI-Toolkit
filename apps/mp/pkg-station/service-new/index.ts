/**
 * 上架服务（M3-04 写路径 · `POST /services`）
 *
 * ## 谁能进这一屏
 *
 * 只有**认证服务者**。后端对非认证者一律 40312（"完成服务者认证即可上架服务"），
 * 所以进入时先问 `GET /provider/profile`：
 *   · 审核中 / 被驳回 / 从未申请 → 显示引导，**不显示表单** ——
 *     让用户填完再被拒是浪费别人的时间，也是"界面写着能用、点了报错"那一类问题；
 *   · 已通过 → 才渲染表单。
 *
 * ## 字段约束与后端 `UpsertServiceSchema` 对齐（一处漂移就会 40001）
 *
 *   标题 4~60 · 描述 10~2000 · 价格 ≥ 0 的**整数分** · 交付 1~90 天 · 技能标签 ≤ 10 个且每个 ≤ 20 字。
 * 表单里的价格按**元**填（用户看得懂的那份），提交前 `Math.round(元 × 100)` 换成分 ——
 * 红线 4：金额在服务端、客户端、界面上都不许出现浮点存储，只有"展示"这一层允许小数。
 *
 * ## 成功之后去哪里
 *
 * 后端没有"我的上架"列表页可跳（`GET /services/mine` 已就绪，但列表页不在本期范围，
 * 工作台 `pkg-station/workbench` 由并行任务持有），所以跳**这条服务自己的详情页**：
 * 本人在详情页能看到下架 / 重新上架，等价于"我的上架"的最小可用版。
 *
 * 视觉：暖橙主题（驿站模块）· 描边表单卡 + 水波装饰，与任务发布页（品红）区分开。
 */
import { providerApi, serviceApi, stationApi } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { toastError } from '../../utils/request';

/** 页面阶段：`form` 才是"能填能交"，其余都是只读说明 */
type Stage = 'loading' | 'form' | 'blocked' | 'error';

/**
 * 分类**兜底**列表（只在 `GET /station/categories` 不可用时用）。
 *
 * ⚠️ 这是分类的第三份拷贝（另两份在 `seed.ts` 与驿站大厅页），
 * `check:categories` 守卫只看大厅那一份 —— 这里漂移了没人发现。
 * 所以正常路径一律读接口，并在用了兜底时**明确告诉用户**（见 `catNotice`）。
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

/** 计价方式与后端 `priceUnit` 枚举一一对应 */
const PRICE_UNITS = [
  { id: 'fixed', name: '一口价' },
  { id: 'hourly', name: '按小时' },
  { id: 'negotiable', name: '价格面议' },
];

/** 服务地区与后端 `serviceArea` 枚举一一对应 */
const AREAS = [
  { id: 'school', name: '校内' },
  { id: 'city', name: '同城' },
  { id: 'remote', name: '远程' },
];

/** 技能标签上限（与 `UpsertServiceSchema.skillTags.max(10)` 一致） */
const MAX_TAGS = 10;

/**
 * 表单初值 —— 同时是表单的**类型来源**。
 * 价格与交付天数用字符串存（输入框的原始值），换算只在提交那一步做。
 */
const DEFAULT_FORM = {
  title: '',
  categoryId: '',
  description: '',
  price: '',
  priceUnit: 'fixed',
  deliveryDays: '3',
  serviceArea: 'school',
};

/** 元 → 分（整数）。非数字/负数/超过 10 万块都当成"没填对"，返回 null 交给调用方提示 */
function yuanInputToCents(raw: string): number | null {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) return null;
  const cents = Math.round(n * 100);
  return Number.isSafeInteger(cents) && cents <= 10_000_000 ? cents : null;
}

/** 文本类字段：标题 / 分类 / 描述（拆出去只为压 validateForm 的圈复杂度，行为不变） */
function validateTexts(form: typeof DEFAULT_FORM): string | null {
  const title = form.title.trim();
  if (title.length < 4) return '标题至少 4 个字，写清你提供什么';
  if (title.length > 60) return '标题不超过 60 个字';
  if (!form.categoryId) return '请选择服务分类';
  const desc = form.description.trim();
  if (desc.length < 10) return '描述至少 10 个字，说清包含什么、交付什么';
  if (desc.length > 2000) return '描述不超过 2000 个字';
  return null;
}

/**
 * 提交前校验（对齐后端 schema）。返回 `null` 表示通过，否则返回要说给用户的那句话。
 * 与后端一致的意义在于：别让一个必然 40001 的请求白跑一趟。
 */
function validateForm(
  form: typeof DEFAULT_FORM,
  tags: string[],
  needPrice: boolean,
): string | null {
  const textBad = validateTexts(form);
  if (textBad) return textBad;
  if (needPrice) {
    if (!form.price.trim()) return '请填写价格（元）';
    if (yuanInputToCents(form.price) === null) return '价格要在 0 ~ 100000 元之间';
  }
  const days = Number(form.deliveryDays);
  if (!Number.isInteger(days) || days < 1 || days > 90) return '交付天数要在 1 ~ 90 天之间';
  if (tags.length > MAX_TAGS) return `技能标签最多 ${MAX_TAGS} 个`;
  return null;
}

Page({
  data: {
    stage: 'loading' as Stage,
    error: '',
    /** 非认证服务者时显示的那两句话（标题说处境，正文说下一步） */
    blockedTitle: '',
    blockedText: '',
    /** 上次认证被驳回的原因（有值时显示在引导里，别让用户猜） */
    blockedReason: '',

    categories: FALLBACK_CATEGORIES,
    categoryNames: FALLBACK_CATEGORIES.map((c) => c.name),
    /** -1 = 还没选：picker 显示占位文案，而不是默认落在第一项 */
    categoryIndex: -1,
    catNotice: '',

    priceUnits: PRICE_UNITS,
    areas: AREAS,

    form: { ...DEFAULT_FORM },
    tagInput: '',
    skillTags: [] as string[],

    submitting: false,
    fxStyle: '',
  },

  onLoad() {
    void this.bootstrap();
  },

  onShow() {
    fxEnableTilt(this);
  },
  onHide() {
    fxDisableTilt();
  },
  onUnload() {
    fxDisableTilt();
  },

  /** 下拉刷新：重问认证状态（刚在认证页提交通过的话，这里就能进表单了） */
  onPullDownRefresh() {
    void this.bootstrap().finally(() => wx.stopPullDownRefresh());
  },

  /** 认证状态 + 分类列表：分类只在能填表单时才需要 */
  async bootstrap(): Promise<void> {
    this.setData({ stage: 'loading', error: '' });
    try {
      const profile = await providerApi.profile();
      if (profile.isProvider) {
        this.setData({ stage: 'form' });
        await this.loadCategories();
        return;
      }
      const v = profile.verification;
      // 状态表外取值一律退回"从未申请"那份说法：宁可文案泛一点，也不显示空白
      const key = v?.status === 'pending' || v?.status === 'rejected' ? v.status : 'none';
      this.setData({
        stage: 'blocked',
        blockedTitle: BLOCKED_TITLE[key],
        blockedText: BLOCKED_TEXT[key],
        blockedReason: key === 'rejected' ? (v?.rejectReason ?? '') : '',
      });
    } catch (e) {
      this.setData({ stage: 'error', error: (e as Error).message || '加载失败，请稍后重试' });
    }
  },

  /** 分类从接口读（唯一真源）。拉不到时退回内置列表，但**必须说明用的是兜底** */
  async loadCategories(): Promise<void> {
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

  onRetry() {
    void this.bootstrap();
  },

  /** 去服务者认证（M3-02 已跑通）：被驳回时同样是回到那一个页面重新提交 */
  onGoApply() {
    wx.navigateTo({ url: '/pkg-station/apply/index' });
  },

  /** 引导态的第二去处：服务市场（tabBar 页，必须 switchTab） */
  onGoMarket() {
    wx.switchTab({ url: '/pages/station/index' });
  },

  // ---------- 表单输入 ----------

  onInput(e: WechatMiniprogram.Input) {
    const key = e.currentTarget.dataset.key as string;
    this.setData({ [`form.${key}`]: e.detail.value });
  },

  onCategoryChange(e: WechatMiniprogram.PickerChange) {
    const idx = Number(e.detail.value);
    const picked = this.data.categories[idx];
    // 越界时不写 categoryId：那会让提交带着上一次的选择，而用户以为换好了
    if (!picked) return;
    this.setData({ categoryIndex: idx, 'form.categoryId': picked.id });
  },

  /** 计价方式：面议不需要价格，顺手把已填的价格清掉，免得提交时两边不一致 */
  onPriceUnitTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    this.setData({ 'form.priceUnit': id, ...(id === 'negotiable' ? { 'form.price': '' } : {}) });
  },

  onAreaTap(e: WechatMiniprogram.TouchEvent) {
    this.setData({ 'form.serviceArea': e.currentTarget.dataset.id as string });
  },

  onTagInput(e: WechatMiniprogram.Input) {
    this.setData({ tagInput: e.detail.value });
  },

  /** 加技能标签：去空、去重、限长 20 字、上限 10 个（与后端一致） */
  onTagAdd() {
    const tag = this.data.tagInput.trim().slice(0, 20);
    if (!tag) return;
    if (this.data.skillTags.includes(tag)) {
      wx.showToast({ title: '已经添加过了', icon: 'none' });
      return;
    }
    if (this.data.skillTags.length >= MAX_TAGS) {
      wx.showToast({ title: `最多 ${MAX_TAGS} 个技能标签`, icon: 'none' });
      return;
    }
    this.setData({ skillTags: [...this.data.skillTags, tag], tagInput: '' });
  },

  onTagRemove(e: WechatMiniprogram.TouchEvent) {
    const tag = e.currentTarget.dataset.tag as string;
    this.setData({ skillTags: this.data.skillTags.filter((t) => t !== tag) });
  },

  // ---------- 提交 ----------

  async onSubmit() {
    const { form, skillTags, submitting } = this.data;
    if (submitting) return;
    const bad = validateForm(form, skillTags, form.priceUnit !== 'negotiable');
    if (bad) {
      wx.showToast({ title: bad, icon: 'none', duration: 2500 });
      return;
    }

    this.setData({ submitting: true });
    try {
      const created = await serviceApi.create(buildPayload(form, skillTags));
      wx.showToast({ title: '已上架', icon: 'success' });
      // redirectTo：表单已经交掉了，留在返回栈里只会让人再交一条重复的
      wx.redirectTo({ url: `/pkg-station/service/index?id=${created.id}` });
    } catch (e) {
      toastError(e);
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

/** 表单 → `POST /services` 的 body（价格在这一步从「元」换成「分」） */
function buildPayload(form: typeof DEFAULT_FORM, skillTags: string[]): Record<string, unknown> {
  return {
    title: form.title.trim(),
    categoryId: form.categoryId,
    description: form.description.trim(),
    price: form.priceUnit === 'negotiable' ? 0 : (yuanInputToCents(form.price) ?? 0),
    priceUnit: form.priceUnit,
    deliveryDays: Number(form.deliveryDays),
    serviceArea: form.serviceArea,
    skillTags,
  };
}

/** 三种"还不能上架"的处境，说法各不相同（把"你还没做"和"功能没上线"分开） */
const BLOCKED_TITLE: Record<string, string> = {
  none: '先完成服务者认证',
  pending: '入驻申请审核中',
  rejected: '上次认证未通过',
};
const BLOCKED_TEXT: Record<string, string> = {
  none: '上架服务面向认证服务者。完成认证后，这里就能把自己会做的事挂到服务市场。',
  pending: '平台正在审核你的入驻申请。审核通过后回到这一页即可上架。',
  rejected: '按下面的原因修改后可以重新提交认证，通过后就能上架服务。',
};
