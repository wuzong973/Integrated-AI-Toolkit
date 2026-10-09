import { OS_INTENTS, type LlmMessage, type OsIntentName, type OsIntentResult } from '@qz/core';

/**
 * 意图识别（青智 OS 的入口）
 *
 * ## 为什么单独成文件
 *
 * 提示词、输出 schema、输出校验是**一套东西**，散在 service 里会让"改了提示词
 * 忘了改 schema"这类错误悄悄发生。集中一处便于对照维护，也便于单测直接打靶。
 *
 * ## 契约三方一致（改一处必须改三处）
 *
 *   1. 本文件的 `INTENT_JSON_SCHEMA` 与 `INTENT_SYSTEM_PROMPT`
 *   2. `packages/core/src/validators/index.ts` 的 `OS_INTENTS` / `OsIntentResult`
 *   3. 小程序 `pages/os/index.ts` 的 `INTENT_TOOL_MAP` / `localIntent`（离线兜底）
 *
 * 任一处改了取值名，界面就会退化成"什么都不知道"的兜底回复 ——
 * 而且**不会报错**，只会表现为"AI 变笨了"。
 */

/** 结构化输出的 JSON Schema（智谱 `response_format: json_schema` 已实测支持） */
export const INTENT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...OS_INTENTS] },
    confidence: { type: 'number' },
    isComposite: { type: 'boolean' },
    entities: { type: 'object' },
    needsClarification: { type: 'boolean' },
    questions: { type: 'array', items: { type: 'string' } },
    subtasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['ai', 'human'] },
        },
        required: ['name', 'type'],
      },
    },
  },
  required: ['intent', 'confidence', 'isComposite'],
} as const;

/**
 * 系统提示词。
 *
 * 设计要点：
 *   · 只做**分类与抽取**，不让模型写长篇解释 —— 这是意图识别，不是聊天；
 *   · `isComposite` 的判定标准写清楚（需要"多个步骤 + 至少一个真人环节"才算复合），
 *     否则模型会把"做个 PPT"也判成复合，凭空生成一堆人力节点；
 *   · 明确"拿不准时降低 confidence"，让界面能显示不确定性而不是假装自信。
 */
export const INTENT_SYSTEM_PROMPT = `你是「青智校园」的意图识别器。用户会用一句自然语言描述想做的事，你要判断它属于哪一类。

可选意图（只能选一个，必须原样返回英文标识）：
- file_process：文件/媒体处理。转格式、压缩体积、裁剪、OCR 识别文字等。
- media_ai：音视频的 AI 处理。人声/伴奏分离、音频降噪、视频字幕。
- ai_generate：用 AI 生成内容。做 PPT、写大纲、写文档、生成图片提示词、总结长文。
- campus_service：需要真人帮忙或发布需求到青智驿站。找人拍照、找人跑腿、办活动、发布任务。
- knowledge：只是提问、咨询、闲聊，或无法归入以上任何一类。

判定 isComposite（是否需要拆成多步骤计划）的标准，**三条必须同时满足**：
1. 目标包含多个可独立交付的产物（如"方案 + 预算 + 海报"）；
2. 其中至少一个环节**必须真人完成**（如摄影、主持、现场执行）；
3. 这些环节之间存在先后依赖。
只满足 1 或 2 都不算复合 —— 例如"帮我做个 PPT"是单一任务，"帮我办一场活动"才是复合。

confidence 用 0~1 表示你的把握：明确匹配某个意图给 0.8~0.95；
含义模糊、可能属于两类的给 0.4~0.6；完全不知所云给 0.2 以下。

entities 里抽取用户提到的关键信息（如 targetSize、format、peopleCount、budget），
抽不到就给空对象，**不要编造**。

当 isComposite 为 true 时，必须在 subtasks 里给出拆解结果：每项是
{ "name": "子任务名", "type": "ai" | "human" }。
- type 为 "ai"：机器可以独立完成（写方案、做预算表、生成海报提示词…）
- type 为 "human"：必须真人到场或动手（摄影摄像、现场主持、志愿者…）
**只拆解用户真正提到的目标**，不要为了凑数添加环节；拿不准就归为 "ai"。
subtasks 里的每一项都还是**待执行**，不要假设任何一项已经完成。

若用户的话信息不足以判断（例如"帮我弄一下那个"），把 needsClarification 设为 true，
并在 questions 里给出 1~2 个具体问题。

只输出 JSON，不要任何解释文字。`;

/** 组装意图识别请求消息 */
export function buildIntentMessages(text: string): LlmMessage[] {
  return [
    { role: 'system', content: INTENT_SYSTEM_PROMPT },
    { role: 'user', content: text },
  ];
}

/**
 * 校验并归一化模型输出。
 *
 * **不信任模型输出**：即使 schema 声明了 enum，模型仍可能返回表外取值
 *（或漏字段、把 confidence 写成字符串）。这里全部兜底成合法值 ——
 * 让"AI 偶尔不听话"退化为"答得不够准"，而不是让界面拿到 undefined 崩掉。
 *
 * 兜底策略：无法识别的意图一律归为 `knowledge`（最保守：不触发任何动作），
 * 并把 confidence 压到 0.3，让界面能如实呈现"没太听懂"。
 */
export function normalizeIntent(raw: unknown): OsIntentResult {
  const r = (raw ?? {}) as Record<string, unknown>;

  const intent = OS_INTENTS.includes(r.intent as OsIntentName)
    ? (r.intent as OsIntentName)
    : 'knowledge';
  const recognized = intent !== 'knowledge' || r.intent === 'knowledge';

  /**
   * ⚠️ 顺序很重要：**先判"有没有识别出来"，再看模型自报的置信度**。
   * 模型对表外意图也会自信地报 0.99（实测它会把"发射导弹"标成新意图并给高置信度），
   * 所以未识别时一律压到 0.3 —— 让界面如实呈现"没太听懂"，
   * 而不是把一个凭空捏造的把握度透给用户。
   */
  const num = Number(r.confidence);
  const confidence = !recognized ? 0.3 : Number.isFinite(num) ? clamp01(num) : 0.5;

  return {
    intent,
    confidence,
    isComposite: r.isComposite === true,
    entities: isPlainObject(r.entities) ? (r.entities as Record<string, string>) : undefined,
    needsClarification: r.needsClarification === true,
    questions: toStringArray(r.questions),
    subtasks: toSubtaskArray(r.subtasks),
  };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function isPlainObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  return list.length ? list : undefined;
}

/**
 * 归一化子任务数组。
 *
 * `type` **只认 `'human'`，其余一律当 `'ai'`** —— 这是刻意的保守取舍：
 * 判成 ai 顶多是"该找人的环节没给发布入口"，判成 human 却会凭空多出一个
 * "需真人完成"的节点、引导用户去发布一个根本不存在的需求。
 * 名字为空的项直接丢掉（模型偶尔会返回空壳对象）。
 */
function toSubtaskArray(v: unknown): { name: string; type: 'ai' | 'human' }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list = v
    .filter(isPlainObject)
    .map((x) => {
      const o = x as Record<string, unknown>;
      return {
        name: typeof o.name === 'string' ? o.name.trim() : '',
        type: o.type === 'human' ? ('human' as const) : ('ai' as const),
      };
    })
    .filter((x) => x.name !== '');
  return list.length ? list : undefined;
}
