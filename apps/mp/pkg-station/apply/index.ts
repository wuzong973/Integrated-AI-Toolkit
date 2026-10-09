/**
 * 服务者入驻认证（M3-02，设计文档 5.3.12）
 *
 * 三步：学生身份 → 技能认证 → 服务承诺。
 *
 * ## 这个页面此前是纯骨架
 *
 * 它只渲染一句"服务者入驻功能开发中"，而 `ProviderApplySchema` 早就写好了 ——
 * 也就是**契约在、接口没有、页面也没有**。同时它在静态守卫里登记为"孤岛页"
 * （全仓库零入站跳转），所以用户根本走不到这里。
 *
 * ## 三种状态必须分开渲染，不能都当"可填写"
 *
 *   · 已通过 → 显示"你已是认证服务者"，**不显示表单**（否则用户会重复提交）；
 *   · 审核中 → 显示等待说明，**不显示表单**（重复提交会被服务端 40901 拒绝，
 *     而用户看到的是一个填得好好的表单点不动，只会以为坏了）；
 *   · 被驳回 → **必须把驳回原因显示在表单上方**。M3-02 的验收标准就是
 *     "驳回时给出具体原因"，藏在某个二级页里等于没给。
 *
 * 视觉：靛蓝主题 · 中圆角 + 光环 + 柔流线，突出"一步一步来"的流程感。
 */
import { providerApi } from '../../utils/api';
import { pickFile, uploadFile } from '../../utils/file-transfer';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { toastError } from '../../utils/request';

/** 页面阶段。`form` 才是"可填写"，其余都是只读说明 */
type Stage = 'loading' | 'form' | 'pending' | 'approved' | 'error';

/** 学生证最多 3 张（正面 / 内页 / 补充），作品集最多 9 张 */
const MAX_MATERIALS = 3;
const MAX_PORTFOLIO = 9;

interface Uploaded {
  id: string;
  name: string;
}

Page({
  data: {
    stage: 'loading' as Stage,
    error: '',
    /** 被驳回的原因。**必须展示**（M3-02 验收标准） */
    rejectReason: '',
    /** 是否曾提交过（被驳回后重填时，文案要说明"这是重新提交"） */
    resubmit: false,

    step: 1,
    schools: [] as { id: string; name: string }[],
    schoolNames: [] as string[],
    schoolIndex: -1,

    form: { realName: '', studentNo: '', schoolId: '', college: '' },
    skillInput: '',
    skillTags: [] as string[],

    materials: [] as Uploaded[],
    materialText: '',
    portfolio: [] as Uploaded[],
    portfolioText: '',

    agreed: false,
    truthful: false,
    submitting: false,

    fxStyle: '',
  },

  onLoad() {
    void this.loadState();
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

  /** 下拉刷新：重拉认证状态 + 学校列表 */
  async onPullDownRefresh() {
    try {
      await this.loadState();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  /** 拉认证状态 + 学校列表 */
  async loadState() {
    try {
      const [profile, schools] = await Promise.all([providerApi.profile(), this.loadSchools()]);
      const v = profile.verification;

      const stage: Stage = profile.isProvider
        ? 'approved'
        : v?.status === 'pending'
          ? 'pending'
          : 'form';

      this.setData({
        stage,
        // 只有"被驳回"才有原因；pending / approved 不带
        rejectReason: v?.status === 'rejected' ? (v.rejectReason ?? '') : '',
        resubmit: v?.status === 'rejected',
        schools,
        schoolNames: schools.map((s) => s.name),
        schoolIndex: -1,
      });
    } catch (e) {
      this.setData({ stage: 'error', error: (e as Error).message || '加载失败' });
    }
  },

  /** 学校列表拉取失败不该让整个页面报错 —— 下拉为空时其余字段仍可填写 */
  async loadSchools(): Promise<{ id: string; name: string }[]> {
    try {
      return (await providerApi.schools()) ?? [];
    } catch {
      return [];
    }
  },

  onRetry() {
    this.setData({ stage: 'loading', error: '' });
    void this.loadState();
  },

  /** 已是服务者时的出口：工作台是接单的地方，别让用户在这里干看着 */
  onGoWorkbench() {
    wx.navigateTo({ url: '/pkg-station/workbench/index' });
  },

  // ---------- 步骤切换 ----------

  /** 下一步：先校验当前步骤，不通过就停在原地并说明原因 */
  onNext() {
    const bad = this.validateStep(this.data.step);
    if (bad) {
      wx.showToast({ title: bad, icon: 'none' });
      return;
    }
    this.setData({ step: Math.min(3, this.data.step + 1) });
  },

  onPrev() {
    this.setData({ step: Math.max(1, this.data.step - 1) });
  },

  /** 某一步是否填全。返回 `null` 表示通过，否则返回要提示给用户的话 */
  validateStep(step: number): string | null {
    const { form, materials, skillTags } = this.data;
    if (step === 1) {
      if (form.realName.trim().length < 2) return '请填写真实姓名';
      if (form.studentNo.trim().length < 4) return '请填写学号';
      if (!form.schoolId) return '请选择学校';
      if (!materials.length) return '请上传学生证照片';
    }
    if (step === 2 && !skillTags.length) return '请至少添加一项技能';
    return null;
  },

  // ---------- 表单输入 ----------

  onInput(e: WechatMiniprogram.Input) {
    const key = e.currentTarget.dataset.key as string;
    this.setData({ [`form.${key}`]: e.detail.value });
  },

  onSchoolChange(e: WechatMiniprogram.PickerChange) {
    const idx = Number(e.detail.value);
    const picked = this.data.schools[idx];
    // 越界时不写 schoolId：那会让提交带着上一次的选择，而用户以为换好了
    if (!picked) return;
    this.setData({ schoolIndex: idx, 'form.schoolId': picked.id });
  },

  onSkillInput(e: WechatMiniprogram.Input) {
    this.setData({ skillInput: e.detail.value });
  },

  /** 添加技能标签：去重、去空、上限 10（与 `ProviderApplySchema` 一致） */
  onSkillAdd() {
    const tag = this.data.skillInput.trim().slice(0, 20);
    if (!tag) return;
    if (this.data.skillTags.includes(tag)) {
      wx.showToast({ title: '已经添加过了', icon: 'none' });
      return;
    }
    if (this.data.skillTags.length >= 10) {
      wx.showToast({ title: '最多 10 个技能标签', icon: 'none' });
      return;
    }
    this.setData({ skillTags: [...this.data.skillTags, tag], skillInput: '' });
  },

  onSkillRemove(e: WechatMiniprogram.TouchEvent) {
    const tag = e.currentTarget.dataset.tag as string;
    this.setData({ skillTags: this.data.skillTags.filter((t) => t !== tag) });
  },

  onToggleAgreed() {
    this.setData({ agreed: !this.data.agreed });
  },

  onToggleTruthful() {
    this.setData({ truthful: !this.data.truthful });
  },

  // ---------- 材料上传 ----------

  /** 学生证照片（1~3 张）。scene 传 `verification`，便于文件模块区分敏感材料 */
  async onPickMaterial() {
    if (this.data.materials.length >= MAX_MATERIALS) {
      wx.showToast({ title: `最多 ${MAX_MATERIALS} 张`, icon: 'none' });
      return;
    }
    await this.uploadInto('materials', 'materialText', MAX_MATERIALS, '已添加学生证');
  },

  /** 作品集（0~9 张）。可以为空 —— 不是所有技能都有作品 */
  async onPickPortfolio() {
    if (this.data.portfolio.length >= MAX_PORTFOLIO) {
      wx.showToast({ title: `最多 ${MAX_PORTFOLIO} 张`, icon: 'none' });
      return;
    }
    await this.uploadInto('portfolio', 'portfolioText', MAX_PORTFOLIO, '已添加作品');
  },

  /**
   * 选图 → 上传 → 记进对应列表。
   *
   * 只有**上传成功**才记 id：先记后传的话，上传失败会留下一个指向不存在文件的 id，
   * 提交时被服务端的"材料必须属于你"校验拦下，用户却看不出是哪一张出了问题。
   */
  async uploadInto(listKey: 'materials' | 'portfolio', textKey: string, max: number, okText: string) {
    let picked;
    try {
      picked = await pickFile('image');
    } catch (e) {
      toastError(e);
      return;
    }
    if (!picked) return; // 用户取消，不打扰

    wx.showLoading({ title: '上传中…', mask: true });
    try {
      const file = await uploadFile(picked, 'verification');
      const list = this.data[listKey];
      if (list.length >= max) return;
      const next: Uploaded[] = [...list, { id: file.id, name: file.name }];
      this.setData({
        [listKey]: next,
        [textKey]: next.map((f) => f.name).join('、'),
      });
      wx.showToast({ title: okText, icon: 'none' });
    } catch (e) {
      toastError(e);
    } finally {
      wx.hideLoading();
    }
  },

  // ---------- 提交 ----------

  async onSubmit() {
    for (const step of [1, 2]) {
      const bad = this.validateStep(step);
      if (bad) {
        this.setData({ step });
        wx.showToast({ title: bad, icon: 'none' });
        return;
      }
    }
    if (!this.data.agreed || !this.data.truthful) {
      wx.showToast({ title: '请勾选两项服务承诺', icon: 'none' });
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });

    try {
      const { form, skillTags, materials, portfolio } = this.data;
      await providerApi.apply({
        realName: form.realName.trim(),
        studentNo: form.studentNo.trim(),
        schoolId: form.schoolId,
        // 未填就不发这个字段（发空串会被服务端 max 校验之外的地方误当成"填了空的"）
        ...(form.college.trim() ? { college: form.college.trim() } : {}),
        materialIds: materials.map((m) => m.id),
        skillTags,
        portfolioIds: portfolio.map((p) => p.id),
      });
      this.setData({ stage: 'pending' });
      wx.showToast({ title: '已提交，等待审核', icon: 'success' });
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
