import { BizException, ErrorCode, LoginSchema } from '@qz/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ZodValidationPipe } from './zod-validation.pipe';

const Schema = z.object({ name: z.string().min(2, '名称至少 2 个字符') });

describe('ZodValidationPipe（前后端共用同一份 schema）', () => {
  it('校验通过时返回 zod 处理后的数据', () => {
    expect(new ZodValidationPipe(Schema).transform({ name: 'qingzhi' })).toEqual({
      name: 'qingzhi',
    });
  });

  it('校验失败抛 BizException，code 为参数非法', () => {
    const pipe = new ZodValidationPipe(Schema);
    expect(() => pipe.transform({ name: 'q' })).toThrow(BizException);
    try {
      pipe.transform({ name: 'q' });
    } catch (e) {
      expect((e as BizException).code).toBe(ErrorCode.ParamInvalid);
      expect((e as BizException).userMessage).toContain('名称至少 2 个字符');
    }
  });

  it('多字段出错时 detail 按字段名归集，顶层文案取第一条', () => {
    const Multi = z.object({ a: z.string(), b: z.number() });
    try {
      new ZodValidationPipe(Multi).transform({});
      expect.unreachable('应当抛错');
    } catch (e) {
      const detail = (e as BizException).detail as Record<string, string>;
      expect(Object.keys(detail).sort()).toEqual(['a', 'b']);
    }
  });

  it('复用 @qz/core 的登录 schema：小程序端只传 code 即可通过', () => {
    expect(new ZodValidationPipe(LoginSchema).transform({ code: '0a1B' })).toEqual({
      code: '0a1B',
    });
  });
});
