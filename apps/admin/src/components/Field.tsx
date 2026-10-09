import type { ReactNode } from 'react';

/** 表单字段外壳：标签 + 必填标记 + 说明 + 错误 */
export function Field({
  label,
  required = false,
  hint,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="qz-field">
      <label className="qz-field__label">
        {label}
        {required ? <span className="qz-field__required">*</span> : null}
      </label>
      {children}
      {error ? <div className="qz-field__error">{error}</div> : null}
      {!error && hint ? <div className="qz-field__hint">{hint}</div> : null}
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled = false,
  invalid = false,
  autoFocus = false,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  type?: 'text' | 'password';
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <input
      className={invalid ? 'qz-input is-invalid' : 'qz-input'}
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * 下拉选择。
 *
 * 泛型 `V extends string` 而不是直接收 `string`：表单字段常常是**字面量联合**
 * （如 `'active' | 'banned' | 'disabled'`，来自 `@qz/core` 的 zod schema）。
 * 若这里收宽成 `string`，`setField('status', v)` 就会因为 `string` 不能赋给
 * 那个联合而编译失败 —— 于是每个调用点都要写一次 `as` 断言，把类型安全丢掉。
 * 泛型让 `V` 从 `value` 与 `options` 一起推断，调用点无需断言。
 */
export function SelectInput<V extends string>({
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  invalid = false,
}: {
  value: V;
  onChange: (next: V) => void;
  options: readonly { value: V; label: string }[];
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <select
      className={invalid ? 'qz-select is-invalid' : 'qz-select'}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as V)}
    >
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 4,
  disabled = false,
  invalid = false,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <textarea
      className={invalid ? 'qz-textarea is-invalid' : 'qz-textarea'}
      value={value}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** 多选（用户角色编辑、权限勾选） */
export function CheckboxList({
  values,
  onChange,
  options,
  disabled = false,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  options: { value: string; label: string; hint?: string }[];
  disabled?: boolean;
}) {
  const toggle = (value: string) => {
    onChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
  };
  return (
    <div className="qz-col" style={{ gap: 'var(--sp-2)' }}>
      {options.map((opt) => (
        <label key={opt.value} className="qz-checkbox">
          <input
            type="checkbox"
            checked={values.includes(opt.value)}
            disabled={disabled}
            onChange={() => toggle(opt.value)}
          />
          <span>
            {opt.label}
            {opt.hint ? <span className="qz-dim"> · {opt.hint}</span> : null}
          </span>
        </label>
      ))}
    </div>
  );
}
