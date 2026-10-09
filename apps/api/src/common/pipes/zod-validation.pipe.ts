import { type PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';
import { BizException, ErrorCode } from '@qz/core';

/**
 * Zod 校验管道（任务清单 M0-05）
 * 统一用 @qz/core 的共享 schema，保证前后端校验规则完全一致。
 */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const detail: Record<string, string> = {};
      for (const issue of result.error.issues) {
        detail[issue.path.join('.') || '_'] = issue.message;
      }
      throw new BizException(
        ErrorCode.ParamInvalid,
        detail,
        Object.values(detail)[0] ?? '参数校验失败',
      );
    }
    return result.data;
  }
}
