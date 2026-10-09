import { Inject, Injectable } from '@nestjs/common';
import {
  WRITE_DIMENSIONS,
  sampling,
  weightedWriteScore,
  type Providers,
  type WriteDimensionKey,
} from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import { PROVIDERS } from '../../infra/providers/providers.module';

import type { WriteDimensionResult } from './dto/practice.dto';

/**
 * 作文批改（LLM 单次调用，结构化输出）
 *
 * ## 为什么是**一次调用**而不是"四个维度各调一次"
 *
 * 四次调用的成本是四倍，而四次之间的判断会互相矛盾（"结构 90 分、内容 40 分"
 * 这种组合其实说不通 —— 结构是由内容撑起来的）。一次调用让模型在同一个语境里
 * 权衡，产出的分数自洽。
 *
 * ## 为什么**不让 LLM 给总分**
 *
 * 总分由 `weightedWriteScore` 按 `WRITE_DIMENSIONS` 的权重算（core 里的常量，
 * 权重合计 100 有单测钉住）。让模型直接给总分的话，会出现
 * "内容 40 / 结构 90 / 语言 90 / 词汇 90 → 总分 85"这种算不通的结果，
 * 而用户看到的正是总分。
 *
 * ## ⚠️ LLM 失败时**降级返回，不阻断提交**
 *
 * 用户写了 200 词，不能因为批改服务抖一下就让他白写。所以：
 *   · 批改抛错 → 返回 `total: 0` + 一条"批改暂时不可用"的说明；
 *   · 提交本身**照常落库**（`submitted` 存全文），分数记为 0。
 * 事后可以重批（`attempt` 里留着原文），而用户的内容不会丢。
 *
 * ⚠️ 但**必须留日志**：批改一直失败会让"作文分数全是 0"看起来像
 * "这一届学生写得都差"，那是完全错误的方向。
 */
@Injectable()
export class EssayGraderService {
  constructor(
    private readonly logger: AppLogger,
    @Inject(PROVIDERS) private readonly providers: Providers,
  ) {}

  async grade(input: {
    title: string;
    outline: string[];
    text: string;
  }): Promise<{
    total: number;
    dimensions: WriteDimensionResult[];
    comments: string[];
    suggestions: string[];
  }> {
    try {
      const raw = await this.providers.llm.structured<GraderPayload>(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildPrompt(input) },
        ],
        GRADER_SCHEMA,
        // `grounded` 档：这是"依据给定材料（学生的作文）作答"，不是创作。
        // 用 `create` 档（temp 0.7）会让同一篇作文两次得到不同的分数，
        // 而 SM-2 会按这个分数排复习 —— 抖动直接污染调度。
        { tier: 'generate', ...sampling('grounded', { maxTokens: 1500 }) },
      );
      return normalize(raw);
    } catch (e) {
      this.logger.warn(
        `作文批改失败，已降级：${e instanceof Error ? e.message : String(e)}`,
        'Practice',
      );
      return degraded();
    }
  }
}

/**
 * 批改提示词。
 *
 * ⚠️ 三条硬约束写进提示词，缺一条就会出现具体的问题：
 *   ① **不重写整篇** —— 让模型给一篇"更好的范文"，用户会直接抄，
 *      下次还是写不出来。要的是"这几处可以怎么改"。
 *   ② **每个维度必须给理由** —— 只给分数的话用户不知道从哪改，
 *      而"内容 25 分"这种反馈比不给还糟（他会以为老师不喜欢他的观点）。
 *   ③ **不承诺等同官方评分** —— 见 `WRITE_DIMENSIONS` 的说明。本项目用的是
 *      通用 LLM，没有人工标注校准数据，说"等同四六级阅卷标准"是虚假承诺。
 */
const SYSTEM_PROMPT = [
  '你是一位中国大学英语写作老师，正在批改学生的四六级英语作文。',
  '',
  '请按四个方面打分（0~100 的整数）并给出简短理由：',
  `  ${WRITE_DIMENSIONS.map((d) => `${d.title}（${d.desc}）`).join('；')}`,
  '',
  '要求：',
  '1. 每个维度都要给理由，理由要**指向具体句子或具体问题**，不要写"总体不错"这类空话；',
  '2. `suggestions` 给 2~3 条改写建议，**引用学生原句再给改法**，不要重写整篇；',
  '3. 评分要严格但具体：语法错误、拼写错误、时态错误都要指出来；',
  '4. 全部用中文回答，`suggestions` 里的英文原句与改法保留英文；',
  '5. 你给的是**参考批改**，不要声称等同于官方阅卷标准。',
  '',
  '打分口径（供你校准，不要写进输出）：',
  '  85+ = 内容完整、结构清晰、几乎无语言错误；',
  '  70~84 = 基本切题、结构清楚、有若干语言错误但不影响理解；',
  '  55~69 = 部分切题、结构松散、语言错误较多；',
  '  <55 = 明显跑题或篇幅严重不足。',
].join('\n');

/** 结构化输出的 JSON Schema（与 `GraderPayload` 逐项对齐） */
const GRADER_SCHEMA = {
  type: 'object',
  properties: {
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: WRITE_DIMENSIONS.map((d) => d.key) },
          score: { type: 'integer', minimum: 0, maximum: 100 },
          comment: { type: 'string' },
        },
        required: ['key', 'score', 'comment'],
      },
    },
    suggestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['dimensions'],
} as const;

interface GraderPayload {
  dimensions: { key: string; score: number; comment: string }[];
  suggestions?: string[];
}

function buildPrompt(input: { title: string; outline: string[]; text: string }): string {
  const outline =
    input.outline.length > 0
      ? input.outline.map((o, i) => `  ${i + 1}. ${o}`).join('\n')
      : '  （此题未给提纲）';
  return [
    `【题目】${input.title}`,
    '',
    '【提纲】',
    outline,
    '',
    '【学生的作文】',
    input.text,
  ].join('\n');
}

/**
 * 把 LLM 的返回整理成完整的四维结果。
 *
 * ⚠️ **必须以 `WRITE_DIMENSIONS` 为基准补齐**，而不是直接用模型给的数组：
 *   · 模型可能漏掉某个维度（尤其 `vocabulary`，它排最后）；
 *   · 可能多给一个不存在的 key；
 *   · 可能顺序打乱 —— 而界面按固定顺序渲染，顺序乱了用户会以为"维度变了"。
 * 漏掉的维度给 0 分并注明"未能评出"，不 silently 用其它维度的均分顶替。
 */
function normalize(raw: GraderPayload): {
  total: number;
  dimensions: WriteDimensionResult[];
  comments: string[];
  suggestions: string[];
} {
  const byKey = new Map<string, { score: number; comment: string }>();
  for (const d of raw.dimensions ?? []) {
    if (!d || typeof d.key !== 'string') continue;
    byKey.set(d.key, {
      score: clampScore(d.score),
      comment: typeof d.comment === 'string' ? d.comment.trim() : '',
    });
  }

  const dimensions: WriteDimensionResult[] = WRITE_DIMENSIONS.map((d) => {
    const got = byKey.get(d.key);
    return {
      key: d.key,
      title: d.title,
      weight: d.weight,
      score: got?.score ?? 0,
      comment: got?.comment || '这一项未能评出，可以对照范文再看看。',
    };
  });

  const scores = Object.fromEntries(dimensions.map((d) => [d.key, d.score])) as Record<
    WriteDimensionKey,
    number
  >;
  return {
    // 总分在**这里**算（不在提示词里让模型给），见文件头说明
    total: weightedWriteScore(scores),
    dimensions,
    comments: dimensions.map((d) => `${d.title}：${d.comment}`),
    suggestions: (raw.suggestions ?? [])
      .filter((s): s is string => typeof s === 'string' && Boolean(s.trim()))
      .slice(0, 4),
  };
}

function clampScore(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/**
 * 批改不可用时的降级结果（见文件头：不阻断提交，但要留痕）。
 *
 * ⚠️ 故意**不收 `e` 参数**：异常内容已经由 `catch` 里的 `logger.warn` 记下了，
 * 塞进用户可见的文案里只会暴露上游细节（模型名、状态码），
 * 而用户能从中学到的只有"哦，坏了"。
 */
function degraded(): {
  total: number;
  dimensions: WriteDimensionResult[];
  comments: string[];
  suggestions: string[];
} {
  return {
    total: 0,
    dimensions: WRITE_DIMENSIONS.map((d) => ({
      key: d.key,
      title: d.title,
      weight: d.weight,
      score: 0,
      // ⚠️ 文案必须说清"是批改服务的问题，不是你的作文的问题"，
      // 否则用户看到四个 0 分会直接劝退
      comment: '批改服务暂时不可用，这次没能评出这一项。',
    })),
    comments: [
      '批改服务暂时不可用，你的作文已经保存下来了，稍后可以在「我的练习」里重新提交批改。',
    ],
    suggestions: [],
  };
}
