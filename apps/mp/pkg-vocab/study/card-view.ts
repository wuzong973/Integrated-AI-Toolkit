/**
 * 记单词 · 学习页的**题型视图规则**（纯逻辑，无 IO）
 *
 * ## 为什么从页面里拆出来
 *
 * 两个原因，都不是"为了好看"：
 *
 * ① **页面文件贴着 300 行红线**（`lint` 的 `max-lines`）。拆出去之后
 *    页面只管"拉数据 / 派发事件"，题型到界面的映射单独可读。
 *
 * ② 它是**纯函数**，所以能直接单测。散在页面里就只能靠人肉点四种题型去试 ——
 *    而"新题型忘了加分支"的表现是**一道完全空白的题**，
 *    没有任何报错。拆出来之后可以用一条用例钉住"每种题型都有兜底"。
 *
 * ## 这张表是唯一决定"哪些区块要渲染"的地方
 *
 * 不要退回在 WXML 里写 `wx:if="{{type === 'spelling'}}"`：那样漏一个分支
 * 就是一道空白题，且编译、`tsc`、所有守卫都不报。
 */

import type { VocabCard } from '../../utils/vocab-types';

/** 视图上的题型。后端加了新题型时由 `FALLBACK_TYPE` 兜底 */
export type ViewType = 'meaning' | 'spelling' | 'listening' | 'cloze';

/** 题型 → 界面要显示的区块（页面 `data` 里的 `show*` / `has*` 系列直接来自它） */
export interface CardView {
  type: ViewType;
  /** 题面上要不要显示词形（听音辨词**不能**显示，否则这道题就没了） */
  showWord: boolean;
  /** 题面上要不要显示音标 */
  showPhonetic: boolean;
  /** 题面上要不要显示中文释义（拼写题的题面就是它） */
  showSense: boolean;
  /** 要不要渲染选项列表（拼写题没有选项） */
  hasOptions: boolean;
  /** 要不要渲染输入框（拼写题） */
  hasInput: boolean;
  /** 要不要显示喇叭 */
  showSpeaker: boolean;
  /** 要不要自动朗读（听音辨词进题即读，这是它的题面，不是辅助功能） */
  autoSpeak: boolean;
  /** 题型标签（界面上的小胶囊） */
  label: string;
  /** 作答说明（"选出正确释义" / "把这个词拼出来" …） */
  hint: string;
}

/** 标签与说明。新增题型时这里与 `VIEW_RULES` 一起加 */
const TYPE_META: Record<ViewType, { label: string; hint: string }> = {
  meaning: { label: '看词选义', hint: '选出正确的中文释义' },
  spelling: { label: '看义拼词', hint: '根据释义把这个词拼出来' },
  listening: { label: '听音辨词', hint: '听发音，选出正确的词' },
  cloze: { label: '例句填空', hint: '选出能填进空格的词' },
};

/**
 * 题型 → 界面规则。
 *
 * ⚠️ 这张表是**唯一**决定"哪些区块要渲染"的地方。散在 WXML 里写
 * `wx:if="{{type === 'spelling'}}"` 会让"新题型忘了加分支"变成
 * **一道完全空白的题**，而且没有任何报错。集中成表之后，
 * 新题型只要在这一处加一行，漏了就是 `FALLBACK_TYPE` 兜底而不是空白。
 */
const VIEW_RULES: Record<ViewType, Omit<CardView, 'type' | 'label' | 'hint'>> = {
  // 看词选义：给词形 + 音标，选释义
  meaning: {
    showWord: true,
    showPhonetic: true,
    showSense: false,
    hasOptions: true,
    hasInput: false,
    showSpeaker: true,
    autoSpeak: false,
  },
  // 看义拼词：给中文释义，拼英文（没有选项，题面上也不能有词形）
  spelling: {
    showWord: false,
    showPhonetic: false,
    showSense: true,
    hasOptions: false,
    hasInput: true,
    showSpeaker: true,
    autoSpeak: false,
  },
  // 听音辨词：只给声音，选词形（**词形绝不能显示**，否则这道题就没了）
  listening: {
    showWord: false,
    showPhonetic: false,
    showSense: false,
    hasOptions: true,
    hasInput: false,
    showSpeaker: true,
    autoSpeak: true,
  },
  // 例句填空：给挖空的例句，选词形
  cloze: {
    showWord: false,
    showPhonetic: false,
    showSense: false,
    hasOptions: true,
    hasInput: false,
    showSpeaker: true,
    autoSpeak: false,
  },
};

/**
 * 兜底题型：后端出了小程序不认识的题型时按它渲染。
 *
 * 选看词选义是因为它对素材的要求最低（词形 + 释义选项），
 * 而这两个字段在其余题型的响应里也都带着 —— 一定能画出东西来。
 */
export const FALLBACK_TYPE: ViewType = 'meaning';

/**
 * 卡片 → 视图。
 *
 * **不认识的题型降级成看词选义**，而不是"原样渲染"：新题型的字段布局
 * 小程序没见过，硬渲染出来的多半是空白。
 *
 * 注意这里返回的 `type` 只用于**渲染**；提交什么、怎么判卷始终按后端的题型来
 * （选择题传选项 key、拼写/填空传用户输入），两者不必是同一个值。
 */
export function toCardView(card: VocabCard): CardView {
  const known = card.type in VIEW_RULES ? (card.type as ViewType) : FALLBACK_TYPE;
  const rules = VIEW_RULES[known];
  const meta = TYPE_META[known];
  return { type: known, label: meta.label, hint: meta.hint, ...rules };
}

/** 供单测断言"四种题型都登记了规则"（漏一个就是一道空白题） */
export const REGISTERED_TYPES: readonly ViewType[] = ['meaning', 'spelling', 'listening', 'cloze'];
