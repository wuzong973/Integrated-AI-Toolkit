/**
 * 考试倒计时（校园小工具）
 *
 * ## 为什么是本地页面
 *
 * 与绩点 / AA 分账同因：工具箱的"同步"路径**仍会建作业记录并预扣积分**，
 * 而倒计时是零副作用的纯计算 —— 存本地、离线可用、不占额度才对。
 *
 * ## 为什么用 `wx.setStorageSync` 而不是后端
 *
 * 考试日期是**纯个人数据**，既不需要跨端同步，也不该为它建一张表。
 * 本地存储的代价是换手机要重填 —— 这个取舍写在界面上，不让用户猜。
 *
 * ## 为什么日期必须用户自己选
 *
 * 见 `utils/countdown.ts` 文件头：内置"四六级 = 6 月第三个周六"这类规则是**编造**，
 * 实际每年都在变。这里只给常用**名称**快捷填充，日期一律用原生 date picker 让用户选，
 * 并在页面上写明"以官方通知为准"。
 */
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { toExamCalendarEvent } from '../../utils/calendar';
import {
  countdownText,
  EXAM_NAME_PRESETS,
  parseExams,
  sortExams,
  weeksText,
  type Exam,
} from '../../utils/countdown';
import { daysBetween, formatDate, parseDate, todayParts } from '../../utils/date-parts';

/** 本地存储键。带版本号：结构变了就换 key，旧数据自然作废，不做迁移。 */
const STORAGE_KEY = 'qz_exam_countdown_v1';

interface ExamRow {
  id: string;
  name: string;
  dateText: string;
  daysText: string;
  weeksText: string;
  state: 'future' | 'today' | 'past';
}

let seq = 0;
const nextId = (): string => `x${Date.now().toString(36)}${(seq += 1).toString(36)}`;

/** 今天往后 `n` 天（默认值用：新考试一般不会就是今天） */
function dateAfterDays(n: number): string {
  const t = todayParts();
  return formatDate(todayParts(new Date(t.y, t.m - 1, t.d + n)));
}

/** 读本地列表。存储可能被历史版本写坏，`parseExams` 会逐条校验并丢掉坏数据。 */
function loadExams(): Exam[] {
  try {
    return parseExams(wx.getStorageSync(STORAGE_KEY));
  } catch {
    // 存储不可用（隐私模式 / 配额满）时当作空列表，而不是让页面打不开
    return [];
  }
}

function saveExams(list: Exam[]): void {
  try {
    wx.setStorageSync(STORAGE_KEY, list);
  } catch {
    wx.showToast({ title: '本地保存失败，本次改动可能不保留', icon: 'none' });
  }
}

/** 一行考试的展示数据（WXML 不能调函数，文案必须在这里算好） */
function toRow(e: Exam, today: ReturnType<typeof todayParts>): ExamRow {
  const days = daysBetween(today, e.date);
  return {
    id: e.id,
    name: e.name,
    dateText: formatDate(e.date),
    daysText: countdownText(days),
    weeksText: weeksText(days),
    state: days < 0 ? 'past' : days === 0 ? 'today' : 'future',
  };
}

Page({
  data: {
    fxStyle: '',
    rows: [] as ExamRow[],
    namePresets: EXAM_NAME_PRESETS,
    /** 新增表单：名称草稿 */
    draftName: '',
    /** 新增表单：日期草稿（`YYYY-MM-DD`） */
    draftDate: '',
  },

  onLoad() {
    this.setData({ draftDate: dateAfterDays(30) }, () => this.refresh());
  },

  /**
   * 每次显示都重算：用户可能挂着页面过了午夜，
   * 那时"还有 1 天"其实已经变成"就是今天"了。
   * （首屏 onLoad 与 onShow 都会跑一次，refresh 是幂等的，重复无害。）
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

  /* ---------- 新增 ---------- */

  onNameInput(e: WechatMiniprogram.Input) {
    this.setData({ draftName: e.detail.value });
  },

  onPresetTap(e: WechatMiniprogram.TouchEvent) {
    this.setData({ draftName: (e.currentTarget.dataset as { name: string }).name });
  },

  onDraftDateChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ draftDate: String(e.detail.value) });
  },

  onAdd() {
    const name = this.data.draftName.trim();
    if (!name) {
      wx.showToast({ title: '先写个考试名称', icon: 'none' });
      return;
    }
    const date = parseDate(this.data.draftDate);
    if (!date) {
      wx.showToast({ title: '请选择考试日期', icon: 'none' });
      return;
    }
    const list = [...loadExams(), { id: nextId(), name, date }];
    saveExams(list);
    this.setData({ draftName: '' }, () => this.refresh());
  },

  /* ---------- 列表 ---------- */

  /** 直接改某一行的日期（考试改期很常见，不该逼用户删了重加） */
  onRowDateChange(e: WechatMiniprogram.PickerChange) {
    const id = (e.currentTarget.dataset as { id: string }).id;
    const date = parseDate(String(e.detail.value));
    if (!date) return;
    saveExams(loadExams().map((x) => (x.id === id ? { ...x, date } : x)));
    this.refresh();
  },

  onRemove(e: WechatMiniprogram.TouchEvent) {
    const id = (e.currentTarget.dataset as { id: string }).id;
    const target = loadExams().find((x) => x.id === id);
    wx.showModal({
      title: '删除这场考试？',
      content: target ? `${target.name}（${formatDate(target.date)}）` : '',
      confirmText: '删除',
      success: (res) => {
        if (!res.confirm) return;
        saveExams(loadExams().filter((x) => x.id !== id));
        this.refresh();
      },
    });
  },

  /* ---------- 加到系统日历 ---------- */

  /**
   * 把一场考试写进手机系统日历。
   *
   * ⚠️ 两条必须写清楚的失败分支：
   *   ① `wx.addPhoneCalendar` 需要基础库 **2.15.0+** —— 低版本上它是 `undefined`，
   *      **直接调用会抛异常**，所以先做存在性检查（`try/catch` 只是最后一道网）；
   *   ② **开发者工具通常不支持这个接口**，只在真机可用 —— 失败文案必须说出来，
   *      否则开发者会以为是自己代码写错了。
   *
   * 时间戳单位与本地时区口径见 `utils/calendar.ts` 文件头。
   */
  onAddToCalendar(e: WechatMiniprogram.TouchEvent) {
    const id = (e.currentTarget.dataset as { id: string }).id;
    const exam = loadExams().find((x) => x.id === id);
    if (!exam) return;

    // ⚠️ typings 里声明了它（所以 TS 不会报），但基础库 < 2.15.0 时**运行时是 undefined**
    if (typeof wx.addPhoneCalendar !== 'function') {
      wx.showModal({
        title: '这台设备用不了',
        content: '加到手机日历需要微信基础库 2.15.0 及以上。升级微信后再试。',
        showCancel: false,
      });
      return;
    }

    try {
      wx.addPhoneCalendar({
        ...toExamCalendarEvent(exam),
        success: () => wx.showToast({ title: '已加到手机日历', icon: 'success' }),
        fail: (err) => {
          const msg = String(err?.errMsg ?? '');
          const denied = /deny|auth/i.test(msg);
          wx.showModal({
            title: denied ? '没有日历权限' : '没能加进去',
            content: denied
              ? '你拒绝了日历权限。可以在「微信 → 设置 → 授权管理」里重新打开，再试一次。'
              : `微信返回：${msg || '未知原因'}。\n开发者工具通常不支持这个接口，请用真机试。`,
            showCancel: false,
          });
        },
      });
    } catch {
      wx.showToast({ title: '这个环境不支持加到日历', icon: 'none' });
    }
  },

  /** 重算并写回视图 */
  refresh() {
    const today = todayParts();
    this.setData({ rows: sortExams(loadExams(), today).map((e) => toRow(e, today)) });
  },
});
