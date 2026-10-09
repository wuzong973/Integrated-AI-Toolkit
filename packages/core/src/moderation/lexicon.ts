/**
 * 校园场景补充词库（M4-05）。
 *
 * ## 定位：**补充**，不是主判据
 *
 * 主判据永远是微信内容安全 API —— 它能识别变体、谐音、图片，而这些词库做不到。
 * 之所以还要维护一份，是因为官方词库面向全网，对**校园特有的灰色交易**覆盖不足：
 * 「代考」「论文代写」「刷单」这类在校园驿站里出现的频率远高于社会场景。
 *
 * ## 边界
 *
 * - 这里**不放涉政内容**。那类判定必须交给官方接口，自建词表既不可能覆盖全，
 *   判错的政治与法律成本也远高于漏判一条广告；
 * - 词表只做**字面包含**匹配，不做任何"聪明"的语义推断 ——
 *   误报会直接把正常用户的发布拦下来，代价很高。宁可交给官方接口兜底。
 *
 * ## 维护纪律
 *
 * 新增词条必须同时补一条**为什么它在校园场景里是问题**的说明。
 * 没有理由的词条会变成"谁也不敢删的历史包袱"，最终让整个词库失去可信度。
 */

/** 词条 + 它对应的标签与存在理由 */
export interface LexiconEntry {
  /** 命中的字面串 */
  word: string;
  /** 归入的标签，与微信返回的标签体系保持同构，便于前端统一展示 */
  label: string;
  /** 为什么收录。新增词条必须写清，否则下次没人敢删 */
  why: string;
}

export const CAMPUS_LEXICON: readonly LexiconEntry[] = [
  { word: '代考', label: 'cheat', why: '替考属学术不端，校规与法律都禁止' },
  { word: '替考', label: 'cheat', why: '同上，变体写法' },
  { word: '代写论文', label: 'cheat', why: '论文代写是校园里最常见的付费违规交易' },
  { word: '论文代写', label: 'cheat', why: '同上，语序变体' },
  { word: '包过', label: 'cheat', why: '考试/证书「包过」是典型骗局话术，且多伴随代考' },
  { word: '刷单', label: 'fraud', why: '刷单本身违法，且是校园兼职诈骗的主要入口' },
  { word: '刷好评', label: 'fraud', why: '虚假评价，破坏驿站评价体系的可信度' },
  { word: '校园贷', label: 'loan', why: '校园贷已被明令整治，平台不得成为其引流渠道' },
  { word: '裸条', label: 'loan', why: '与校园贷伴生的违法行为' },
  { word: '套现', label: 'fraud', why: '信用卡/花呗套现在校园里常被包装成「兼职」' },
  { word: '跑分', label: 'fraud', why: '「跑分」是洗钱黑话，属于刑事犯罪' },
  { word: '枪支', label: 'weapon', why: '违禁品交易' },
  { word: '毒品', label: 'drug', why: '违禁品交易' },
  { word: '迷药', label: 'drug', why: '违禁品，且直接关系人身安全' },
  { word: '博彩', label: 'gamble', why: '网络赌博是校园诈骗的主要形式之一' },
  { word: '私彩', label: 'gamble', why: '非法彩票' },
];

/**
 * 扫描文本命中的词条。
 *
 * 返回 `label → 命中词` 的映射：前端只需要展示类别，
 * 而排障时要能看到具体命中了哪个词（否则用户投诉"我什么都没写就被拦了"时无从解释）。
 */
export function scanLexicon(text: string, extra: readonly string[] = []): Map<string, string[]> {
  const hits = new Map<string, string[]>();

  const record = (label: string, word: string): void => {
    const list = hits.get(label) ?? [];
    if (!list.includes(word)) list.push(word);
    hits.set(label, list);
  };

  for (const entry of CAMPUS_LEXICON) {
    if (text.includes(entry.word)) record(entry.label, entry.word);
  }
  // 运维通过 MODERATION_EXTRA_WORDS 临时补充的词条统一归入 custom，
  // 与内置词分开标记，便于日后判断"这条是不是我临时加的"
  for (const word of extra) {
    if (word && text.includes(word)) record('custom', word);
  }

  return hits;
}

/** 把命中结果拼成一句能进日志、也能给用户看的原因 */
export function describeHits(hits: Map<string, string[]>): string {
  return [...hits.entries()]
    .map(([label, words]) => `${label}(${words.join('/')})`)
    .join('，');
}
