import type { VocabExample, VocabPhrase, VocabSense, VocabWordDetail } from './dto/vocab.dto';
import { primaryMeaning, type OptionSource } from './vocab-options';

/**
 * 词条行的读取列与映射（今日队列 / 判卷 / 统计三处共用）
 *
 * ## 为什么列成清单
 *
 * `WORD_SELECT` 是 Prisma 的 `select`，不是"文档"：少一列就会在**运行时**缺字段
 * （`phonetic` 忘了选 → 卡片音标恒为空串），而 TypeScript 查不出来。
 * 三处查询共用同一份 select + 同一份映射，才不会有"列表有音标、判卷后没有"这类差异。
 *
 * ## `senses` / `examples` 是 Json 列，读出来是 `unknown`
 *
 * 库里存的形状由离线脚本（`scripts/db/gen-words.mjs`）决定，数据库不校验。
 * 所以这里必须**逐项过滤**而不是 `as VocabSense[]` 断言 ——
 * 断言过的脏数据会在小程序里渲染成 "[object Object]" 或空白卡片。
 */

export const WORD_SELECT = {
  id: true,
  spelling: true,
  phonetic: true,
  ukPhonetic: true,
  senses: true,
  examples: true,
  phrases: true,
  mnemonic: true,
  difficulty: true,
  source: true,
} as const;

/** 本模块读到的词条列（与 `WORD_SELECT` 一一对应） */
export interface WordRow {
  id: string;
  spelling: string;
  phonetic: string | null;
  ukPhonetic: string | null;
  senses: unknown;
  examples: unknown;
  phrases: unknown;
  mnemonic: string | null;
  difficulty: number;
  source: string;
}

/** 只保留形状正确的义项（`pos` 可空 —— 展示时退化成"仅释义"） */
export function toSenses(raw: unknown): VocabSense[] {
  if (!Array.isArray(raw)) return [];
  const out: VocabSense[] = [];
  for (const item of raw) {
    const meaning = (item as { meaning?: unknown })?.meaning;
    if (typeof meaning !== 'string' || !meaning.trim()) continue;
    const pos = (item as { pos?: unknown })?.pos;
    out.push({
      pos: typeof pos === 'string' ? pos.trim() : '',
      meaning: meaning.trim(),
    });
  }
  return out;
}

/** 只保留中英双全的例句（缺中文的英文句子对学习者没有价值，直接丢） */
export function toExamples(raw: unknown): VocabExample[] {
  if (!Array.isArray(raw)) return [];
  const out: VocabExample[] = [];
  for (const item of raw) {
    const en = (item as { en?: unknown })?.en;
    const zh = (item as { zh?: unknown })?.zh;
    if (typeof en !== 'string' || !en.trim()) continue;
    if (typeof zh !== 'string' || !zh.trim()) continue;
    out.push({ en: en.trim(), zh: zh.trim() });
  }
  return out;
}

/**
 * 只保留形状正确的词组搭配。
 *
 * ⚠️ 上游 JSONL 里这个词段叫 `phrase` / `zh`（见 `scripts/db/gen-words.mjs` 的
 * `phrases` 映射），但**早期版本的脚本可能写成 `en`**。这里两种键名都收，
 * 是因为"词组整段消失"不会有任何报错 —— 只是例句填空题少了一批素材，
 * 而没人会去比对两万词里有几条词组。
 */
export function toPhrases(raw: unknown): VocabPhrase[] {
  if (!Array.isArray(raw)) return [];
  const out: VocabPhrase[] = [];
  for (const item of raw) {
    const src = item as { phrase?: unknown; en?: unknown; zh?: unknown };
    const phrase = src.phrase ?? src.en;
    const zh = src.zh;
    if (typeof phrase !== 'string' || !phrase.trim()) continue;
    if (typeof zh !== 'string' || !zh.trim()) continue;
    out.push({ phrase: phrase.trim(), zh: zh.trim() });
  }
  return out;
}

/** 行 → 作答后才下发的词条全貌 */
export function toWordDetail(row: WordRow): VocabWordDetail {
  return {
    wordId: row.id,
    spelling: row.spelling,
    phonetic: row.phonetic?.trim() ?? '',
    ukPhonetic: row.ukPhonetic?.trim() ?? '',
    senses: toSenses(row.senses),
    examples: toExamples(row.examples),
    phrases: toPhrases(row.phrases),
    mnemonic: row.mnemonic?.trim() ?? '',
    difficulty: row.difficulty,
    source: row.source,
  };
}

/**
 * 行 → 选项候选。
 *
 * 释义为空时返回 `null`：这类词**不能出题**（四个选项里有一个是空白，
 * 用户只能靠排除法猜）。调用方据此把它从今日队列里剔掉，
 * 而不是让它以"文本为空的选项"混进卡片。
 */
export function toOptionSource(row: WordRow): OptionSource | null {
  const text = primaryMeaning(row.senses);
  return text ? { id: row.id, text } : null;
}