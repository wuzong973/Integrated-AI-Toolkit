/**
 * 练习中心 · 取题与摆题（页面与接口之间的那一层）
 *
 * ## 为什么从页面里抽出来
 *
 * `session/index.ts` 里的"取一批 → 摆到第 i 题"这段逻辑**不依赖页面实例**，
 * 只依赖 `data` 里的几个字段和接口返回值。留在页面里有两个代价：
 * ① 页面文件被顶到 300 行上限之外（lint 硬红线）；
 * ② 这些分支（空态 / 作文题 / 句子题）**在 vitest 里测不到**（页面文件跑不起来）。
 *
 * ## ⚠️ 两条不报错的失效都在这层拦
 *
 * ① **空队列不能当作"练完了"** —— 后端 `emptyReason` 区分了"今天到期题练完了"
 *    与"题库还没建好"，两者文案完全不同。统一写成"练完了"会让"题库没导数据"
 *    看起来像"你已经练完了"。
 * ② **`en` 为 `null` 是合法的**（`recall` 模式刻意不下发），不能被当成"加载失败"。
 */

import type { PracticeCardsResult, SentenceCard, TopicCard } from './practice-types';
import { baseOf, batchShell, RESET_ANSWER, shuffleChunks, toOutlineRows, topicBaseOf, viewOf } from './practice-view';

/** 摆好一题之后要写进 `data` 的全部字段 */
export interface SlotPatch {
  [key: string]: unknown;
}

/** 队列为空时给出的空态 patch */
export interface EmptyPatch extends SlotPatch {
  emptyText: string;
}

/**
 * 一批题面 → `data` 的 patch。
 *
 * `empty` 为 `true` 表示**队列是空的**，调用方不要再摆题（`patch` 里已经
 * 把 `finished` 置位、并写好了空态文案）。
 */
export function queuePatch(res: PracticeCardsResult): { patch: SlotPatch; empty: boolean } {
  const total = res.cards.length + res.topics.length;
  if (total === 0) {
    return {
      empty: true,
      patch: {
        loading: false,
        error: '',
        cards: [],
        topics: [],
        total: 0,
        finished: true,
        // ⚠️ 原样转述后端那句 —— "练完了" 与 "题库没建好" 对用户是两件事
        emptyText: res.emptyReason || '今天这个模块没有要练的题，明天再来',
      },
    };
  }
  return {
    empty: false,
    // 换了一批题 → 清掉上一批的空态文案（不清会串场，且不报错）
    patch: { ...batchShell(res), cards: res.cards, topics: res.topics, total, emptyText: '' },
  };
}

/** 第 i 题 → `data` 的 patch（自动区分作文题与句子题） */
export function slotPatch(cards: SentenceCard[], topics: TopicCard[], mode: string, i: number): SlotPatch {
  const topic = topics[i];
  const view = viewOf(mode);
  if (topic) return topicSlot(topic, view.hint, view.kind, i);

  const card = cards[i];
  if (!card) return {};
  return {
    ...baseOf(i, card, view),
    kind: view.kind,
    hint: view.hint,
    chunks: view.showChunks ? shuffleChunks(card) : [],
    pickedIdx: [],
    assembled: '',
    typed: '',
    ...RESET_ANSWER,
  };
}

/** 作文题的题面（与句子题字段不相交，单独一支更清楚） */
function topicSlot(topic: TopicCard, hint: string, kind: string, i: number): SlotPatch {
  return {
    ...topicBaseOf(i, topic),
    kind,
    hint,
    topicTitle: topic.title,
    topicBrief: topic.zhBrief,
    outline: toOutlineRows([topic]),
    minWords: topic.minWords,
    essayText: '',
    essayWords: 0,
    // ⚠️ 句子题的输入框也要清：同一天里"句子模块练完切到作文模块"会复用同一个页面，
    // 不清就会把上一条拼到一半的句子/翻译留在作文题的输入框里（不报错）
    chunks: [],
    pickedIdx: [],
    assembled: '',
    typed: '',
    ...RESET_ANSWER,
  };
}
