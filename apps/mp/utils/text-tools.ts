/**
 * 字数统计与文本整理（纯函数，不依赖 wx API，零第三方依赖）
 *
 * ## 为什么放在小程序侧，而不是 `packages/core`
 *
 * ⚠️ **小程序不能 `import @qz/core`** —— 微信开发者工具解析不到，需要"构建 npm"配合，
 * 而本项目 `project.config.json` 的 `packNpmRelationList` 是空的（`utils/gpa.ts` 记的是同一条约束）。
 * 所以算法自包含在本文件里，页面只负责收集输入与展示，全部逻辑可以在 Node 里单测
 * （测试在 `tests/text-tools.spec.ts`，不能放进 `apps/mp`，理由见 `vitest.config.ts`）。
 *
 * ## ⚠️「字数」在本仓库有**两套口径**，数字本来就允许不一致（别去"修平"）
 *
 * · 后端 `packages/core/src/quality/score.ts` 的 `countContentChars` 是
 *   **"去掉 Markdown 语法之后的正文字符数"**，服务于 AI 产物质检（防止用 `#`、`-` 凑字数）；
 * · 本文件的 `countText` 是 **"Word 式字数统计"**（中文字与英文单词分开数，见下）。
 *
 * 同一段文字两边算出来的数字**就是可以不一样**，这不是 bug。以后有人拿两边的数对不上来提 issue，
 * 先回来看这段注释 —— 把它们并成一个函数会让 AI 质检的"去语法字数"变成错的。
 *
 * ## ⚠️ 换行一律按 `\r?\n` 切分（实证坑）
 *
 * 用户从微信聊天、Word、网页粘进来的文本常常带 CRLF。只按 `\n` 切会把行尾的 `\r`
 * 留在结果里 —— 界面上看不见，粘回编辑器就是一排脏字符，`dedupe` 还会把
 * "同一句话的 CRLF 版和 LF 版"当成两行。所以按行处理的地方全部写 `\r?\n`，
 * 并以 `\n` 重新拼回去（顺带把整段归一成 LF）。
 * 注意：源码文件本身仍是 LF（`.editorconfig`），这里处理的是**用户数据**。
 */

/** 六项统计结果（界面按这个顺序排两列网格） */
export interface TextCounts {
  /** 汉字数（CJK 表意文字；日文假名与韩文谚文**不**算进来，见 `isHanCodePoint` 注释） */
  han: number;
  /** 英文单词数：连续的 ASCII 字母串算一个 */
  enWords: number;
  /** 非空白字符数 */
  chars: number;
  /** 全部字符数（含空格与换行） */
  charsWithSpace: number;
  /** 行数 */
  lines: number;
  /** 段落数 = 非空行数 */
  paragraphs: number;
}

/** 全零结果：空串与纯空白输入用它，界面显示"0"而不是"–" */
const EMPTY_COUNTS: TextCounts = {
  han: 0,
  enWords: 0,
  chars: 0,
  charsWithSpace: 0,
  lines: 0,
  paragraphs: 0,
};

/**
 * 汉字判定（按码点，所以扩展 B 以外的生僻字也算得到）。
 *
 * 只认 CJK 表意文字四段：统一表意文字、扩展 A、兼容表意文字、扩展 B–F 与兼容补充。
 * **刻意不含**日文假名（U+3040–U+30FF）与韩文谚文（U+AC00–U+D7AF）：
 * 字段名就叫 `han`，混进假名会让"汉字数"这个数字失去意义；
 * 假名/谚文会体现在 `chars` 与 `charsWithSpace` 里，不会凭空消失。
 */
function isHanCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x2fa1f)
  );
}

/** 连续的 ASCII 字母串。`don't` 会被数成 2 个词、`hello-world` 也是 2 个 —— 与 Word 一致 */
const EN_WORD_RE = /[A-Za-z]+/g;

/**
 * 统计一段文本。
 *
 * 空串与"全是空白"的输入一律返回全零（包括 `lines` 记 0 而不是 1）：
 * 用户按了回车但什么都没写，界面说"1 行"反而像在骗人。
 *
 * ⚠️ `charsWithSpace` 用 `s.length`，即 **UTF-16 码元数**：一枚 emoji 算 2。
 * 这与微信输入框自己的字数统计口径一致（它也是这么算的），不要改成码点数，
 * 否则会和输入框右下角那个数字对不上。
 */
export function countText(s: string): TextCounts {
  if (s.trim() === '') {
    return { ...EMPTY_COUNTS };
  }

  let han = 0;
  let chars = 0;
  // 按码点遍历：代理对（emoji、扩展 B 生僻字）不会被拆成两个字符来判
  for (const ch of s) {
    if (/\s/.test(ch)) continue;
    chars += 1;
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isHanCodePoint(cp)) han += 1;
  }

  const segments = s.split(/\r?\n/);
  // 末尾那个换行不该多出一行：`"写完了\n"` 是 1 行，不是 2 行
  const trailingEmpty = segments[segments.length - 1] === '' ? 1 : 0;

  return {
    han,
    enWords: (s.match(EN_WORD_RE) ?? []).length,
    chars,
    charsWithSpace: s.length,
    lines: segments.length - trailingEmpty,
    paragraphs: segments.filter((line) => line.trim() !== '').length,
  };
}

/** 操作清单：页面直接 `wx:for` 它，顺序就是界面上的顺序 */
export const TEXT_OPS = [
  { key: 'upper', label: '英文大写' },
  { key: 'lower', label: '英文小写' },
  { key: 'dedupe', label: '去重行' },
  { key: 'sortAsc', label: '按拼音升序' },
  { key: 'reverse', label: '行序反转' },
  { key: 'stripBlank', label: '删空行' },
  { key: 'trimLines', label: '去行首尾空格' },
  { key: 'halfWidth', label: '全角转半角' },
] as const;

export type TextOp = (typeof TEXT_OPS)[number]['key'];

/** 按行处理：切 → 变换 → 用 LF 拼回（顺带把 CRLF 归一成 LF） */
const mapLines = (s: string, fn: (line: string, index: number) => string): string =>
  s.split(/\r?\n/).map(fn).join('\n');

/** 去重行：**保留首次出现的顺序**，比较用整行原文 */
function dedupeLines(s: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of s.split(/\r?\n/)) {
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out.join('\n');
}

/**
 * 按拼音升序。
 *
 * ⚠️ **不保证各端结果一致**：`localeCompare(…, 'zh-Hans-CN')` 依赖运行环境的
 * ICU 排序表 —— 开发者工具（V8 + 桌面 ICU）与真机（iOS / Android 各自一套）
 * 对多音字、生僻字的排序**可能不同**。这里如实使用它而不是自己写一张拼音表：
 * 排序只是"整理清单"的便利功能，不是需要跨端复现的计算结果。
 * 需要严格可复现的顺序时，请换用带拼音注音的数据源（词书 JSONL 里有）。
 */
function sortLinesAsc(s: string): string {
  return s
    .split(/\r?\n/)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    .join('\n');
}

/**
 * 全角转半角。
 *
 * 只处理 Unicode「全角形式」区块 U+FF01–FF5E（它是 ASCII 0x21–0x7E 的等距镜像，
 * 减 0xFEE0 就回到半角）与全角空格 U+3000。
 *
 * ⚠️ **为什么顿号、引号不用写代码也不会被破坏**：中文专用的标点根本不在
 * U+FF01–FF5E 里 —— 顿号 `、`（U+3001）、句号 `。`（U+3002）、书名号《》、
 * 直角引号「」都落在 U+3000–U+303F，中文弯引号 `“ ”` 落在 U+201C/201D。
 * 它们在半角区**没有一一对应的字形**，压平了就把中文排版写坏且不可逆，
 * 所以判据取"只碰 ASCII 镜像区"，而不是"列一张要跳过的标点表"（后者一定会漏）。
 *
 * 代价要讲清楚：区间内那批"既是全角又是中文常用标点"的字符
 * （`！`U+FF01、`？`U+FF1F、`，`U+FF0C、`：`U+FF1A、`；`U+FF1B、`（）`U+FF08/09）
 * **会被转成半角**。要保留中文排版就别点这个操作，界面上也不替用户做取舍。
 */
function toHalfWidth(s: string): string {
  return s
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/** op → 实现。查表而不是 switch：分支一多 `complexity` 就顶到上限，且读起来更差 */
const OP_FNS: Record<TextOp, (s: string) => string> = {
  upper: (s) => s.toUpperCase(),
  lower: (s) => s.toLowerCase(),
  dedupe: dedupeLines,
  sortAsc: sortLinesAsc,
  reverse: (s) => s.split(/\r?\n/).reverse().join('\n'),
  stripBlank: (s) =>
    s
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .join('\n'),
  trimLines: (s) => mapLines(s, (line) => line.trim()),
  halfWidth: toHalfWidth,
};

/**
 * 对文本施加一个操作。
 *
 * 空串与纯空白**原样返回**（不抛错、也不返回空）；未知 op 同样原样返回 ——
 * op 是从 WXML 的 `data-op` 传进来的字符串，界面与这份清单万一不同步，
 * 后果应该是"什么都没变"，不是一片空白或一个异常。
 *
 * 注意 `upper` / `lower` / `halfWidth` 是**整段字符级**操作，不动行结构；
 * 其余五个按行处理，会把 CRLF 归一成 LF。所以纯大小写转换之后原文里
 * 的 `\r` 仍在（原文没被改写，符合预期），要顺手清掉就先跑一次「去行首尾空格」。
 */
export function applyTextOp(s: string, op: TextOp): string {
  if (s.trim() === '') return s;
  const fn = OP_FNS[op];
  return fn ? fn(s) : s;
}

/**
 * 「字数」口径 —— 本页所有字数判断只认这一个式子：**汉字数 + 英文单词数**。
 *
 * 这就是 Word 状态栏左下角那个数（也最接近老师说的"作文字数"）：
 * 中文按字算、英文按词算，标点与空白不计入。界面提示、超限判断都走它，
 * 别在页面里另写 `han + enWords`，否则两边迟早会分叉。
 */
export function wordCount(counts: TextCounts): number {
  return counts.han + counts.enWords;
}

/**
 * 一句话的字数要求提示（本页的核心价值：交作业常有下限 / 上限）。
 *
 * 三种输出：超了说超了多少、还差多少字；没超说还差多少字；正好达标说一句就到；
 * `limit` 非法（非有限数、<= 0、非整数）返回空串，页面据此**不显示这一行**，
 * 而不是显示"参数错误"。
 */
export function wordLimitHint(counts: TextCounts, limit: number): string {
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isInteger(limit)) return '';
  const n = wordCount(counts);
  if (n > limit) return `已超 ${limit} 字要求，还需删 ${n - limit} 字`;
  if (n === limit) return `正好 ${limit} 字，达标`;
  return `距 ${limit} 字还差 ${limit - n} 字`;
}
