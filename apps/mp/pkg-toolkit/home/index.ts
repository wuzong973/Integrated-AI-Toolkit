/**
 * 校园小工具（列表页）
 *
 * ## 为什么要有这一页
 *
 * 工具箱主页面（`pages/toolbox`）是"AI 能力"的入口，走的是**作业 + 计费**链路；
 * 而绩点、AA 分账这类**纯本地计算**不该混在里面（算一次留一条作业、扣一次额度是错配）。
 * 所以给它们一个独立的列表页，也让"哪些是本地工具、哪些是 AI 工具"一眼分得清。
 *
 * ## 只列已实现的
 *
 * ⚠️ 刻意**不放"敬请期待"占位卡** —— 摆一个点不动的入口，用户只会以为是坏了。
 * 每做完一个工具就加一行，宁缺毋滥。
 */
import {
  fxDisableTilt,
  fxEnableTilt,
  fxEnd,
  fxMove,
  fxStart,
  staggerClass,
} from '../../utils/fx';

interface ToolkitItem {
  key: string;
  name: string;
  desc: string;
  icon: string;
  url: string;
  /** 逐条弹性入场的类名（WXML 不能调函数，所以在数据里算好；见 §四） */
  anim: string;
}

const TOOL_ITEMS: Omit<ToolkitItem, 'anim'>[] = [
  {
    key: 'gpa',
    name: '绩点计算',
    desc: '两种口径，边填边算，不上传成绩',
    icon: 'qz-i-learn',
    url: '/pkg-toolkit/gpa/index',
  },
  {
    key: 'split-bill',
    name: 'AA 分账',
    desc: '谁该给谁多少，自动算出一套转账方案',
    icon: 'qz-i-wallet',
    url: '/pkg-toolkit/split-bill/index',
  },
  {
    key: 'lottery',
    name: '抽签',
    desc: '点名、抽签、随机分组，用设备安全随机数',
    icon: 'qz-i-gift',
    url: '/pkg-toolkit/lottery/index',
  },
  {
    key: 'countdown',
    name: '考试倒计时',
    desc: '四六级、考研、期末，日期自己填，只存本机',
    icon: 'qz-i-clock',
    url: '/pkg-toolkit/countdown/index',
  },
  {
    key: 'timetable',
    name: '课程表',
    desc: '周视图排课，支持单双周与周次范围，只存本机',
    icon: 'qz-i-orders',
    url: '/pkg-toolkit/timetable/index',
  },
  {
    key: 'trip',
    name: '行程',
    desc: '按天排行程，时间冲突会当场提示',
    icon: 'qz-i-rocket',
    url: '/pkg-toolkit/trip/index',
  },
  {
    key: 'unit-convert',
    name: '单位换算',
    desc: '长度·重量·温度·存储，7 组互转，边填边出',
    icon: 'qz-i-chart',
    url: '/pkg-toolkit/unit-convert/index',
  },
  {
    key: 'date-calc',
    name: '日期差计算',
    desc: '两个日期差几天、N 天后是哪天，顺带算出周几',
    icon: 'qz-i-calendar',
    url: '/pkg-toolkit/date-calc/index',
  },
  {
    key: 'text-tools',
    name: '字数统计',
    desc: '汉字与英文单词分开数，八个操作就地改写',
    icon: 'qz-i-doc',
    url: '/pkg-toolkit/text-tools/index',
  },
];

/** 九个本地工具，逐条错开 50~440ms 弹性上浮（第 9 项起延迟封顶，见 staggerClass） */
const TOOLS: ToolkitItem[] = TOOL_ITEMS.map((item, index) => ({
  ...item,
  anim: staggerClass(index, 'qz-an-spring'),
}));

Page({
  data: {
    fxStyle: '',
    tools: TOOLS,
  },

  /* ---------- 装饰视差（倾斜只在 onShow 开，onHide 关；只动装饰层） ---------- */

  onShow() {
    fxEnableTilt(this);
  },

  onHide() {
    fxDisableTilt();
  },

  onFxStart(e: WechatMiniprogram.TouchEvent) {
    fxStart(this, e);
  },

  onFxMove(e: WechatMiniprogram.TouchEvent) {
    fxMove(this, e);
  },

  onFxEnd() {
    fxEnd(this);
  },

  onToolTap(e: WechatMiniprogram.TouchEvent) {
    const url = (e.currentTarget.dataset as { url: string }).url;
    // ⚠️ 分包页用 navigateTo；switchTab 只用于 tabBar 页
    wx.navigateTo({ url });
  },
});
