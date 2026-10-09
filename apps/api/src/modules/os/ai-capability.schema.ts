/**
 * 工具参数 schema 的**出方向转换**（DB schema → 模型可用的 JSON Schema）
 *
 * 同一个 schema 要服务两类消费者，而它们要的东西不一样：
 *
 * | | 执行页表单（`pkg-toolbox/run`） | 模型工具调用 |
 * |---|---|---|
 * | 来源 | `apps/api/prisma/tool-input-schemas.ts`（DB 的 `tool.inputSchema`） | 本文件转出来的 |
 * | 要 `title` / `enumLabels` | 要（渲染中文标签） | 不要（改用 `description`） |
 * | 要 `x-widget` | 要（决定多行输入框） | 不要（某些服务商会因未知字段 400） |
 * | 要 `default` | 要 | 可以留，但模型容易误以为"必须显式传" |
 *
 * 这里只做**出方向**（准备阶段）：`toModelParams()` 与工具描述拼装。
 * 反方向（模型参数进来后按同一 schema 收敛）在 `ai-capability.params.ts` ——
 * 两个方向的失败后果完全不同，拆开才不会改一边漏一边。
 *
 * 本文件全部是**纯函数**，单测直接打靶，不必拉起 Nest 容器。
 */

/** DB schema 里只服务于 UI 渲染的键，不能进模型请求 */
const UI_ONLY_KEYS = new Set(['title', 'enumLabels', 'x-widget', 'placeholder', 'xWidget']);

/** 允许进入模型请求的 JSON Schema 键 */
const PASSTHROUGH_KEYS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'description',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'default',
]);

/** DB schema 的形状（只声明用得到的部分，避免 `any`） */
interface RawPropSchema {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  enumLabels?: unknown[];
  minimum?: number;
  maximum?: number;
  items?: RawPropSchema;
}

interface RawObjectSchema {
  type?: string;
  properties?: Record<string, RawPropSchema>;
  required?: string[];
}

/**
 * DB 的入参 schema → 模型可用的工具参数 schema。
 *
 * 把中文 `title` **降级成 `description`** 而不是删掉：模型是靠 description
 * 理解字段含义的，删了它就只能靠字段名（`targetSizeMb`）猜，
 * 而中文标签恰恰是最好的说明。
 */
export function toModelParams(inputSchema: unknown): Record<string, unknown> {
  const raw = (inputSchema ?? {}) as RawObjectSchema;
  const props = raw.properties ?? {};

  const properties: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(props)) {
    properties[key] = convertProp(prop);
  }

  return {
    type: 'object',
    properties,
    required: Array.isArray(raw.required) ? raw.required : [],
    // 显式关掉额外字段：模型偶尔会发明参数名，关掉后服务商侧就会拒绝而不是静默忽略
    additionalProperties: false,
  };
}

/** 单个字段的转换（递归 items） */
function convertProp(prop: RawPropSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(prop)) {
    if (UI_ONLY_KEYS.has(k) || !PASSTHROUGH_KEYS.has(k)) continue;
    if (k === 'description') continue; // 统一在下面合并 title
    out[k] = v;
  }

  if (prop.items) out.items = convertProp(prop.items);

  // title 作为最优先的说明；已有 description（手写的）优先保留
  const label = typeof prop.title === 'string' ? prop.title : '';
  if (label && typeof out.description !== 'string') out.description = label;

  if (!out.type) out.type = 'string';
  return out;
}

/**
 * 组装模型的工具描述（出方向的另一半：schema 之外还要说清"什么时候用"）。
 *
 * 结构固定四段：**名称 → 适用场景 → 不适用 → 文件要求**。
 *
 * 「不适用」不是可有可无的：只写"什么时候能用"会让模型把
 * "PPT 怎么做"这种**方法咨询**也当成生成任务，凭空给用户建一个作业 ——
 * 而作业是要占配额、占执行资源的。
 *
 * 「文件要求」同理：不写清楚，模型会在用户没传文件时直接调用，
 * 然后拿到一个失败结果，再对着用户编一段听起来合理的解释。
 */
export function buildToolDescription(input: {
  title: string;
  scene: string;
  notFor?: string[];
  needsFile: string | false;
  guideHint?: string;
}): string {
  const lines = [`【${input.title}】${input.scene}`];

  if (input.notFor?.length) {
    lines.push(`不要用于：${input.notFor.join('；')}`);
  }

  if (input.needsFile) {
    lines.push(
      `⚠️ 本能力必须由用户先提供${fileKindLabel(input.needsFile)}文件。` +
        `若当前对话里用户没有提供对应文件，**不要调用**，而是告诉他${input.guideHint ?? '需要先上传文件'}。`,
    );
  }

  return lines.join('\n');
}

/** 文件类别 → 中文（写进工具描述，让模型能对用户说人话） */
function fileKindLabel(kind: string): string {
  const map: Record<string, string> = { image: '图片', audio: '音频', video: '视频', text: '文本' };
  return map[kind] ?? '';
}
