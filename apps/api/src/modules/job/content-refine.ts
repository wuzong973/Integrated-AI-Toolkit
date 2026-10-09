/**
 * 质检 + 自修复（Q6 self-refine）
 *
 * ## 它解决什么
 *
 * 质检原本只做一件事：算分、打日志。不达标的产物**照样交付给用户** ——
 * 日志里写了"篇幅不足 1800/3000"，但用户拿到的仍是一份偏短的文档，
 * 而他并不知道，也没有别的选择。
 *
 * 现在补上闭环：**不达标时把具体的扣分项回灌给模型，让它针对性重写一次**，
 * 然后取两次里分高的那个。日志里那句"缺少市场规模章节"因此开始有用。
 *
 * ## 三条纪律
 *
 * 1. **最多重写一次**：成本可控（最多 2 倍 token），也防止"越改越差"的循环。
 *    `MAX_ATTEMPTS = 2` 是硬上限，不是建议值。
 * 2. **取分高者，不是取后者**：重写未必更好。若第二版更差就保留第一版 ——
 *    否则"自修复"会变成"自降级"。
 * 3. **重写仍不达标也照常交付**：内容略短但仍可用时，交付 + 如实标注
 *    比直接失败更有价值（与 `data-tool-runner.ts` 的降级口径一致）。
 *
 * ## 为什么单独成文件
 *
 * `llm-tool-runner.ts` 已贴 300 行红线，而这段逻辑（评分 → 构造反馈 → 重写 → 择优）
 * 是**独立的一件事**：它只回答"这次产出够不够好，不够好怎么补救"，
 * 与"调哪个模型、存哪个文件"无关。
 */
import { analyzeContent, type ContentQualityReport } from '@qz/core';

/** 最大尝试次数（含首次生成）：2 = 首次 + 最多一次重写 */
export const MAX_ATTEMPTS = 2;

/** 一次尝试的结果 */
export interface AttemptResult {
  content: string;
  report: ContentQualityReport;
}

/**
 * 生成结果：内容 + 是否被截断。
 *
 * ## 为什么截断要单独传进来（Q8）
 *
 * `finish_reason: length` 表示模型把 max_tokens 用完了、内容**没写完**。
 * Provider 层已经会因此抛错，但对"长文档生成"这类**本来就容易触顶**的场景，
 * 直接失败会让用户什么都拿不到 —— 更合理的做法是**接着写**。
 *
 * 实测口径：商业计划书要求 3000 字，约需 4500~6000 token，
 * 而 `maxTokens` 正好配的是 6000 —— 触顶是真实会发生的事，不是理论风险。
 */
export interface GenerateResult {
  content: string;
  /** 是否因 max_tokens 用尽而被截断 */
  truncated?: boolean;
}

export interface RefineOutcome {
  /** 最终采用的内容 */
  content: string;
  /** 最终采用内容的质检报告 */
  report: ContentQualityReport;
  /** 实际尝试次数（1 = 无需重写；2 = 重写过） */
  attempts: number;
  /** 是否发生了重写 */
  refined: boolean;
  /** 重写是否比原稿更好（用于观测"自修复到底有没有用"） */
  improved: boolean;
}

/**
 * 判断这次产出是否值得重写。
 *
 * 只有"内容类"质检通过 `qualityDocType` 的产物才走这条路 ——
 * 翻译这类要求"忠实原文"的产物没有字数下限，拿去重写只会引入改写风险。
 */
export function shouldRefine(report: ContentQualityReport): boolean {
  return !report.passed && report.issues.length > 0;
}

/**
 * 把扣分项拼成给模型的**具体**修改指令。
 *
 * ## 为什么必须带原文长度与具体缺失项
 *
 * 只说"内容不够好"没用 —— 模型会重写一版同样长度的东西。
 * 把"1800/3000 字""缺少市场规模章节"这类**可核对的数字**喂回去，
 * 它才知道该补什么。这些数字全部来自评分器，不是这里另算的。
 */
export function buildRefinePrompt(
  original: string,
  report: ContentQualityReport,
  truncated = false,
): string {
  // 截断场景的指令与"内容不达标"完全不同：这时**缺的是后半篇**，
  // 让模型"针对性修改"没有意义（它会重写一遍再撞上限）。
  // 正确做法是明确要求它**接着写**，并且只输出续写部分（避免重复前半篇）。
  if (truncated) {
    return [
      '你上一次的输出**写到一半就中断了**（达到输出长度上限）。',
      '请**只输出接下来的内容**，不要重复已经写过的部分、不要重新开头、不要解释。',
      '从下面这段的末尾直接往下写，保持相同的章节风格与 Markdown 结构，直到内容完整结束。',
      '',
      '【已写到这里（末尾片段）】',
      original.slice(-600),
    ].join('\n');
  }
  const lines = [
    '你上一次的输出没有达到质量要求，请**针对性修改**，不要从头重写、不要改变原有结论。',
    '',
    '【上次输出的问题】',
    ...report.issues.map((i) => `- ${i}`),
    '',
    `【硬性要求】正文不少于 ${report.minChars} 字（当前 ${report.chars} 字）。`,
    '补充内容必须是与主题相关的**实质信息**，不要用重复的句子或套话凑字数 —— ',
    '质检会检测表达重复度，复读凑数会被判为不合格。',
    '保持 Markdown 章节结构，直接输出修改后的完整文档，不要解释你改了什么。',
    '',
    '【上一次的输出】',
    original,
  ];
  return lines.join('\n');
}

/**
 * 跑"生成 → 质检 →（不达标则）重写 → 取分高者"的完整闭环。
 *
 * `generate` 由调用方注入：本文件不关心用哪个模型、哪个档位，
 * 只负责编排"重试与择优"这件事 —— 这样它才能被单测直接打靶。
 */
export async function generateWithRefine(opts: {
  /** 首次生成。返回字符串或 `{ content, truncated }`（后者用于截断感知续写） */
  generate: () => Promise<string | GenerateResult>;
  /** 带反馈重写 */
  refine: (feedback: string) => Promise<string>;
  /** 质检维度；为空表示不质检、不重写 */
  qualityDocType?: string;
  maxAttempts?: number;
}): Promise<RefineOutcome> {
  const firstRaw = await opts.generate();
  const first = typeof firstRaw === 'string' ? firstRaw : firstRaw.content;

  // 未声明质检维度：直接返回，不做任何判断（这条工具本就没有质量判据）
  if (!opts.qualityDocType) {
    return {
      content: first,
      report: analyzeContent(first),
      attempts: 1,
      refined: false,
      improved: false,
    };
  }

  const firstReport = analyzeContent(first, opts.qualityDocType);
  const limit = Math.max(1, opts.maxAttempts ?? MAX_ATTEMPTS);
  // 被截断的内容**结构必然不完整**，分数可能不低但绝不能算达标 ——
  // 与"篇幅不足判不通过"同一条纪律：硬性缺陷不能被加权总分抹平。
  const truncated = typeof firstRaw === 'string' ? false : firstRaw.truncated === true;

  // 达标、或没有可执行的修改建议 → 不重写
  if (limit <= 1 || (!truncated && !shouldRefine(firstReport))) {
    return {
      content: first,
      report: firstReport,
      attempts: 1,
      refined: false,
      improved: false,
    };
  }

  const secondRaw = await opts.refine(buildRefinePrompt(first, firstReport, truncated));
  // 截断场景下模型只给了续写部分，需要拼回前半篇才是一份完整文档
  const second = truncated ? first + '\n' + secondRaw : secondRaw;
  const secondReport = analyzeContent(second, opts.qualityDocType);

  // 取分高者：重写未必更好，第二版更差就保留第一版，避免"自修复变成自降级"
  const improved = secondReport.score > firstReport.score;
  return improved
    ? { content: second, report: secondReport, attempts: 2, refined: true, improved: true }
    : { content: first, report: firstReport, attempts: 2, refined: true, improved: false };
}