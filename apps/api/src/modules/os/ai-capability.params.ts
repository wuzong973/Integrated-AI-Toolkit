/**
 * 参数收敛与展示 —— 「模型给的参数 → 执行器能吃的参数」以及「→ 给人看的摘要」
 *
 * 与 `ai-capability.schema.ts` 是两个方向，刻意分文件：
 *   · `schema.ts` —— DB schema **出去**，转成模型可用的 JSON Schema（准备阶段）；
 *   · `params.ts` —— 模型参数**进来**，按同一个 schema 收敛（运行阶段）。
 * 方向相反、失败后果也完全不同（前者错了模型看不懂字段，后者错了执行器拿到脏值），
 * 混在一个文件里最容易改一边漏一边。
 *
 * ## 为什么必须收敛，不能直接透传
 *
 * 模型的工具参数是**它自己拼的 JSON**，不可信：实测会出现
 * `pages: "16"`（字符串）、`style: "商务风格"`（中文而非枚举值）、
 * `depth: 99`（超范围）、以及凭空多出来的 `reason` 字段。
 * 直接透传会变成"参数非法"这类面向开发者的报错 ——
 * 而模型并不知道自己错在哪，下一轮照错不误。
 *
 * 收敛策略（一律**降级**而不是抛错，因为缺字段时执行器自己有兜底）：
 *   · 不在 schema 里的键 → 丢掉；
 *   · `null` / 空串 → 视为"没有这个值"，退回 schema 的 `default`；
 *   · `number` → 字符串转数字，超范围**钳位**（99 → 上限）而不是丢弃；
 *   · `enum` → 中文标签按位置映射回真实取值，表外值回退 `default`；
 *   · 类型不匹配（对象/数组）→ 丢弃。
 */

/** DB schema 里的字段形状（与 `ai-capability.schema.ts` 保持一致的子集） */
export interface RawPropSchema {
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

/** `null` / `undefined` / 空串都表示"没有这个值"，而不是"我要一个空值" */
function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

function asObjectSchema(v: unknown): RawObjectSchema {
  return (v ?? {}) as RawObjectSchema;
}

function propsOf(schema: RawObjectSchema): Record<string, RawPropSchema> {
  return schema.properties ?? {};
}

/** 取字段的值：模型没给（或给了空值）就用 schema 的 default */
function pickValue(prop: RawPropSchema, src: Record<string, unknown>, key: string): unknown {
  const provided = Object.prototype.hasOwnProperty.call(src, key) ? src[key] : undefined;
  // `pages: null` 应该是 16 页（default），而不是"不传页数"（执行器再兜底一次）
  return isBlank(provided) ? prop.default : provided;
}

/** 模型给的参数 → 执行器能吃的参数 */
export function coerceParams(inputSchema: unknown, raw: unknown): Record<string, unknown> {
  const props = propsOf(asObjectSchema(inputSchema));
  const src = isPlainObject(raw) ? raw : {};

  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(props)) {
    const value = pickValue(prop, src, key);
    if (isBlank(value)) continue;

    const coerced = coerceProp(prop, value);
    if (coerced !== undefined && coerced !== '') out[key] = coerced;
  }
  return out;
}

/** 单字段收敛；返回 `undefined` 表示"这个值不能用，丢掉" */
function coerceProp(prop: RawPropSchema, value: unknown): unknown {
  switch (prop.type) {
    case 'number':
    case 'integer':
      return coerceNumber(prop, value);
    case 'boolean':
      return coerceBoolean(value);
    case 'array':
      return coerceArray(prop, value);
    default:
      return coerceString(prop, value);
  }
}

/** 数值：能转就转，超范围钳位（模型给 99 而上限 3 时，"3" 比"整段失败"有用） */
function coerceNumber(prop: RawPropSchema, value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return undefined;

  const clamped = clamp(n, prop);
  if (inEnum(prop, clamped)) return clamped;

  const fb = prop.default;
  return typeof fb === 'number' ? fb : undefined;
}

function clamp(n: number, prop: RawPropSchema): number {
  let v = prop.type === 'integer' ? Math.round(n) : n;
  if (typeof prop.minimum === 'number') v = Math.max(prop.minimum, v);
  if (typeof prop.maximum === 'number') v = Math.min(prop.maximum, v);
  return v;
}

/**
 * 布尔：只认真正的布尔与 `"true"` / `"false"` 字面量。
 *
 * 不把 `"1"` / `"yes"` 也当 true —— 那会悄悄把一个用户没做的确认打开（如版权声明）。
 */
function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function coerceArray(prop: RawPropSchema, value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  if (!prop.items) return value;
  return value.map((v) => coerceProp(prop.items as RawPropSchema, v));
}

function coerceString(prop: RawPropSchema, value: unknown): unknown {
  const str = typeof value === 'string' ? value.trim() : toStr(value);
  if (!str) return undefined;
  if (!inEnum(prop, str)) return prop.default;
  // ⚠️ 命中「标签」时要把中文标签换回枚举真实取值，否则会把
  // `style: "商务"` 直接透给执行器 —— 它的白名单里只有 `business`
  return normalizeEnum(prop, str);
}

/**
 * 有 enum 时必须命中白名单。
 *
 * 也接受中文标签：`enumLabels` 是给人看的，但模型见过界面上那个词，
 * 偶尔会把标签当值传回来 —— 这种情况映射回真实取值即可，没必要判失败。
 */
function inEnum(prop: RawPropSchema, value: unknown): boolean {
  if (!Array.isArray(prop.enum) || prop.enum.length === 0) return true;
  if (prop.enum.includes(value)) return true;
  return (prop.enumLabels ?? []).indexOf(value) >= 0;
}

/** enum 命中中文标签的修正：`"商务"` → `"business"` */
function normalizeEnum(prop: RawPropSchema, value: unknown): unknown {
  if (!Array.isArray(prop.enum) || prop.enum.includes(value)) return value;
  const idx = (prop.enumLabels ?? []).indexOf(value);
  return idx >= 0 ? prop.enum[idx] : prop.default;
}

/**
 * 该 schema 的必填字段。
 *
 * 用途：**必填项缺失时不要执行**。`generate_ppt` 少了 `topic` 也能跑
 *（执行器会兜底成"未命名演示文稿"），但那会产出一份用户没要过的东西 ——
 * 比让助手回一句"你想做什么主题的 PPT？"糟得多。
 */
export function requiredFields(inputSchema: unknown): string[] {
  const raw = asObjectSchema(inputSchema);
  return Array.isArray(raw.required) ? raw.required : [];
}

/** 取字段的中文标签，用于把"缺哪个必填项"讲给模型听 */
export function fieldLabel(inputSchema: unknown, key: string): string {
  return propsOf(asObjectSchema(inputSchema))[key]?.title ?? key;
}

/**
 * 把已收敛的参数翻译成**给人看的键值对**（结果卡上的"参数摘要"）。
 *
 * 为什么要翻译而不是直接展示 JSON：
 *  · 用户看到的是 `style: business`，而界面上那个选项叫「商务」；
 *  · 没传的字段不该出现（展示一堆空值会让人以为出错了）。
 * 用户能据此判断"这不是我要的"，然后让助手重做一次 —— 这是结果卡存在的意义。
 */
export function describeParams(
  inputSchema: unknown,
  params: Record<string, unknown>,
): { label: string; value: string }[] {
  const props = propsOf(asObjectSchema(inputSchema));

  const out: { label: string; value: string }[] = [];
  for (const [key, value] of Object.entries(params)) {
    const item = describeParam(props[key], key, value);
    if (item) out.push(item);
  }
  return out;
}

function describeParam(
  prop: RawPropSchema | undefined,
  key: string,
  value: unknown,
): { label: string; value: string } | null {
  if (!prop || isBlank(value)) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  return { label: prop.title ?? key, value: displayValue(prop, value) };
}

/** 枚举值翻译成中文标签；其余原样转字符串 */
function displayValue(prop: RawPropSchema, value: unknown): string {
  const idx = Array.isArray(prop.enum) ? prop.enum.indexOf(value) : -1;
  const labels = prop.enumLabels ?? [];
  return idx >= 0 && typeof labels[idx] === 'string' ? (labels[idx] as string) : String(value);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toStr(v: unknown): string {
  return typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
}
