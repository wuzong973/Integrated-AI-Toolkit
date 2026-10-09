/**
 * 单位换算（校园小工具）
 *
 * ## 为什么是本地页面而不是工具箱工具
 *
 * 与绩点 / AA 分账 / 抽签同因：工具箱的"同步"路径**仍会建作业记录并预扣额度**
 * （`ToolInvokeService.invoke`），量一次长度就留一条作业是明显的错配。
 * 纯计算没有副作用，就该待在本地 —— 秒出结果、离线可用、不占额度。
 *
 * ## 算法不在这里
 *
 * 全部在 `utils/unit-convert.ts`（纯函数、有单测）。页面只做四件事：
 *   ① 收集输入（一个数 + 源/目标两个单位）；
 *   ② 切组别时把单位重置成该组默认项，并**立即重算**；
 *   ③ 把"没填 / 不是数字 / 算不出"三种状态分开显示，不给半份结果；
 *   ④ 结果、对照表、人话说明**全在 TS 里算成字符串**再 setData —— WXML 里不能调函数。
 */
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import {
  convertUnit,
  findGroup,
  formatConvert,
  parseUnitInput,
  UNIT_GROUPS,
  unitRatioText,
  type UnitGroupKey,
} from '../../utils/unit-convert';

/** 组别 chip（只给界面用的两列） */
interface GroupChip {
  key: UnitGroupKey;
  label: string;
}

/** picker 的选项（`range-key="label"` 要的就是这个形状） */
interface UnitOption {
  key: string;
  label: string;
}

/** 常用对照的一行 */
interface ConvRow {
  key: string;
  label: string;
  text: string;
}

/** 结果区的三种状态：没填 / 填了但不是数字 / 可以算了 */
type Status = 'empty' | 'invalid' | 'ok';

const CHIPS: GroupChip[] = UNIT_GROUPS.map((g) => ({ key: g.key, label: g.label }));

/**
 * 常用对照：同一个数换算到该组**其余所有单位**（不含源单位）。
 *
 * 目标单位会在这里再出现一次 —— 它和上面那个大数字是同一份计算，正好互为核对；
 * 换算不出来的（单位不属于该组）直接不进表，免得出现一行空值。
 */
function buildRows(
  groupKey: UnitGroupKey,
  num: number,
  fromKey: string,
  units: readonly UnitOption[],
): ConvRow[] {
  const rows: ConvRow[] = [];
  for (const u of units) {
    if (u.key === fromKey) continue;
    const v = convertUnit(groupKey, num, fromKey, u.key);
    if (v === null) continue;
    rows.push({ key: u.key, label: u.label, text: formatConvert(v) });
  }
  return rows;
}

/** 该组默认的单位下标（`defaults` 写错时退回首尾，不让界面空白） */
function defaultIndexes(units: readonly UnitOption[], defaults: readonly string[]): [number, number] {
  const first = units.findIndex((u) => u.key === defaults[0]);
  const second = units.findIndex((u) => u.key === defaults[1]);
  return [first < 0 ? 0 : first, second < 0 ? Math.min(1, units.length - 1) : second];
}

/**
 * 算不出来时要清掉的展示字段。
 *
 * ⚠️ 必须清：把上一次的 "175 厘米" 留在屏上，用户改坏了输入却看到一个结果，
 * 就会开始怀疑是页面算错了 —— 宁可不给，也不给旧的。
 */
const CLEARED = {
  srcText: '',
  srcPlain: '',
  resultText: '',
  ratioText: '',
  rows: [] as ConvRow[],
};

Page({
  data: {
    chips: CHIPS,
    groupIndex: 0,
    groupKey: UNIT_GROUPS[0].key,
    units: [] as UnitOption[],
    fromIndex: 0,
    toIndex: 1,
    fromLabel: '',
    toLabel: '',
    /** 输入框草稿：允许是半截文本，由 `parseUnitInput` 判断能不能算 */
    valueText: '',
    status: 'empty' as Status,
    /** 非数字时的提示文案（空着就是"还没填"，与"填错了"分开显示） */
    invalidText: '',
    /** 以下五项都是算好的字符串，WXML 只负责摆 */
    srcText: '',
    /** 不带等号的同一句话（"1.75 米"），给"常用对照"那行的标题用 */
    srcPlain: '',
    resultText: '',
    ratioText: '',
    rows: [] as ConvRow[],
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

  /**
   * 切到第 `index` 组：单位对重置成该组默认项，**数字留着**（用户往往想拿同一个数
   * 去几组里各看一遍），然后立即重算 —— 不给"切完还要再点一下算"的空档。
   */
  applyGroup(index: number) {
    const chip = CHIPS[index];
    const g = chip ? findGroup(chip.key) : null;
    if (!chip || !g) return;
    const units: UnitOption[] = g.units.map((u) => ({ key: u.key, label: u.label }));
    const [fromIndex, toIndex] = defaultIndexes(units, g.defaults);
    this.setData(
      {
        groupIndex: index,
        groupKey: g.key,
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
    if (index === this.data.groupIndex) return;
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
   *
   * ⚠️ 空输入与"填了但不是数字"**必须分开**：只给一个空态，用户删掉小数点最后那位
   * 之后会看到"填一个数"，而他明明填了 —— 于是以为按钮坏了。
   */
  recompute() {
    const { groupKey, units, fromIndex, toIndex, valueText } = this.data;
    const from = units[fromIndex];
    const to = units[toIndex];
    if (!from || !to) return;

    const num = parseUnitInput(valueText);
    if (num === null) {
      const blank = !valueText.trim();
      this.setData({
        status: blank ? 'empty' : 'invalid',
        invalidText: blank ? '' : `「${valueText.trim()}」读不出数字，只填数字就行`,
        ...CLEARED,
      });
      return;
    }

    const out = convertUnit(groupKey, num, from.key, to.key);
    if (out === null) {
      // 单位不在该组内（数据被改坏才会到这一步）：给个可见状态，而不是显示半张空表
      this.setData({
        status: 'invalid',
        invalidText: '这两个单位不在同一组，换一组或重选单位',
        ...CLEARED,
      });
      return;
    }

    const plain = `${valueText.trim()} ${from.label}`;
    this.setData({
      status: 'ok',
      invalidText: '',
      srcText: `${plain} =`,
      srcPlain: plain,
      resultText: formatConvert(out),
      ratioText: unitRatioText(groupKey, from.key, to.key),
      rows: buildRows(groupKey, num, from.key, units),
    });
  },
});
