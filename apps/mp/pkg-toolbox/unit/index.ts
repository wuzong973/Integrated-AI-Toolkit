/**
 * 单位换算（本地小工具）
 *
 * ## 与 pkg-toolkit/unit-convert 的分工
 *
 * 那边是"校园小工具"的**全七组**完整版；这里是工具箱首页一屏能点完的轻量入口，
 * 只放最常用的三类（长度 / 重量 / 温度）。算法与口径**零拷贝**：
 * 全部复用 `utils/unit-convert.ts`（纯函数、有单测），页面只做"收输入 → 算 → 三态展示"。
 *
 * ## 交互口径
 *
 * · 边打字边算（`onValueInput` 即重算），没有"点一下才算"的按钮；
 * · 没填 / 读不出数字 / 算不出三种状态**分开显示**，不给半份结果；
 * · 算不出时清掉上一次的结果 —— 宁可不给，也不给旧的（看起来像算错了）。
 */
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import {
  convertUnit,
  findGroup,
  formatConvert,
  parseUnitInput,
  unitRatioText,
  type UnitGroupKey,
} from '../../utils/unit-convert';

/** 本地版只放三类：常用度高，单屏 chips 排得下 */
const GROUP_KEYS: readonly UnitGroupKey[] = ['length', 'weight', 'temperature'];

/** 组别 chip（`wx:key="key"`） */
interface GroupChip {
  key: UnitGroupKey;
  label: string;
}

/** picker 选项（`range-key="label"` 要的就是这个形状） */
interface UnitOption {
  key: string;
  label: string;
}

/** 结果区三态：没填 / 读不出数字 / 可以算了 */
type Status = 'empty' | 'invalid' | 'ok';

/** 按白名单顺序取组定义，顺便挡掉表里 key 写坏的情况 */
const CHIPS: GroupChip[] = GROUP_KEYS.reduce<GroupChip[]>((acc, key) => {
  const g = findGroup(key);
  if (g) acc.push({ key: g.key, label: g.label });
  return acc;
}, []);

/** 该组全部单位（转成 picker 可用的普通对象数组） */
function unitOptions(groupKey: UnitGroupKey): UnitOption[] {
  const g = findGroup(groupKey);
  return g ? g.units.map((u) => ({ key: u.key, label: u.label })) : [];
}

/** 该组默认的单位下标（defaults 写错时退回首/第二个，不让界面空白） */
function defaultIndexes(units: readonly UnitOption[], groupKey: UnitGroupKey): [number, number] {
  const g = findGroup(groupKey);
  const defaults = g ? g.defaults : ['', ''];
  const first = units.findIndex((u) => u.key === defaults[0]);
  const second = units.findIndex((u) => u.key === defaults[1]);
  return [first < 0 ? 0 : first, second < 0 ? Math.min(1, units.length - 1) : second];
}

/** 算不出来时要清掉的展示字段 */
const CLEARED = {
  srcText: '',
  resultText: '',
  ratioText: '',
};

Page({
  data: {
    chips: CHIPS,
    groupIndex: 0,
    groupKey: 'length' as UnitGroupKey,
    units: [] as UnitOption[],
    fromIndex: 0,
    toIndex: 1,
    fromLabel: '',
    toLabel: '',
    /** 输入框草稿：允许是半截文本，能不能算交给 `parseUnitInput` 判断 */
    valueText: '',
    status: 'empty' as Status,
    invalidText: '',
    /** 以下三项都是算好的字符串，WXML 只负责摆 */
    srcText: '',
    resultText: '',
    ratioText: '',
    fxStyle: '',
  },

  onLoad() {
    this.applyGroup(0);
  },

  /* ---------- 装饰视差 ---------- */

  onShow() {
    fxEnableTilt(this);
  },

  onHide() {
    fxDisableTilt();
  },

  onUnload() {
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

  /* ---------- 组别 ---------- */

  /** 切组：单位对重置成该组默认项，数字留着（往往想拿同一个数各看一遍），立即重算 */
  applyGroup(index: number) {
    const chip = CHIPS[index];
    if (!chip) return;
    const units = unitOptions(chip.key);
    if (units.length === 0) return;
    const [fromIndex, toIndex] = defaultIndexes(units, chip.key);
    this.setData(
      {
        groupIndex: index,
        groupKey: chip.key,
        units,
        fromIndex,
        toIndex,
        fromLabel: units[fromIndex].label,
        toLabel: units[toIndex].label,
      },
      () => this.recompute(),
    );
  },

  onGroupTap(e: WechatMiniprogram.TouchEvent) {
    const index = Number((e.currentTarget.dataset as { index: string }).index);
    if (!Number.isInteger(index) || index === this.data.groupIndex) return;
    this.applyGroup(index);
  },

  /* ---------- 输入 ---------- */

  onValueInput(e: WechatMiniprogram.Input) {
    this.setData({ valueText: e.detail.value }, () => this.recompute());
  },

  onFromChange(e: WechatMiniprogram.PickerChange) {
    const i = Number(e.detail.value);
    const u = this.data.units[i];
    if (!u) return;
    this.setData({ fromIndex: i, fromLabel: u.label }, () => this.recompute());
  },

  onToChange(e: WechatMiniprogram.PickerChange) {
    const i = Number(e.detail.value);
    const u = this.data.units[i];
    if (!u) return;
    this.setData({ toIndex: i, toLabel: u.label }, () => this.recompute());
  },

  /** 交换源/目标单位：下一次输入就是反方向 */
  onSwap() {
    const { fromIndex, toIndex, units } = this.data;
    const from = units[fromIndex];
    const to = units[toIndex];
    if (!from || !to) return;
    this.setData(
      { fromIndex: toIndex, toIndex: fromIndex, fromLabel: to.label, toLabel: from.label },
      () => this.recompute(),
    );
  },

  /* ---------- 算 ---------- */

  /**
   * 重算并把三态写进 data。
   * 空输入与"填了但不是数字"必须分开：只给一个空态，用户删掉小数点后那位
   * 会看到引导文案，而他明明填了 —— 就会以为页面坏了。
   */
  recompute() {
    const { groupKey, units, fromIndex, toIndex, valueText } = this.data;
    const from = units[fromIndex];
    const to = units[toIndex];
    if (!from || !to) return;

    const num = parseUnitInput(valueText);
    if (num === null) {
      const blank = valueText.trim() === '';
      this.setData({
        status: blank ? 'empty' : 'invalid',
        invalidText: blank ? '' : `「${valueText.trim()}」读不出数字，只填数字就行`,
        ...CLEARED,
      });
      return;
    }

    const out = convertUnit(groupKey, num, from.key, to.key);
    if (out === null) {
      // 单位不在该组内（数据被改坏才会到这一步）：给可见状态，不显示半份结果
      this.setData({
        status: 'invalid',
        invalidText: '这两个单位不在同一组，换一组或重选单位',
        ...CLEARED,
      });
      return;
    }

    this.setData({
      status: 'ok',
      invalidText: '',
      srcText: `${valueText.trim()} ${from.label} =`,
      resultText: formatConvert(out),
      ratioText: unitRatioText(groupKey, from.key, to.key),
    });
  },
});
