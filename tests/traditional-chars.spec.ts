/**
 * 繁简判定与语料过滤的回归测试
 *
 * ## 这个文件在防什么
 *
 * `traditional-chars.mjs` 的**字表**已经由 `npm run check:trad` 用真实语料自证。
 * 这里测的是**另一层**：`gen-words.mjs` / `gen-sentences.mjs` 用它做
 * **按字段剔除**时，边界行为是否正确 —— 那一层守卫覆盖不到，出错又是静默的。
 *
 * 重点锁三条：
 *
 *   ① 生僻简体字**不是**繁体（第二版就是栽在这：`铂 → 铂` 写法相同，收进表就全盘误报）；
 *   ② 繁体**专有字**必须认出（第一版漏了 `飯`/`廳`/`錢`，界面照样露繁体）；
 *   ③ 混排时不误伤句子里其它正常字符（判据按码位遍历，别把标点/英文卷进来）。
 */
import { describe, expect, it } from 'vitest';

import {
  hasTraditional,
  findTraditional,
  TRADITIONAL_CHARS,
} from '../scripts/db/traditional-chars.mjs';

describe('繁简判定 hasTraditional', () => {
  it('认出繁体专有字（第一版漏掉的那批）', () => {
    // 第一版 124 字表漏掉 1180 条，这几个是当时最典型的漏网字
    for (const s of ['一碗飯大約重一百八十克', '客廳裡很安靜', '這是我的錢', '她很美麗']) {
      expect(hasTraditional(s), `应判为繁体：${s}`).toBe(true);
    }
  });

  it('不把生僻简体字当繁体（第二版栽的坑）', () => {
    // 这些字在简体正文里很少出现，但**与繁体写法相同**，收入表就是全盘误报
    for (const s of ['铂', '鲱', '蟑', '琵', '琶', '柚', '茱', '藜', '掰', 'platinum = 铂；白金']) {
      expect(hasTraditional(s), `不该判为繁体：${s}`).toBe(false);
    }
  });

  it('不误伤纯简体句', () => {
    for (const s of ['目前,他正在度假。', '她心地善良，很会体谅人。', '这幅画值10镑。']) {
      expect(hasTraditional(s), `不该判为繁体：${s}`).toBe(false);
    }
  });

  it('混排句子只报繁体字，不牵连英文与标点', () => {
    const hit = findTraditional('She tied up the parcel，她用繩子綁好了。');
    expect(hit.sort()).toEqual(['綁', '繩'].sort());
  });

  it('非字符串与空串一律判为"不是繁体"（不抛错）', () => {
    for (const v of [null, undefined, '', 123, {}, []]) {
      expect(hasTraditional(v as never)).toBe(false);
      expect(findTraditional(v as never)).toEqual([]);
    }
  });
});

describe('字表本身的结构约束', () => {
  it('无重复字', () => {
    const chars = [...TRADITIONAL_CHARS];
    expect(new Set(chars).size).toBe(chars.length);
  });

  it('规模在合理区间（缩水说明被误删，膨胀说明判据被放宽）', () => {
    // 724 是"语料实测候选 − 简繁同形字表"的结果。区间给得宽，只挡数量级错误。
    expect(TRADITIONAL_CHARS.length).toBeGreaterThan(600);
    expect(TRADITIONAL_CHARS.length).toBeLessThan(1200);
  });

  it('全部落在中文码位区间内（没有把英文/数字/标点收进来）', () => {
    for (const ch of TRADITIONAL_CHARS) {
      expect(/[\u4e00-\u9fff]/.test(ch), `非汉字混入字表：${ch}`).toBe(true);
    }
  });
});
