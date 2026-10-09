import type { LlmMessage } from '@qz/core';

/**
 * AI 极速发布（任务清单 M3-07）—— 提示词 / 输出 schema / 归一化。
 *
 * ## 定位：**只是加速填表，不替用户做决定**
 *
 * 模型把一句话拆成结构化草稿，用户在前端**可以逐项修改**。
 * 所以这里对输出的容错策略是"能填就填、填不了就留空"，
 * 而不是像 `os-planner` 那样"不合法就整体降级" ——
 * 计划是一份要照着执行的 DAG，草稿只是一个预填表单，两者代价不同。
 *
 * ## 唯一不许含糊的是钱
 *
 * 模型给的是 `budgetYuan`（元，小整数，模型算得准），
 * 归一化时**立刻乘 100 转成分**（红线：金额一律用「分」整数）。
 * 让模型直接输出"分"是行不通的 —— 它会把 300 元写成 300 或 30000，
 * 而这两种错误在表单上看起来都"像个正常数字"。
 */

/** 服务分类 id（必须与 `service_category` 表一致，由 `npm run check:categories` 守卫） */
export const PARSE_CATEGORY_IDS = [
  'photo',
  'design',
  'copy',
  'code',
  'tutor',
  'host',
  'video',
  'rent',
  'other',
] as const;

export const PARSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    categoryId: { type: 'string', enum: [...PARSE_CATEGORY_IDS] },
    budgetYuan: { type: 'number' },
    time: { type: 'string' },
    location: { type: 'string' },
    skillTags: { type: 'array', items: { type: 'string' } },
  },
  required: ['title'],
} as const;

/**
 * 系统提示词。
 *
 * 三条约束都是针对**模型最容易犯且最难发现**的错误：
 *   · 编造没提到的信息（用户只说"拍毕业照"，模型会自己补上"预算 500 元"）；
 *   · 把 categoryId 写成中文分类名（`"摄影摄像"` 而不是 `"photo"`）；
 *   · 输出 Markdown 围栏，让 JSON 解析直接失败。
 */
export const PARSE_SYSTEM_PROMPT = `你是「青智校园」驿站的需求录入助手。用户会用一句话描述他想找人帮忙做的事，你要把它整理成结构化草稿。

输出规则（必须严格遵守）：
1. **只输出 JSON**，不要解释文字、不要 Markdown 围栏。
2. **只填用户真正说过的信息**。没提到的字段一律**不要输出**。
   ⚠️ 特别是预算：用户没说钱就**不要**给 budgetYuan。编一个价格会让用户以为那是系统估价。
3. 字段含义：
   - "title"：需求标题，**必填**，不超过 20 字，概括"要做什么"；
   - "description"：把用户原话整理成通顺的需求描述，**可以补充标点与语序，不许添加事实**；
   - "categoryId"：只能取以下之一（英文 id，不是中文名）：
     ${PARSE_CATEGORY_IDS.join(' / ')}；
   - "budgetYuan"：预算，单位**元**，数字。用户说"300 块"就填 300；
   - "time"：期望时间，**原样保留用户说法**（如"6月10日"、"明天"、"下周"）；
   - "location"：地点，原样保留（如"本校"、"三教楼下"）；
   - "skillTags"：从描述里能看出的技能要求，1~5 个短词（如"摄影"、"后期修图"）。

示例：
用户："帮我找个摄影师拍毕业照，大概300块，6月10日在学校"
{"title":"毕业照拍摄","description":"帮我找个摄影师拍毕业照。","categoryId":"photo","budgetYuan":300,"time":"6月10日","location":"学校","skillTags":["摄影"]}

用户："需要有人帮我做个答辩PPT"
{"title":"答辩PPT制作","description":"需要有人帮我做个答辩PPT。","categoryId":"design","skillTags":["PPT"]}`;

export function buildParseMessages(text: string): LlmMessage[] {
  return [
    { role: 'system', content: PARSE_SYSTEM_PROMPT },
    { role: 'user', content: text },
  ];
}

/** 解析结果（前端表单直接消费） */
export interface ParsedDraft {
  title: string;
  description?: string;
  categoryId?: string;
  /** 预算，**分**。`undefined` = 用户没提，前端不要预填 */
  budget?: number;
  time?: string;
  location?: string;
  skillTags: string[];
}

/** 标题兜底长度：模型没给标题时截取原话，与前端本地兜底规则一致 */
const FALLBACK_TITLE_CHARS = 20;

/** 预算上限（分）= 100 万元。超过基本可以断定是模型把"元"当"分"写了或纯属瞎编 */
const MAX_BUDGET_CENTS = 100_000_000;

/**
 * 归一化模型输出。
 *
 * 与 `normalizePlan` 不同，这里**不整体降级** —— 草稿的每一项都是独立的，
 * 少一项不影响其余项可用，而整体丢弃会让用户白等一次模型调用。
 * 唯一会丢的是"明显不可能"的值（预算为负、超过上限）。
 */
export function normalizeParsed(raw: unknown, fallbackText: string): ParsedDraft {
  const r = asRecord(raw);

  return {
    title: str(r.title).slice(0, 60) || fallbackText.trim().slice(0, FALLBACK_TITLE_CHARS),
    ...optional('description', str(r.description)),
    ...optional('categoryId', toCategoryId(r.categoryId)),
    ...optional('budget', toBudgetCents(r.budgetYuan)),
    ...optional('time', str(r.time)),
    ...optional('location', str(r.location)),
    skillTags: toTags(r.skillTags),
  };
}

/** 只接受白名单内的分类 id。模型写中文分类名时**留空**，而不是猜一个最接近的 */
function toCategoryId(v: unknown): string | undefined {
  const s = str(v);
  return (PARSE_CATEGORY_IDS as readonly string[]).includes(s) ? s : undefined;
}

/** 元 → 分。非有限数、非正数、超上限一律丢弃 */
function toBudgetCents(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;

  const cents = Math.round(n * 100);
  return cents > MAX_BUDGET_CENTS ? undefined : cents;
}

/** 技能标签：去空、去重、单个不超过 20 字（与 `PublishTaskSchema` 的上限对齐） */
function toTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const tags = v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().slice(0, 20))
    .filter(Boolean);
  return [...new Set(tags)].slice(0, 10);
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 只在有值时带上该键 —— 前端据此判断"这一项要不要预填" */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined || value === '' ? {} : { [key]: value };
}
