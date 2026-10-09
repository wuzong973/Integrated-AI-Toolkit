import { describe, expect, it } from 'vitest';

import { toModelParams, buildToolDescription } from '../ai-capability.schema';
import { coerceParams, describeParams, requiredFields } from '../ai-capability.params';

/**
 * 参数 schema 的两个方向
 *
 * 这组用例盯的是**最容易静默失败的一层**：模型的参数不可信，
 * 而它错的方式都很安静 —— 传字符串、传中文标签、发明新字段。
 * 这些如果透传到执行器，报出来的是面向开发者的"参数非法"，
 * 用户看到"失败"，模型也不知道自己错在哪、下一轮照错不误。
 *
 * 两个方向各有各的坑，所以分开断言：
 *   · 出方向（`toModelParams`）—— 把 UI 专用键透给服务商会 400；
 *   · 入方向（`coerceParams`）—— 脏值透给执行器会失败。
 */

/** 取自真实 `tool-input-schemas.ts` 的形状（含 UI 专用键） */
const PPT_SCHEMA = {
  type: 'object',
  properties: {
    topic: { type: 'string', title: '主题', placeholder: '如：创青春商业计划书' },
    purpose: {
      type: 'string',
      title: '用途',
      default: 'contest',
      enum: ['contest', 'course', 'defense', 'other'],
      enumLabels: ['比赛路演', '课程汇报', '答辩', '其他'],
    },
    pages: { type: 'number', title: '页数', default: 16, minimum: 5, maximum: 40 },
    extra: { type: 'string', title: '补充要求', 'x-widget': 'textarea' },
  },
  required: ['topic'],
};

describe('toModelParams —— DB schema 转成模型能用的 JSON Schema', () => {
  it('⭐ 剥掉只给表单用的键，否则某些服务商会因未知字段报 400', () => {
    const p = toModelParams(PPT_SCHEMA) as {
      properties: Record<string, Record<string, unknown>>;
    };
    for (const key of ['topic', 'purpose', 'pages', 'extra']) {
      expect(p.properties[key]).not.toHaveProperty('title');
      expect(p.properties[key]).not.toHaveProperty('enumLabels');
      expect(p.properties[key]).not.toHaveProperty('x-widget');
    }
  });

  it('⭐ title 降级为 description（不删）—— 模型靠中文说明理解字段含义', () => {
    const p = toModelParams(PPT_SCHEMA) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(p.properties.topic.description).toBe('主题');
  });

  it('枚举与数值区间原样保留（模型的约束来自这里）', () => {
    const p = toModelParams(PPT_SCHEMA) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(p.properties.purpose.enum).toEqual(['contest', 'course', 'defense', 'other']);
    expect(p.properties.pages.minimum).toBe(5);
    expect(p.properties.pages.maximum).toBe(40);
  });

  it('required 原样带出；空 schema 也不报错', () => {
    expect((toModelParams(PPT_SCHEMA) as { required: string[] }).required).toEqual(['topic']);
    expect(toModelParams(undefined)).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });
});

describe('coerceParams —— 收敛模型给的参数', () => {
  it('⭐ 字符串数字转成数字（模型经常把 16 写成 "16"）', () => {
    const p = coerceParams(PPT_SCHEMA, { topic: 'X', pages: '16' });
    expect(p.pages).toBe(16);
  });

  it('⭐ 中文标签映射回枚举真实取值（传 "比赛路演" → contest）', () => {
    const p = coerceParams(PPT_SCHEMA, { topic: 'X', purpose: '比赛路演' });
    expect(p.purpose).toBe('contest');
  });

  it('⭐ 表外枚举值回退到 default，而不是把脏值透给执行器', () => {
    const p = coerceParams(PPT_SCHEMA, { topic: 'X', purpose: '随便什么风格' });
    expect(p.purpose).toBe('contest');
  });

  it('⭐ 超范围的数值被钳位（99 → 40），而不是整段失败', () => {
    expect(coerceParams(PPT_SCHEMA, { topic: 'X', pages: 99 }).pages).toBe(40);
    expect(coerceParams(PPT_SCHEMA, { topic: 'X', pages: 0 }).pages).toBe(5);
  });

  it('⭐ 不在 schema 里的字段被丢掉（模型会塞 reason / explanation 这类字段）', () => {
    const p = coerceParams(PPT_SCHEMA, { topic: 'X', reason: '因为用户说了', foo: 1 });
    expect(Object.keys(p).sort()).toEqual(['pages', 'purpose', 'topic']);
    expect(p).not.toHaveProperty('reason');
    expect(p).not.toHaveProperty('foo');
  });

  it('缺省时补 default；null / 空串也算"没有值"→ 退回 default', () => {
    expect(coerceParams(PPT_SCHEMA, { topic: 'X' }).pages).toBe(16);
    // `pages: null` 的意思是"我没这个值"，不是"我要一个空页数"
    expect(coerceParams(PPT_SCHEMA, { topic: 'X', pages: null }).pages).toBe(16);
    // `topic` 没有 default，给空串就真的什么都不剩（由 required 校验兜住）
    expect(coerceParams(PPT_SCHEMA, { topic: '' })).not.toHaveProperty('topic');
  });

  it('参数不是对象（模型返回了数组/字符串）时退化为空参数 + default', () => {
    expect(coerceParams(PPT_SCHEMA, 'not-json')).toEqual({ purpose: 'contest', pages: 16 });
    expect(coerceParams(PPT_SCHEMA, undefined)).toEqual({ purpose: 'contest', pages: 16 });
  });

  it('布尔只认真正的布尔与 "true"/"false"（不把 "1"/"yes" 当确认）', () => {
    const schema = {
      type: 'object',
      properties: { copyrightAck: { type: 'boolean' } },
    };
    expect(coerceParams(schema, { copyrightAck: true })).toEqual({ copyrightAck: true });
    expect(coerceParams(schema, { copyrightAck: 'false' })).toEqual({ copyrightAck: false });
    // "yes" 不是布尔 → 丢弃（不能让一个用户没做的确认被悄悄打开）
    expect(coerceParams(schema, { copyrightAck: 'yes' })).toEqual({});
  });
});

describe('requiredFields', () => {
  it('取必填字段名（缺了就不能执行）', () => {
    expect(requiredFields(PPT_SCHEMA)).toEqual(['topic']);
    expect(requiredFields(undefined)).toEqual([]);
  });
});

describe('describeParams —— 结果卡上的"参数摘要"', () => {
  it('用中文字段名 + 中文枚举标签，用户才看得懂', () => {
    const d = describeParams(PPT_SCHEMA, { topic: '社团招新', purpose: 'course', pages: 20 });
    expect(d).toEqual([
      { label: '主题', value: '社团招新' },
      { label: '用途', value: '课程汇报' },
      { label: '页数', value: '20' },
    ]);
  });

  it('没传的字段不出现（展示一堆空值会让人以为出错）', () => {
    expect(describeParams(PPT_SCHEMA, { topic: 'X' })).toEqual([{ label: '主题', value: 'X' }]);
  });

  it('空数组不展示（"已选 0 个"没有信息量）', () => {
    const schema = { type: 'object', properties: { tags: { type: 'array', title: '标签' } } };
    expect(describeParams(schema, { tags: [] })).toEqual([]);
  });
});

describe('buildToolDescription', () => {
  it('包含场景与"不要用于"—— 只写好话会让模型过度调用', () => {
    const d = buildToolDescription({
      title: 'AI PPT 生成',
      scene: '用户要 PPT 时调用',
      notFor: ['只是问方法'],
      needsFile: false,
    });
    expect(d).toContain('用户要 PPT 时调用');
    expect(d).toContain('不要用于：只是问方法');
  });

  it('⭐ 需要文件的能力必须写明"没文件不要调用"，否则模型会凭空发起调用', () => {
    const d = buildToolDescription({
      title: 'AI 抠图',
      scene: '去背景',
      needsFile: 'image',
      guideHint: '先上传图片',
    });
    expect(d).toContain('必须由用户先提供图片文件');
    expect(d).toContain('不要调用');
    expect(d).toContain('先上传图片');
  });
});
