/**
 * 抽签 · 点名 · 随机分组（校园小工具）
 *
 * ## 为什么是本地页面而不是工具箱工具
 *
 * 与绩点 / AA 分账同因：工具箱的"同步"路径**仍会建作业记录并预扣积分**
 * （`ToolInvokeService.invoke`），抽一次签留一条作业是明显的错配。
 * 纯计算没有副作用，就该待在本地 —— 秒出结果、离线可用、不占额度。
 *
 * ## 算法不在这里
 *
 * 全在 `utils/lottery.ts`（纯函数、41 条单测）。页面只做四件事：
 *   ① 收集名单（粘贴 / 本地存储）；
 *   ② 取随机源（优先密码学随机，见下）；
 *   ③ 把 `error` 原样显示出来 —— **算不出结果时不给半份结果**；
 *   ④ 如实标注本次结果的随机源强度。
 *
 * ## 随机源：优先 `wx.getRandomValues`，取不到就**说清楚**
 *
 * 抽签是"错了也看不出来"的典型，所以不能用 `Math.random` 一笔带过：
 *   · 能用 `wx.getRandomValues`（基础库 2.31.0+，密码学强度）就用它；
 *   · 用不了就降级到 `Math.random`，并把 `strong = false` 显示在结果卡上 ——
 *     **不假装"反正都是随机的"**。日常点名无所谓，抽奖就值得让用户知道。
 *
 * 随机源以**参数**形式传进 `utils/lottery.ts`，所以那边一行 wx API 都不碰，
 * 全部逻辑可以在 Node 里单测。
 */
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import {
  draw,
  formatDrawText,
  formatGroupText,
  groupInto,
  parseRoster,
  randomFromBytes,
  weakRandom,
  type RandomFn,
} from '../../utils/lottery';

/** 本地存储键。带版本号：结构变了就换 key，旧数据自然作废，不做迁移。 */
const STORAGE_KEY = 'qz_lottery_roster_v1';

/** 每次取多少随机字节：8 字节/人，洗牌与拒绝采样的重抽都够用 */
const BYTES_PER_PERSON = 8;
/** 字节数下限：名单很短时也不至于一开局就把池子用尽 */
const MIN_BYTES = 64;

type Mode = 'pick' | 'draw' | 'group';

interface ModeTab {
  key: Mode;
  label: string;
  hint: string;
}

const MODES: readonly ModeTab[] = [
  { key: 'pick', label: '点名', hint: '一次抽 1 个' },
  { key: 'draw', label: '抽签', hint: '一次抽 n 个' },
  { key: 'group', label: '分组', hint: '随机分成 n 组' },
];

interface GroupRow {
  key: string;
  title: string;
  members: string[];
}

/**
 * `wx.getRandomValues` 尚未进 `miniprogram-api-typings`，这里自己声明形状。
 *
 * ⚠️ 低版本基础库里它是 `undefined`，**直接调用会抛异常** ——
 * 所以先做存在性检查，`try/catch` 只是最后一道网，不是第一道。
 */
interface RandomValuesOption {
  length: number;
  success: (res: { randomValues: ArrayBuffer }) => void;
  fail: () => void;
}

type RandomValuesFn = (option: RandomValuesOption) => void;

function getRandomValuesFn(): RandomValuesFn | null {
  const api = (wx as unknown as { getRandomValues?: RandomValuesFn }).getRandomValues;
  return typeof api === 'function' ? api : null;
}

/**
 * 取一个随机源交给回调。
 *
 * 优先密码学随机；取不到就降级，并把 `strong = false` 一路带到界面。
 */
function takeRandom(count: number, cb: (rand: RandomFn, strong: boolean) => void): void {
  const fallback = (): void => cb(weakRandom, false);
  const api = getRandomValuesFn();
  if (!api) {
    fallback();
    return;
  }
  try {
    api({
      length: count,
      success: (res) => cb(randomFromBytes(new Uint8Array(res.randomValues)), true),
      fail: fallback,
    });
  } catch {
    fallback();
  }
}

Page({
  data: {
    modes: MODES,
    mode: 'pick' as Mode,
    /** 名单草稿（textarea 的双向绑定值） */
    rosterText: '',
    /** 解析后的名单（抽签真正用的那个） */
    names: [] as string[],
    /** 名单统计文案："7 个人 · 忽略 2 个重名" */
    rosterHint: '',
    /** 不重复点名：抽过的人不再进候选池 */
    noRepeat: true,
    /** 已经抽中过的人（仅"不重复点名"模式使用） */
    history: [] as string[],
    drawCount: 1,
    groupCount: 2,
    /** 以下四项是给 WXML 用的结果展示数据（WXML 里不能调函数） */
    picked: [] as string[],
    groups: [] as GroupRow[],
    resultText: '',
    error: '',
    /** 本次结果是否来自密码学随机 —— false 时结果卡上必须如实说明 */
    strong: true,
    hasResult: false,
    fxStyle: '',
  },

  onLoad() {
    let text = '';
    try {
      const raw = wx.getStorageSync(STORAGE_KEY);
      text = typeof raw === 'string' ? raw : '';
    } catch {
      // 存储不可用（隐私模式 / 配额满）时当作空名单，而不是让页面打不开
      text = '';
    }
    this.setData({ rosterText: text }, () => this.applyRoster());
  },

  /* ---------- 装饰视差 ---------- */

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

  /* ---------- 名单 ---------- */

  /** 只存草稿：边打字边解析会让统计数字一直跳，反而看不清自己在填什么 */
  onRosterInput(e: WechatMiniprogram.Input) {
    this.setData({ rosterText: e.detail.value });
  },

  onRosterClear() {
    this.setData({ rosterText: '' }, () => this.applyRoster());
  },

  /**
   * 应用名单：解析 → 存本地 → 重置结果与计数上限。
   *
   * 重名与空行的数量**如实显示**，不悄悄合并 ——
   * 同一份名单粘两遍会让这个人在抽签里被抽中的概率翻倍，属于必须说出来的偏差。
   */
  applyRoster() {
    const parsed = parseRoster(this.data.rosterText);
    const bits = [`${parsed.names.length} 个人`];
    if (parsed.duplicates.length) bits.push(`忽略 ${parsed.duplicates.length} 个重名`);
    if (parsed.blankLines) bits.push(`忽略 ${parsed.blankLines} 个空行`);

    try {
      wx.setStorageSync(STORAGE_KEY, this.data.rosterText);
    } catch {
      // 存不下不影响本次使用，只是下次进来要重填
    }

    const n = parsed.names.length;
    this.setData({
      names: parsed.names,
      rosterHint: bits.join(' · '),
      drawCount: Math.min(Math.max(1, this.data.drawCount), Math.max(1, n)),
      groupCount: Math.min(Math.max(2, this.data.groupCount), Math.max(2, n)),
      history: [],
      picked: [],
      groups: [],
      resultText: '',
      error: '',
      hasResult: false,
    });
  },

  /* ---------- 模式与参数 ---------- */

  onModeTap(e: WechatMiniprogram.TouchEvent) {
    const mode = (e.currentTarget.dataset as { key: Mode }).key;
    if (mode === this.data.mode) return;
    // 换模式时清掉上一个模式的结果：留着会让人以为"分组"抽出了那一个人
    this.setData({ mode, picked: [], groups: [], resultText: '', error: '', hasResult: false });
  },

  /** 抽签人数 / 分组数的加减。上限是名单人数 —— 超出必然报错，不如直接夹住 */
  onCountStep(e: WechatMiniprogram.TouchEvent) {
    const { field, delta } = e.currentTarget.dataset as { field: string; delta: string };
    const isGroup = field === 'groupCount';
    const min = isGroup ? 2 : 1;
    const max = Math.max(min, this.data.names.length);
    const cur = isGroup ? this.data.groupCount : this.data.drawCount;
    const next = Math.min(max, Math.max(min, cur + Number(delta)));
    this.setData(isGroup ? { groupCount: next } : { drawCount: next });
  },

  onToggleNoRepeat() {
    // 关掉"不重复"时一并清空已抽记录：留着会让用户以为下次还会跳过这些人
    this.setData({ noRepeat: !this.data.noRepeat, history: [] });
  },

  onResetHistory() {
    this.setData({ history: [], picked: [], resultText: '', hasResult: false });
  },

  /* ---------- 抽 ---------- */

  onStart() {
    const { names } = this.data;
    if (!names.length) {
      wx.showToast({ title: '先填名单', icon: 'none' });
      return;
    }
    const bytes = Math.max(MIN_BYTES, BYTES_PER_PERSON * names.length);
    takeRandom(bytes, (rand, strong) => this.run(rand, strong));
  },

  /**
   * 用给定随机源算结果。
   *
   * 算法全在 `utils/lottery.ts`，这里只负责把结果摆到 data 上，
   * 并在"不重复点名"时把抽中的人记进 history。
   */
  run(rand: RandomFn, strong: boolean) {
    const { names, mode, drawCount, groupCount, noRepeat, history } = this.data;

    if (mode === 'group') {
      const r = groupInto(names, groupCount, rand);
      this.setData({
        strong,
        error: r.error,
        picked: [],
        resultText: r.error ? '' : formatGroupText(r.groups),
        groups: r.groups.map((members, i) => ({
          key: `g${i}`,
          title: `第 ${i + 1} 组 · ${members.length} 人`,
          members,
        })),
        hasResult: !r.error,
      });
      return;
    }

    const count = mode === 'pick' ? 1 : drawCount;
    const exclude = mode === 'pick' && noRepeat ? history : [];
    const r = draw(names, count, rand, exclude);

    this.setData({
      strong,
      error: r.error,
      groups: [],
      picked: r.picked,
      resultText: r.error ? '' : formatDrawText(r.picked),
      hasResult: !r.error,
      history: mode === 'pick' && noRepeat && !r.error ? [...history, ...r.picked] : history,
    });
  },

  onCopyResult() {
    if (!this.data.resultText) return;
    wx.setClipboardData({ data: this.data.resultText });
  },
});
