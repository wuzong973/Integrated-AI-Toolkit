import { describe, expect, it } from 'vitest';

import { FALLBACK_TYPE, REGISTERED_TYPES, toCardView } from '../apps/mp/pkg-vocab/study/card-view';

/**
 * 学习页的题型视图规则（M4-15）
 *
 * ⚠️ 位置说明：小程序的测试**必须放 `tests/`**，不能放 `apps/mp/` 里 ——
 * `miniprogramRoot` 就是 `apps/mp/`，即发布包本身（见 `vitest.config.ts`）。
 *
 * ## 这里钉的是"一道题不会渲染成空白"
 *
 * 题型到界面的映射散在 WXML 里写 `wx:if="{{type === 'spelling'}}"` 的话，
 * "新题型忘了加分支"的表现是**一道完全空白的题** —— 编译、`tsc`、
 * 所有守卫都不报。所以规则集中成表，并用用例钉住"每种题型都有兜底"。
 */

/** 造一张卡片，只关心题型 */
function card(type: string): Parameters<typeof toCardView>[0] {
  return {
    wordId: 'w1',
    type,
    spelling: 'accessible',
    phonetic: '/əkˈsesəbl/',
    difficulty: 3,
    isNew: true,
    options: [{ key: 'a', text: '可接近的' }],
    prompt: '',
    promptZh: '',
    senseText: '可接近的',
  };
}

describe('题型视图规则', () => {
  it('四种题型都登记了规则（漏一个就是一道空白题）', () => {
    for (const t of REGISTERED_TYPES) {
      const view = toCardView(card(t));
      expect(view.type).toBe(t);
      expect(view.label.length).toBeGreaterThan(0);
      expect(view.hint.length).toBeGreaterThan(0);
    }
  });

  it('⭐ 听音辨词**不显示词形**：显示了这道题就不存在了', () => {
    const view = toCardView(card('listening'));
    expect(view.showWord).toBe(false);
    expect(view.showPhonetic).toBe(false);
    // 它是唯一一个进题就自动朗读的题型 —— 声音就是它的题面
    expect(view.autoSpeak).toBe(true);
    expect(view.showSpeaker).toBe(true);
  });

  it('看义拼词：给释义、要输入、没有选项，且题面上不能有词形', () => {
    const view = toCardView(card('spelling'));
    expect(view.showSense).toBe(true);
    expect(view.hasInput).toBe(true);
    expect(view.hasOptions).toBe(false);
    expect(view.showWord).toBe(false);
    // 拼写题不自动读 —— 读了就等于把答案念出来了
    expect(view.autoSpeak).toBe(false);
  });

  it('看词选义：给词形与音标，选释义，不显示释义题面', () => {
    const view = toCardView(card('meaning'));
    expect(view.showWord).toBe(true);
    expect(view.showPhonetic).toBe(true);
    expect(view.hasOptions).toBe(true);
    expect(view.hasInput).toBe(false);
    expect(view.showSense).toBe(false);
  });

  it('例句填空：给挖空例句 + 选项，题面上不能有词形（空就在那句里）', () => {
    const view = toCardView(card('cloze'));
    expect(view.hasOptions).toBe(true);
    expect(view.showWord).toBe(false);
    expect(view.showSense).toBe(false);
    expect(view.autoSpeak).toBe(false);
  });

  it('⭐ 不认识的题型降级成看词选义，而不是渲染一片空白', () => {
    const view = toCardView(card('brand_new_type_from_server'));
    expect(view.type).toBe(FALLBACK_TYPE);
    // 降级后的规则必须是"能画出东西"的那一套：要词形、要选项
    expect(view.showWord).toBe(true);
    expect(view.hasOptions).toBe(true);
    expect(view.showSense).toBe(false);
    // 而且不能因为降级就不显示任何操作入口
    expect(view.hasInput).toBe(false);
  });

  it('每道题都恰有一个作答入口（选项或输入框），不会两个都没有', () => {
    for (const t of [...REGISTERED_TYPES, 'unknown_type']) {
      const view = toCardView(card(t));
      expect(view.hasOptions || view.hasInput).toBe(true);
    }
  });
});
