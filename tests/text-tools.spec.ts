/**
 * 字数统计与文本整理单测
 *
 * 为什么这些用例值得写：字数是"算错了也看不出来"的典型 ——
 * 学生按界面那个数字交作业，差一百字不会当场暴露。所以重点钉三件事：
 *   ① **口径**（汉字 / 英文单词 / 字符 / 行 / 段分别算什么，`wordCount` 只认汉字 + 单词）；
 *   ② **换行**（CRLF 是用户粘进来最常见的脏输入，按行处理后不许残留 `\r`）；
 *   ③ **不丢数据**（整理只能变形或去重，绝不能把没重复的行吃掉）。
 *
 * 期望值全部用独立的 Node 计算核对过，不是"实现算出什么就断言什么"。
 */
import { describe, expect, it } from 'vitest';

import {
  applyTextOp,
  countText,
  TEXT_OPS,
  type TextOp,
  wordCount,
  wordLimitHint,
} from '../apps/mp/utils/text-tools';

/** 中英混排 + 空行 + 末尾无换行 */
const MIXED = '我爱 Camper 真好\n第二 line\n\n再来';

const ZERO = { han: 0, enWords: 0, chars: 0, charsWithSpace: 0, lines: 0, paragraphs: 0 };

describe('countText', () => {
  it('⭐ 中英混排：六个口径各自算对', () => {
    // 手工核对：汉字 我爱/真好/第二/再来 = 8；英文词 Camper/line = 2
    // 非空白字符 = 8 + 6(Camper) + 4(line) = 18
    // 全部字符 = 12 + 1 + 7 + 1 + 0 + 1 + 2 = 24（两个换行也各算一个字符）
    // 行 4（中间那个空行算一行）；段 3（空行不算段落）
    expect(countText(MIXED)).toEqual({
      han: 8,
      enWords: 2,
      chars: 18,
      charsWithSpace: 24,
      lines: 4,
      paragraphs: 3,
    });
  });

  it('空串与纯空白全部返回 0（连行数也是 0，不是 1）', () => {
    for (const blank of ['', '   ', '\n\n', '\r\n \t　', '\n \n \n']) {
      expect(countText(blank), JSON.stringify(blank)).toEqual(ZERO);
    }
  });

  it('末尾换行不多算一行；CRLF 与 LF 的行数一致', () => {
    expect(countText('一行\n').lines).toBe(1);
    expect(countText('一行\n\n').lines).toBe(2);
    expect(countText('一行\n二行').lines).toBe(2);
    expect(countText('一行\r\n二行\r\n').lines).toBe(2);
  });

  it('emoji 按 UTF-16 码元计入 charsWithSpace（与微信输入框同口径），按一个字符计入 chars', () => {
    expect(countText('😀').charsWithSpace).toBe(2);
    expect(countText('😀')).toMatchObject({ han: 0, chars: 1 });
  });

  it('生僻字（CJK 扩展 B，需代理对）算一个汉字，而不是两个字符', () => {
    expect(countText('\u{20000}')).toMatchObject({ han: 1, chars: 1, charsWithSpace: 2 });
  });

  it('日文假名与韩文谚文不计入汉字，但计入字符数', () => {
    expect(countText('あい カナ 한글')).toMatchObject({ han: 0, enWords: 0, chars: 6 });
  });
});

describe('wordCount / wordLimitHint', () => {
  it('⭐「字数」= 汉字数 + 英文单词数，与字符数无关', () => {
    expect(wordCount(countText(MIXED))).toBe(10); // 8 汉字 + 2 单词，既不是 18 也不是 24
    // 撇号会把 don't 切成两个词（连同 I 和 know 共 4 个）—— 与 Word 一致，钉住别"顺手优化"
    expect(wordCount(countText("I don't know"))).toBe(4);
  });

  it('超过要求：报超了多少字', () => {
    expect(wordLimitHint(countText('字'.repeat(926)), 800)).toBe('已超 800 字要求，还需删 126 字');
  });

  it('没达到要求：报还差多少字；正好达标单独说一句', () => {
    expect(wordLimitHint(countText('字'.repeat(674)), 800)).toBe('距 800 字还差 126 字');
    expect(wordLimitHint(countText('字'.repeat(800)), 800)).toBe('正好 800 字，达标');
    // 混排也按同一口径：500 汉字 + 26 个英文词 = 526 字
    expect(wordLimitHint(countText(`文${'字'.repeat(499)} ${'w '.repeat(25)}last`), 800)).toBe(
      '距 800 字还差 274 字',
    );
  });

  it('limit 非法（0 / 负数 / 小数 / NaN / Infinity）返回空串，页面据此不显示这一行', () => {
    const c = countText(MIXED);
    for (const bad of [0, -5, 800.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(wordLimitHint(c, bad), String(bad)).toBe('');
    }
  });
});

describe('applyTextOp · 换行与空白', () => {
  const CRLF = '第一行\r\n\r\n第二行  \r\n第一行';

  it('⭐ CRLF 输入按行处理后不残留 \\r，并且归一成 LF', () => {
    for (const op of ['stripBlank', 'trimLines', 'dedupe', 'sortAsc', 'reverse'] as TextOp[]) {
      const out = applyTextOp(CRLF, op);
      expect(out, op).not.toContain('\r');
    }
    expect(applyTextOp(CRLF, 'trimLines')).toBe('第一行\n\n第二行\n第一行');
    expect(applyTextOp(CRLF, 'stripBlank')).toBe('第一行\n第二行  \n第一行');
  });

  it('stripBlank 只删空行、不动行内空格；trimLines 只削首尾', () => {
    const s = 'a\n \n  b  \n\n\nc';
    expect(applyTextOp(s, 'stripBlank')).toBe('a\n  b  \nc');
    expect(applyTextOp(s, 'trimLines')).toBe('a\n\nb\n\n\nc');
    // trimLines 只削内容、不改行数（六行仍是六行）
    expect(applyTextOp(s, 'trimLines').split('\n')).toHaveLength(6);
  });

  it('⭐ dedupe 保留首次出现的顺序，且 CRLF / LF 的同句不会被当成两行', () => {
    expect(applyTextOp('香蕉\n苹果\n香蕉\n梨\n苹果', 'dedupe')).toBe('香蕉\n苹果\n梨');
    // 行尾 \r 若被留下，'第一行\r' 与 '第一行' 会被判成两行 —— 这正是 CRLF 的坑
    expect(applyTextOp('第一行\r\n第二行\r\n第一行', 'dedupe')).toBe('第一行\n第二行');
    // 比较用整行原文：行尾多一个空格算两行（要按去空格后比较，先跑一次 trimLines）
    expect(applyTextOp('a\na \nA', 'dedupe')).toBe('a\na \nA');
  });

  it('reverse 是行序反转（不是字符反转），且不吞行', () => {
    expect(applyTextOp('1\n2\n3', 'reverse')).toBe('3\n2\n1');
    const s = 'x\n\ny\nz';
    expect(applyTextOp(s, 'reverse')).toBe('z\ny\n\nx');
    expect(countText(applyTextOp(s, 'reverse')).lines).toBe(countText(s).lines);
  });
});

describe('applyTextOp · 大小写、全角与排序', () => {
  it('upper / lower 只改字母，中文与数字不动', () => {
    expect(applyTextOp('第 1 段 hello World 2025', 'upper')).toBe('第 1 段 HELLO WORLD 2025');
    expect(applyTextOp('HELLO 世界', 'lower')).toBe('hello 世界');
  });

  it('⭐ halfWidth 转全角字母数字与全角空格，但不破坏中文标点', () => {
    expect(applyTextOp('ＡＢ０１９ ａｚ　尾　２０２５', 'halfWidth')).toBe('AB019 az 尾 2025');
    // 顿号 、(U+3001)、中文引号 “ ”(U+201C/201D)、书名号《》、句号 。(U+3002)
    // 都不在 U+FF01–FF5E 的"ASCII 镜像区"里，所以天然被跳过
    const kept = '“引用”、《书名》、。';
    expect(applyTextOp(kept, 'halfWidth')).toBe(kept);
    // 代价要讲清楚：！与？确实是全角镜像，会被转成半角
    expect(applyTextOp('好？！', 'halfWidth')).toBe('好?!');
  });

  it('sortAsc 可用且不增删行（ICU 各端排序可能不同，只断数据完整性）', () => {
    expect(applyTextOp('banana\napple\ncherry', 'sortAsc')).toBe('apple\nbanana\ncherry');
    const out = applyTextOp('张三\n李四\n王五\n赵六', 'sortAsc');
    expect(out).not.toContain('\r');
    expect([...out.split('\n')].sort()).toEqual(['张三', '李四', '王五', '赵六'].sort());
  });
});

describe('applyTextOp · 边界与清单', () => {
  it('空串与纯空白原样返回，不抛错也不清空', () => {
    for (const op of TEXT_OPS) {
      expect(() => applyTextOp('', op.key)).not.toThrow();
      expect(applyTextOp('', op.key)).toBe('');
      expect(applyTextOp('  \r\n ', op.key)).toBe('  \r\n ');
    }
  });

  it('未知 op 原样返回（清单与界面不同步时，最坏的只是"什么都没变"）', () => {
    const s = '别把我清空';
    expect(applyTextOp(s, 'notAnOp' as unknown as TextOp)).toBe(s);
  });

  it('⭐ 清单恰好 8 个、key 不重名、label 都有文案', () => {
    expect(TEXT_OPS).toHaveLength(8);
    expect(new Set(TEXT_OPS.map((op) => op.key)).size).toBe(8);
    expect(TEXT_OPS.map((op) => op.key)).toEqual([
      'upper',
      'lower',
      'dedupe',
      'sortAsc',
      'reverse',
      'stripBlank',
      'trimLines',
      'halfWidth',
    ]);
    for (const op of TEXT_OPS) expect(op.label.length, op.key).toBeGreaterThan(0);
  });

  it('每个 op 都跑通不抛错（清单加了 key 却忘实现，由 `Record<TextOp, …>` 在编译期拦）', () => {
    const s = 'Ａ Ｂ\n\nb\na\n';
    for (const op of TEXT_OPS) {
      expect(() => applyTextOp(s, op.key)).not.toThrow();
      expect(typeof applyTextOp(s, op.key), op.key).toBe('string');
    }
  });
});
