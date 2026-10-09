import { useCallback, useState } from 'react';
import type { ZodType } from 'zod';

/**
 * 表单状态 + 校验。
 *
 * ## 校验规则直接复用 `@qz/core` 的 zod schema
 *
 * 这些 schema 是后端 `ZodValidationPipe` 用的**同一份**（见
 * `packages/core/src/validators/admin.ts` 的注释里写明的理由）。
 * 前端再手写一套 `if (!username) …` 的结果是两边规则漂移：
 * 前端放行、后端 400（"这个字段明明填了却报错"），或反过来。
 *
 * ## 提交流程
 *
 * `submit()` 先本地校验 → 有错就**不发请求**（省一次必然失败的往返，
 * 也避免用户看到"服务端说格式不对"这种本可提前拦下的错误）；
 * 校验过了才调 `onSubmit`，期间 `submitting` 为 true（按钮自行禁用）。
 *
 * ⚠️ 校验通过 ≠ 提交成功：后端仍会再校验一次（它才是权威）。
 * `onSubmit` 抛出的错误由调用方 catch 并提示，本 Hook 不吞掉它。
 */
export interface FormState<T> {
  values: T;
  /** 字段名 → 第一条错误信息 */
  errors: FieldErrors<T>;
  submitting: boolean;
  setField: <K extends keyof T>(key: K, value: T[K]) => void;
  /** 整体替换（如"从详情回填表单"） */
  setValues: (next: T) => void;
  submit: () => Promise<void>;
  reset: (next?: T) => void;
}

/** 字段名 → 错误信息（key 收窄到 T 的键，拼错字段名会编译不过） */
export type FieldErrors<T> = Partial<Record<keyof T & string, string>>;

export function useForm<T extends Record<string, unknown>>(options: {
  initial: T;
  schema: ZodType<T>;
  onSubmit: (values: T) => Promise<void>;
}): FormState<T> {
  const { initial, schema, onSubmit } = options;
  const [values, setValues] = useState<T>(initial);
  const [errors, setErrors] = useState<FieldErrors<T>>({});
  const [submitting, setSubmitting] = useState(false);

  const setField = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    // 用户开始修正就撤掉该字段的旧报错，否则"改完了红字还在"
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }, []);

  const submit = useCallback(async () => {
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      setErrors(collectIssues(parsed.error.issues) as FieldErrors<T>);
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await onSubmit(parsed.data);
    } finally {
      setSubmitting(false);
    }
  }, [schema, values, onSubmit]);

  const reset = useCallback(
    (next?: T) => {
      setValues(next ?? initial);
      setErrors({});
    },
    [initial],
  );

  return { values, errors, submitting, setField, setValues, submit, reset };
}

/**
 * zod issues → `{ 字段名: 第一条错误 }`（每字段只显示一条，避免一屏红字）。
 *
 * 返回 `Record<string, string>` 而不是 `FieldErrors<T>`：zod 的 issue.path 是
 * 运行期数据，类型上无法证明它一定是 T 的键。收窄由调用点的一次断言完成
 * （见 `submit()`），这样"字段名写错"仍会在 `values`/`setField` 处被拦住。
 */
function collectIssues(
  issues: { path: (string | number)[]; message: string }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? '_');
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
