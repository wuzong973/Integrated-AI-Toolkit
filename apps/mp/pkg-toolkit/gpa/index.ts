/**
 * 绩点计算（校园小工具）
 *
 * ## 为什么是本地页面而不是工具箱工具
 *
 * 工具箱的"同步"路径**仍会建作业记录并预扣积分**（`ToolInvokeService.invoke`），
 * 算一次绩点就留一条作业、扣一次积分是明显的错配。
 * 纯计算没有副作用，就该待在本地 —— 秒出结果、离线可用、不占额度。
 *
 * ## 算法不在这里
 *
 * 全部在 `utils/gpa.ts`（纯函数、有单测）。页面只负责收集输入与展示，
 * 这样"绩点算错"这类问题能靠单测拦住，而不是靠人点页面发现。
 */
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import {
  computeGpa,
  GPA_SCALE_LABELS,
  GPA_SCALES,
  type CourseScore,
  type GpaResult,
  type GpaScale,
} from '../../utils/gpa';

/** 输入框里的草稿（都是字符串，用户边填边算时允许空值） */
interface CourseDraft {
  name: string;
  score: string;
  credit: string;
}

const DEFAULT_COURSES: CourseDraft[] = [
  { name: '', score: '', credit: '' },
  { name: '', score: '', credit: '' },
];

Page({
  data: {
    fxStyle: '',
    scales: GPA_SCALES.map((value) => ({ value, label: GPA_SCALE_LABELS[value] })),
    scaleIndex: 0,
    courses: DEFAULT_COURSES,
    result: null as GpaResult | null,
    /** 是否已算过至少一次（用于区分"还没算"与"算了但没有效数据"） */
    computed: false,
  },

  onLoad() {
    this.recompute();
  },

  /** 倾斜视差只能在这里开（**不能放 onLoad**，见 docs/dev/MP-VISUAL-SYSTEM.md §六） */
  onShow() {
    fxEnableTilt(this);
  },

  onHide() {
    fxDisableTilt();
  },

  /* ---------- 装饰视差（只动装饰层，内容区不跟随） ---------- */

  onFxStart(e: WechatMiniprogram.TouchEvent) {
    fxStart(this, e);
  },

  onFxMove(e: WechatMiniprogram.TouchEvent) {
    fxMove(this, e);
  },

  onFxEnd() {
    fxEnd(this);
  },

  /** 换口径：立即重算，用户不必再点一次按钮 */
  onScaleChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ scaleIndex: Number(e.detail.value) }, () => this.recompute());
  },

  onCourseInput(e: WechatMiniprogram.Input) {
    const { index, field } = e.currentTarget.dataset as { index: string; field: keyof CourseDraft };
    const i = Number(index);
    const courses = this.data.courses.slice();
    courses[i] = { ...courses[i], [field]: e.detail.value };
    this.setData({ courses }, () => this.recompute());
  },

  onAddCourse() {
    this.setData({ courses: [...this.data.courses, { name: '', score: '', credit: '' }] });
  },

  onRemoveCourse(e: WechatMiniprogram.TouchEvent) {
    const i = Number((e.currentTarget.dataset as { index: string }).index);
    const courses = this.data.courses.filter((_, idx) => idx !== i);
    // 至少留一行，否则界面会变成一片空白，用户不知道该怎么继续
    this.setData({ courses: courses.length ? courses : DEFAULT_COURSES }, () => this.recompute());
  },

  onReset() {
    this.setData({ courses: DEFAULT_COURSES, scaleIndex: 0 }, () => this.recompute());
  },

  /**
   * 重算。
   *
   * ⚠️ 空值**不报错**：用户边填边算是常态，中途必然有半截数据。
   * 无效行由 `computeGpa` 静默忽略，只有"一条有效都没有"时才显示空态。
   */
  recompute() {
    const scale: GpaScale = GPA_SCALES[this.data.scaleIndex] ?? 'standard4';
    const courses: CourseScore[] = this.data.courses.map((c, i) => ({
      name: c.name.trim() || `第 ${i + 1} 门`,
      score: Number.parseFloat(c.score),
      credit: Number.parseFloat(c.credit),
    }));
    this.setData({ result: computeGpa(courses, scale), computed: true });
  },
});
