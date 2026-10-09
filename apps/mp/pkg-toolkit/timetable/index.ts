/**
 * 课程表（校园小工具）
 *
 * ## 为什么是本地页面
 *
 * 与绩点 / AA 分账 / 倒计时同因：工具箱的"同步"路径**仍会建作业记录并预扣积分**，
 * 而课表是纯个人数据 —— 存本地、离线可用、不占额度才对。
 *
 * ## 两个刻意的取舍
 *
 * ① **按「节次」排布，不显示时钟时间** —— 各校第一节 7:50 / 8:00 / 8:30 都有，
 *    写死一套等于编造作息。学生本来就说"周一 3-4 节有课"。
 *    也因此**不做上课提醒**：没有可信的时间点，提醒只会提醒错。
 * ② **学期开始前不假装第 1 周** —— `weekOfTerm` 会返回 ≤ 0，
 *    界面照实说"学期还没开始"，而不是夹到第 1 周显示一份看着像真的的课表。
 */
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import {
  addDays,
  formatDate,
  mondayOf,
  parseDate,
  todayParts,
  type DateParts,
} from '../../utils/date-parts';
import {
  layoutOf,
  PARITY_LABELS,
  parseTimetable,
  PERIOD_LABELS,
  weekOfTerm,
  WEEKDAY_LABELS,
  type Course,
  type DayColumn,
  type Parity,
  type TimetableState,
} from '../../utils/timetable';

const STORAGE_KEY = 'qz_timetable_v1';

const PARITIES: readonly Parity[] = ['all', 'odd', 'even'];
const PARITY_OPTIONS = PARITIES.map((p) => PARITY_LABELS[p]);

let seq = 0;
const nextId = (): string => `t${Date.now().toString(36)}${(seq += 1).toString(36)}`;

const EMPTY_STATE: TimetableState = { termStart: null, courses: [] };

function loadState(): TimetableState {
  try {
    return parseTimetable(wx.getStorageSync(STORAGE_KEY));
  } catch {
    return EMPTY_STATE;
  }
}

function saveState(state: TimetableState): void {
  try {
    wx.setStorageSync(STORAGE_KEY, state);
  } catch {
    wx.showToast({ title: '本地保存失败，本次改动可能不保留', icon: 'none' });
  }
}

Page({
  data: {
    fxStyle: '',
    periodLabels: PERIOD_LABELS,
    weekdayLabels: WEEKDAY_LABELS,
    parityOptions: PARITY_OPTIONS,

    /** 学期第一周的周一（`YYYY-MM-DD`，空串表示未设置） */
    termStartText: '',
    /** 正在查看第几周 */
    week: 1,
    /** 今天是第几周；≤ 0 表示学期还没开始 */
    currentWeek: 0,
    /** 正在看的是不是本周 */
    isCurrent: true,
    /** 正在看的这一周的日期范围（如 `09-21 ~ 09-27`），未设置学期时为空串 */
    weekRangeText: '',
    /** 这一周有没有课（WXML 里不去深挖 `columns[0].blocks.length`，避免空数组取值） */
    weekHasCourse: false,
    columns: [] as DayColumn[],

    /** 添加表单是否展开 */
    showForm: false,
    form: {
      name: '',
      teacher: '',
      location: '',
      weekdayIndex: 0,
      startIndex: 0,
      endIndex: 1,
      fromWeek: '1',
      toWeek: '16',
      parityIndex: 0,
    },
  },

  onLoad() {
    const { termStart } = loadState();
    this.setData({ termStartText: termStart ? formatDate(termStart) : '' }, () => this.refresh());
  },

  /**
   * 每次显示重算：用户可能挂着页面跨了午夜 / 跨了周。
   * 倾斜视差也在这里开（**不能放 onLoad**，见 docs/dev/MP-VISUAL-SYSTEM.md §六）。
   */
  onShow() {
    fxEnableTilt(this);
    this.refresh();
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

  /* ---------- 学期与周次 ---------- */

  onTermStartChange(e: WechatMiniprogram.PickerChange) {
    const picked = parseDate(String(e.detail.value));
    if (!picked) return;
    // 统一对齐到该周的周一：否则"第几周"会随用户随手选的日子漂移
    const termStart = mondayOf(picked);
    saveState({ ...loadState(), termStart });
    this.setData({ termStartText: formatDate(termStart) }, () => this.refresh());
  },

  onWeekStep(e: WechatMiniprogram.TouchEvent) {
    const delta = Number((e.currentTarget.dataset as { delta: string }).delta);
    this.setWeek(this.data.week + delta);
  },

  onBackToCurrent() {
    if (this.data.currentWeek < 1) return;
    this.setWeek(this.data.currentWeek);
  },

  setWeek(week: number) {
    this.setData({ week: Math.max(1, week) }, () => this.refresh());
  },

  /* ---------- 添加课程 ---------- */

  onToggleForm() {
    this.setData({ showForm: !this.data.showForm });
  },

  onFormInput(e: WechatMiniprogram.Input) {
    const field = (e.currentTarget.dataset as { field: string }).field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onFormPick(e: WechatMiniprogram.PickerChange) {
    const field = (e.currentTarget.dataset as { field: string }).field;
    this.setData({ [`form.${field}`]: Number(e.detail.value) });
  },

  onAddCourse() {
    const c = this.buildCourse();
    if (!c) return;
    saveState({ ...loadState(), courses: [...loadState().courses, c] });
    this.setData(
      { showForm: false, 'form.name': '', 'form.teacher': '', 'form.location': '' },
      () => this.refresh(),
    );
  },

  /**
   * 校验并构造一门课。
   *
   * ⚠️ 校验失败一律**明确提示 + 不写入**，不做"自动纠正"：
   * 把用户填的 5-3 节偷偷换成 3-5 节，他会以为课表记对了。
   */
  buildCourse(): Course | null {
    const f = this.data.form;
    const name = f.name.trim();
    if (!name) {
      wx.showToast({ title: '先写课程名称', icon: 'none' });
      return null;
    }
    const start = f.startIndex + 1;
    const end = f.endIndex + 1;
    if (end < start) {
      wx.showToast({ title: '结束节次不能早于起始节次', icon: 'none' });
      return null;
    }
    const fromWeek = Number.parseInt(f.fromWeek, 10);
    const toWeek = Number.parseInt(f.toWeek, 10);
    if (!Number.isInteger(fromWeek) || !Number.isInteger(toWeek)) {
      wx.showToast({ title: '周次范围要填成 1 到 16 这样', icon: 'none' });
      return null;
    }
    if (fromWeek < 1 || toWeek < fromWeek) {
      wx.showToast({ title: '周次范围要填成 1 到 16 这样', icon: 'none' });
      return null;
    }
    return {
      id: nextId(),
      name,
      teacher: f.teacher.trim(),
      location: f.location.trim(),
      weekday: f.weekdayIndex + 1,
      start,
      end,
      fromWeek,
      toWeek,
      parity: PARITIES[f.parityIndex] ?? 'all',
    };
  },

  /* ---------- 删除 ---------- */

  onBlockTap(e: WechatMiniprogram.TouchEvent) {
    const id = (e.currentTarget.dataset as { id: string }).id;
    const target = loadState().courses.find((c) => c.id === id);
    if (!target) return;
    wx.showActionSheet({
      itemList: [`删除「${target.name}」`],
      success: (res) => {
        if (res.tapIndex !== 0) return;
        saveState({ ...loadState(), courses: loadState().courses.filter((c) => c.id !== id) });
        this.refresh();
      },
    });
  },

  /* ---------- 计算 ---------- */

  /**
   * 重算网格。
   *
   * 未设置学期开始时**不猜**：`week` 保持 1 但 `currentWeek` 记为 0，
   * 界面据此显示"先设置学期开始"的引导，而不是排一份"第 1 周"的假课表。
   */
  refresh() {
    const { termStart, courses } = loadState();
    const currentWeek = termStart ? weekOfTerm(termStart, todayParts()) : 0;
    const week = this.data.week;
    const columns = layoutOf(courses, week);
    this.setData({
      currentWeek,
      isCurrent: currentWeek >= 1 && week === currentWeek,
      weekRangeText: termStart ? this.weekRange(termStart, week) : '',
      weekHasCourse: columns.some((c) => c.blocks.length > 0),
      columns,
    });
  },

  /** 第 `week` 周对应的日期范围，如 `09-21 ~ 09-27` */
  weekRange(termStart: DateParts, week: number): string {
    const from = addDays(termStart, (week - 1) * 7);
    const to = addDays(from, 6);
    return `${formatDate(from).slice(5)} ~ ${formatDate(to).slice(5)}`;
  },
});
