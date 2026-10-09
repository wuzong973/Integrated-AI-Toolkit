import { describe, expect, it } from 'vitest';

import {
  baseOf,
  batchShell,
  buildReviewFields,
  countWords,
  feedbackText,
  modeTitle,
  nextTipOf,
  RESET_ANSWER,
  shuffleChunks,
  toOutlineRows,
  toWordRows,
  toggleChunk,
  viewOf,
} from '../apps/mp/utils/practice-view';
import { queuePatch, slotPatch } from '../apps/mp/utils/practice-queue';
import type { PracticeCardsResult, SentenceCard, TopicCard } from '../apps/mp/utils/practice-types';

/**
 * 练习中心题面渲染规则（M4-16）
 *
 * ⚠️ 位置说明：小程序的测试**必须放 `tests/`**（`miniprogramRoot` 就是发布包本身）。
 *
 * ## 这里钉的是三件"不报错但会错"的事
 *
 * ① **模式 → 五面旗**：答错这一张表的表现是"中译英页面上印着英文答案"（送分）
 *    或"口语题不给句子"（没法开口）—— 两者都不报错。
 * ② **`shuffleChunks` 必须确定性**：`Math.random()` 会让"答错重做"变成"换了道题"，
 *    而且 `sort(() => Math.random() - 0.5)` 有偏且永不报错。
 * ③ **`RESET_ANSWER` 必须覆盖所有作答字段**：漏一项就串到下一题
 *    （上一题的范文出现在下一题下面），同样不报错。
 */

/** 造一张句子卡 */
function card(id: string, en: string | null, chunks?: { en: string; zh: string }[]): SentenceCard {
  return {
    id,
    en,
    zh: '译文',
    chunks: chunks ?? null,
  } as SentenceCard;
}

/** 造一道作文题 */
function topic(id: string): TopicCard {
  return {
    id,
    title: 'My Campus Life',
    zhBrief: '写写你的校园生活',
    outline: ['开头点题', '正文展开', '结尾总结'],
    minWords: 80,
  } as TopicCard;
}

/** 造一批题面响应 */
function queue(cards: SentenceCard[], topics: TopicCard[] = []): PracticeCardsResult {
  return {
    module: 'sentence',
    modes: ['chunks', 'recall'],
    mode: 'chunks',
    quota: 10,
    cards,
    topics,
    emptyReason: '',
  } as PracticeCardsResult;
}

describe('模式 → 五面旗', () => {
  it('⭐ 五种模式都有规则，且不认识的模式落到 unknown 而不是空白', () => {
    for (const m of ['chunks', 'recall', 'listen', 'speak', 'write']) {
      const v = viewOf(m);
      expect(v.kind).toBe(m);
      expect(v.hint.length).toBeGreaterThan(0);
    }
    // ⚠️ 后端加新模式时，界面必须给一句提示 —— 渲染成空白是**没有任何报错**的失效
    const unknown = viewOf('brand-new-mode');
    expect(unknown.kind).toBe('unknown');
    expect(unknown.hint.length).toBeGreaterThan(0);
    expect(unknown.showEn).toBe(false);
    expect(unknown.showRecorder).toBe(false);
  });

  it('⭐⭐ 中译英不下发英文、口语必须下发英文 —— 这两条反了就是送分 / 没法答', () => {
    expect(viewOf('recall').showEn).toBe(false);
    expect(viewOf('speak').showEn).toBe(true);
    // 连词成句给砖块但题面不给整句
    expect(viewOf('chunks').showChunks).toBe(true);
    expect(viewOf('chunks').showEn).toBe(false);
    // 听写只有音频、没有文本
    expect(viewOf('listen').showSpeaker).toBe(true);
    expect(viewOf('listen').showEn).toBe(false);
  });

  it('每个模式都恰好有一个"主交互"（砖块 / 录音 / 喇叭 / 输入框）', () => {
    const mains: Record<string, string> = {
      chunks: 'showChunks',
      recall: 'none',
      listen: 'showSpeaker',
      speak: 'showRecorder',
      write: 'none',
    };
    for (const [mode, key] of Object.entries(mains)) {
      const v = viewOf(mode) as unknown as Record<string, boolean>;
      if (key !== 'none') expect(v[key]).toBe(true);
    }
  });
});

describe('shuffleChunks 的确定性', () => {
  const chunks = [
    { en: 'I', zh: '' },
    { en: 'like', zh: '' },
    { en: 'reading', zh: '' },
    { en: 'books', zh: '' },
  ];

  it('⭐ 同一句话每次进来顺序完全一样（否则"答错重做"像是换了道题）', () => {
    const a = shuffleChunks(card('c1', null, chunks));
    const b = shuffleChunks(card('c1', null, chunks));
    expect(a.map((x) => x.en)).toEqual(b.map((x) => x.en));
  });

  it('打乱后不再是原序（否则用户会以为功能坏了）', () => {
    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']) {
      const out = shuffleChunks(card(id, null, chunks));
      expect(out.map((x) => x.en)).not.toEqual(chunks.map((x) => x.en));
    }
  });

  it('不丢块也不重复（打乱是置换，不是抽样）', () => {
    const out = shuffleChunks(card('c9', null, chunks));
    expect(out).toHaveLength(chunks.length);
    expect([...out.map((x) => x.en)].sort()).toEqual([...chunks.map((x) => x.en)].sort());
    expect(out.map((x) => x.idx).sort((p, q) => p - q)).toEqual([0, 1, 2, 3]);
  });

  it('不足两块时原样返回（没得洗）', () => {
    expect(shuffleChunks(card('c1', null, [{ en: 'Hi', zh: '' }]))).toHaveLength(1);
    expect(shuffleChunks(card('c1', null, undefined))).toHaveLength(0);
  });
});

describe('题面字段组装', () => {
  it('⭐ `en` 为 null 时如实留空，不兜一句假文案', () => {
    const patch = baseOf(0, card('c1', null), viewOf('recall'));
    // 兜 '（读出来）' 之类会让"忘了隐藏答案"的回归变得看不出来
    expect(patch.en).toBe('');
    expect(patch.showEn).toBe(false);
  });

  it('`showChunks` 还要砖块真有内容，否则留一个点不了的框', () => {
    const empty = baseOf(0, card('c1', null, []), viewOf('chunks'));
    expect(empty.showChunks).toBe(false);
    const ok = baseOf(0, card('c1', null, [{ en: 'Hi', zh: '' }, { en: 'there', zh: '' }]), viewOf('chunks'));
    expect(ok.showChunks).toBe(true);
  });

  it('作文题与句子题的题面字段互不干扰', () => {
    const patch = slotPatch([], [topic('t1')], 'write', 0);
    expect(patch.kind).toBe('write');
    expect(patch.sentenceId).toBe('t1');
    expect(patch.minWords).toBe(80);
    expect(patch.showEn).toBe(false);
    // 作文题不该带句子题的输入残留
    expect(patch.assembled).toBe('');
    expect(patch.typed).toBe('');
  });

  it('越界的下标不写任何字段（不抛错、不写半个题面）', () => {
    expect(slotPatch([], [], 'chunks', 0)).toEqual({});
  });

  it('⭐ 每换一题都清掉上一题的作答痕迹', () => {
    const patch = slotPatch([card('c1', 'Hello', [{ en: 'Hello', zh: '' }])], [], 'chunks', 0);
    for (const key of Object.keys(RESET_ANSWER)) {
      expect(patch).toHaveProperty(key);
      expect(patch[key]).toEqual((RESET_ANSWER as Record<string, unknown>)[key]);
    }
  });
});

describe('队列 → 视图', () => {
  it('⭐ 空队列原样转述后端那句，不统一写成"练完了"', () => {
    const a = queuePatch({ ...queue([]), emptyReason: '这个模块的题库还没建好' });
    expect(a.empty).toBe(true);
    expect(a.patch.emptyText).toBe('这个模块的题库还没建好');

    const b = queuePatch({ ...queue([]), emptyReason: '' });
    expect(b.empty).toBe(true);
    expect(b.patch.emptyText).toBe('今天这个模块没有要练的题，明天再来');
  });

  it('非空队列要把上一批的空态文案清掉（否则换模块后串场）', () => {
    const r = queuePatch(queue([card('c1', 'Hi')]));
    expect(r.empty).toBe(false);
    expect(r.patch.emptyText).toBe('');
    expect(r.patch.total).toBe(1);
    expect(r.patch.mode).toBe('chunks');
  });

  it('作文题也计入总数（否则"1 道作文"会被当成空队列）', () => {
    const r = queuePatch(queue([], [topic('t1')]));
    expect(r.empty).toBe(false);
    expect(r.patch.total).toBe(1);
  });

  it('模式页签标出当前用的那种（切题面按钮靠它高亮）', () => {
    const shell = batchShell({ mode: 'recall', modes: ['chunks', 'recall'] });
    expect(shell.modeTabs).toEqual([
      { mode: 'chunks', title: '连词成句', on: false },
      { mode: 'recall', title: '中译英', on: true },
    ]);
    // 换一批题要把上一批的进度清掉
    expect(shell.passCount).toBe(0);
    expect(shell.finished).toBe(false);
  });
});

describe('作答结果的视图', () => {
  it('逐词对齐 → 对/错两种样式类', () => {
    expect(toWordRows([{ word: 'I', ok: true }, { word: 'likes', ok: false }])).toEqual([
      { word: 'I', cls: 'sess-word-ok' },
      { word: 'likes', cls: 'sess-word-no' },
    ]);
  });

  it('没有作文批改时不留一块空壳', () => {
    const f = buildReviewFields({ review: null } as never);
    expect(f.showReview).toBe(false);
    expect(f.reviewTotal).toBe(0);
    expect(f.sample).toBe('');
    expect(f.dimensions).toEqual([]);
  });

  it('⭐ 三档门槛的文案必须不同（否则用户拿"全对"的标准要求口语）', () => {
    const speak = feedbackText('speak', true, 75, 60);
    const sentence = feedbackText('chunks', true, 100, 100);
    const essay = feedbackText('write', true, 0, 0);
    expect(speak).toContain('75%');
    expect(sentence).not.toBe(speak);
    expect(essay).not.toBe(speak);

    const speakFail = feedbackText('speak', false, 40, 60);
    expect(speakFail).toContain('60%');
    expect(feedbackText('chunks', false, 50, 100)).not.toBe(speakFail);
  });
});

describe('零散纯函数', () => {
  it('词数按空白切分（与后端 countWords 同口径）', () => {
    expect(countWords('hello world')).toBe(2);
    expect(countWords('  a  b\n c ')).toBe(3);
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
  });

  it('作文提纲逐条加序号', () => {
    expect(toOutlineRows([topic('t1')])).toEqual([
      { no: 1, text: '开头点题' },
      { no: 2, text: '正文展开' },
      { no: 3, text: '结尾总结' },
    ]);
    expect(toOutlineRows([])).toEqual([]);
  });

  it('间隙提示：答错一律 1 天，答对按 SM-2 的间隔', () => {
    expect(nextTipOf(1)).toBe('明天还会再见到它');
    expect(nextTipOf(0)).toBe('明天还会再见到它');
    expect(nextTipOf(6)).toContain('6');
  });

  it('模式名有中文；不认识的原样返回而不是显示 undefined', () => {
    expect(modeTitle('chunks')).toBe('连词成句');
    expect(modeTitle('speak')).toBe('跟读');
    expect(modeTitle('weird')).toBe('weird');
  });

  it('点砖块可以反悔：再点一次取下来，拼句结果同步重算', () => {
    const chunks = shuffleChunks(card('c1', null, [
      { en: 'I', zh: '' },
      { en: 'like', zh: '' },
      { en: 'books', zh: '' },
    ]));
    const one = toggleChunk([], chunks, 0);
    expect(one.pickedIdx).toEqual([0]);
    expect(one.assembled).toBe(chunks[0].en);

    const two = toggleChunk(one.pickedIdx, chunks, 1);
    expect(two.pickedIdx).toEqual([0, 1]);
    expect(two.assembled).toBe(`${chunks[0].en} ${chunks[1].en}`);

    // 取消中间那块 → 顺序按"点选的先后"而不是砖块下标
    const undone = toggleChunk(two.pickedIdx, chunks, 0);
    expect(undone.pickedIdx).toEqual([1]);
    expect(undone.assembled).toBe(chunks[1].en);
  });

  it('拼句按点选顺序而不是砖块下标（否则句子语序永远是乱的）', () => {
    const chunks = shuffleChunks(card('c1', null, [
      { en: 'A', zh: '' },
      { en: 'B', zh: '' },
      { en: 'C', zh: '' },
    ]));
    // 取第一块，再取最后一块 —— 拼出来必须是"先点的在前"
    const out = toggleChunk(toggleChunk([], chunks, 0).pickedIdx, chunks, chunks.length - 1);
    expect(out.assembled).toBe(`${chunks[0].en} ${chunks[chunks.length - 1].en}`);
  });
});
