/**
 * 个人信息编辑页（任务清单 M0-20 的补充）
 *
 * 头像与昵称复用用户的微信资料：走微信官方的"头像昵称填写能力"
 * （`button open-type="chooseAvatar"` + `input type="nickname"`），
 * 而不是已废弃的 `wx.getUserProfile`。
 *
 * 两条设计约束贯穿全文件：
 *   1. **只发差异字段**（`buildProfilePayload`）—— `user.phone` 是 @unique，
 *      把没动过的手机号一起发回去，用户改个昵称就可能撞到别人的号；
 *   2. **头像先存草稿、保存时才上传** —— 选完就传会产生"传上去了但没人用"的孤儿文件，
 *      而用户完全可能选完又退出去。
 */
import {
  avatarPublicUrl,
  authApi,
  userApi,
  type MeInfo,
} from '../../utils/api';
import { uploadFromTempPath } from '../../utils/file-transfer';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import {
  EMPTY_FORM,
  GENDER_OPTIONS,
  buildProfilePayload,
  isDirty,
  phoneError,
  type ProfileForm,
} from '../../utils/profile-fields';
import { toastError } from '../../utils/request';

/** 把后端返回的 MeInfo 摊成表单值（null 一律转空串，表单里不出现 null） */
function toForm(me: MeInfo): ProfileForm {
  return {
    nickname: me.nickname ?? '',
    avatar: me.avatar ?? '',
    bio: me.bio ?? '',
    college: me.college ?? '',
    grade: me.grade ?? '',
    gender: me.gender ?? '',
    phone: me.phone ?? '',
  };
}

Page({
  data: {
    loading: true,
    loadError: '',
    form: EMPTY_FORM as ProfileForm,
    /** 进入页面时的快照，用来算差异；保存成功后会被刷新 */
    original: EMPTY_FORM as ProfileForm,
    genderOptions: GENDER_OPTIONS,
    /** 微信头像选择器返回的临时路径（还没上传） */
    avatarDraft: '',
    /** 头像预览地址：有草稿用草稿，否则用已存的 */
    avatarPreview: '',
    bioLength: 0,
    dirty: false,
    saving: false,
    saveStateText: '没有改动',
    /** 用户改过手机号才换成警示色角标，避免一进来就红一片 */
    phoneTouched: false,
    fxStyle: '',
  },

  onLoad() {
    void this.loadMe();
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

  async loadMe() {
    this.setData({ loading: true, loadError: '' });
    try {
      const me = await authApi.me();
      const form = toForm(me);
      this.setData({
        loading: false,
        form,
        original: form,
        avatarPreview: form.avatar,
        bioLength: form.bio.length,
        dirty: false,
        saveStateText: '没有改动',
      });
    } catch (e) {
      // 不把微信原话丢给用户：这里说清"没读到"以及可以怎么办
      this.setData({
        loading: false,
        loadError: (e as Error).message || '网络好像不太顺',
      });
    }
  },

  onRetry() {
    void this.loadMe();
  },

  /* ---------- 字段编辑 ---------- */
  /** 通用输入：WXML 上用 data-field 指明字段，避免七个字段写七个几乎一样的方法 */
  onFieldInput(e: WechatMiniprogram.Input) {
    const field = String(e.currentTarget.dataset.field ?? '') as keyof ProfileForm;
    if (!(field in this.data.form)) return;
    const value = e.detail.value ?? '';
    const patch: Record<string, unknown> = { [`form.${field}`]: value };
    if (field === 'bio') patch.bioLength = value.length;
    this.setData(patch);
    this.refreshDirty();
  },

  /**
   * 昵称失焦。
   *
   * `type="nickname"` 的机制是：用户在输入框里点一下微信建议的昵称，
   * 值要等到**失焦**才真正落进 `detail.value`。所以这里必须回写一次表单，
   * 否则用户看到昵称填上了、点保存却存了个空。
   */
  onNicknameBlur(e: WechatMiniprogram.Input) {
    this.setData({ 'form.nickname': e.detail.value ?? '' });
    this.refreshDirty();
  },

  onPhoneInput(e: WechatMiniprogram.Input) {
    this.setData({ 'form.phone': e.detail.value ?? '', phoneTouched: true });
    this.refreshDirty();
  },

  onPickGender(e: WechatMiniprogram.TouchEvent) {
    const value = String(e.currentTarget.dataset.value ?? '');
    this.setData({ 'form.gender': value });
    this.refreshDirty();
  },

  /** 头像：只记临时路径，上传留到保存时做 */
  onChooseAvatar(e: WechatMiniprogram.CustomEvent<{ avatarUrl?: string }>) {
    const path = e.detail?.avatarUrl ?? '';
    if (!path) {
      wx.showToast({ title: '微信没返回头像，请再点一次', icon: 'none' });
      return;
    }
    this.setData({ avatarDraft: path, avatarPreview: path });
    this.refreshDirty();
  },

  refreshDirty() {
    const dirty = isDirty(this.data.original, this.data.form) || !!this.data.avatarDraft;
    if (this.data.saving) return;
    this.setData({ dirty, saveStateText: dirty ? '有改动未保存' : '没有改动' });
  },

  /* ---------- 保存 ---------- */
  async onSave() {
    if (this.data.saving) return;

    const bad = phoneError(this.data.form.phone);
    if (bad) {
      wx.showToast({ title: bad, icon: 'none', duration: 2500 });
      return;
    }

    this.setData({ saving: true, saveStateText: '正在保存…' });
    try {
      await this.uploadAvatarIfDraft();
      const payload = buildProfilePayload(this.data.original, this.data.form);
      if (!Object.keys(payload).length) {
        // 只剩头像以外的改动被清空了：没什么可存，直接回去，别发一个空 PUT
        this.setData({ saving: false, dirty: false, saveStateText: '没有改动' });
        wx.navigateBack();
        return;
      }
      await userApi.updateProfile(payload);
      // refreshUser 是唯一会把用户态写回 storage 的入口，不调它"我的"页会显示旧值
      await getApp<IAppOption>().refreshUser?.();
      this.finishSave();
    } catch (e) {
      this.setData({ saving: false, saveStateText: '没保存成功，可以再试一次' });
      toastError(e);
    }
  },

  /** 有头像草稿才上传；上传完把永久地址写进表单，草稿清掉 */
  async uploadAvatarIfDraft() {
    const draft = this.data.avatarDraft;
    if (!draft) return;
    this.setData({ saveStateText: '正在上传头像…' });
    const file = await uploadFromTempPath(draft, 'avatar');
    this.setData({
      'form.avatar': avatarPublicUrl(file.id),
      avatarDraft: '',
      // 预览继续用本地临时路径：永久地址要经过一次 302 才拿到图，没必要在这里等
      avatarPreview: draft,
    });
  },

  finishSave() {
    const form = this.data.form;
    this.setData({
      original: form,
      saving: false,
      dirty: false,
      saveStateText: '已保存',
    });
    wx.showToast({ title: '已保存', icon: 'success' });
    setTimeout(() => wx.navigateBack(), 600);
  },
});
