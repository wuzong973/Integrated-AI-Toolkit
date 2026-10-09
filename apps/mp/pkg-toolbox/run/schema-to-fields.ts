/**
 * JSON Schema → 表单字段（文档 5.3.5「表单字段由工具的 inputSchema 动态渲染」）
 *
 * 为什么需要它：执行页原先只读本地 `FIELD_PRESETS`，接口返回的 `inputSchema` 根本没被使用，
 * 于是"动态渲染"名不副实 —— 新增工具必须改小程序代码。这里补上真正的转换，
 * 后端加了 schema 就能自动出表单，`FIELD_PRESETS` 退化为接口不可用时的兜底。
 *
 * 支持的 JSON Schema 子集（与 apps/api/prisma/tool-input-schemas.ts 约定一致）：
 *   enum + enumLabels → select
 *   type: number      → number（带 minimum / maximum）
 *   type: boolean     → switch
 *   x-widget: textarea → textarea
 *   其余 string       → text
 */

import type { FormField } from './field-presets';

/** inputSchema 里单个属性的形状 */
interface SchemaProperty {
  type?: string;
  title?: string;
  default?: string | number | boolean;
  enum?: (string | number)[];
  enumLabels?: string[];
  minimum?: number;
  maximum?: number;
  placeholder?: string;
  'x-widget'?: string;
}

interface SchemaObject {
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

/** 把工具入参 schema 转成表单字段；非法或空 schema 返回 []（由调用方兜底） */
export function schemaToFields(schema: unknown): FormField[] {
  const root = asSchemaObject(schema);
  if (!root?.properties) return [];

  const required = new Set(Array.isArray(root.required) ? root.required : []);
  return Object.keys(root.properties).map((key) =>
    toField(key, root.properties![key] ?? {}, required.has(key)),
  );
}

function asSchemaObject(schema: unknown): SchemaObject | null {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return null;
  return schema as SchemaObject;
}

/** 单个属性 → 表单字段 */
function toField(key: string, prop: SchemaProperty, isRequired: boolean): FormField {
  const base: FormField = {
    key,
    label: prop.title || key,
    type: 'text',
    placeholder: prop.placeholder,
  };
  if (isRequired) base.required = true;
  if (prop.default !== undefined) base.default = prop.default;

  // 枚举优先：有 enum 就一定是下拉
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    return {
      ...base,
      type: 'select',
      options: prop.enum.map((value, i) => ({
        label: prop.enumLabels?.[i] ?? String(value),
        value: String(value),
      })),
    };
  }

  if (prop.type === 'number' || prop.type === 'integer') {
    return { ...base, type: 'number', min: prop.minimum, max: prop.maximum };
  }
  if (prop.type === 'boolean') {
    return { ...base, type: 'switch' };
  }
  if (prop['x-widget'] === 'textarea') {
    return { ...base, type: 'textarea' };
  }
  return base;
}
