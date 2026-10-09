/**
 * JSON 校验 / 格式化（纯函数，不依赖 wx API）
 *
 * ## 错误要落到行号
 *
 * `JSON.parse` 的报错是"Position 42"这种**字符偏移**，用户对偏移量毫无感觉，
 * 只有"第 3 行第 15 列"才能直接定位。各家引擎（iOS JavaScriptCore / 安卓 V8）
 * 的报错文案不同，但都带 `position N` —— 抠不到时退化为只显示原文案，不猜。
 */

export interface JsonError {
  /** 引擎原文案（抠不到位置时它是唯一线索） */
  message: string;
  /** 1 起；0 表示未知 */
  line: number;
  /** 1 起；0 表示未知 */
  column: number;
}

export type JsonResult = { ok: true; value: unknown } | { ok: false; error: JsonError };

/** 从字符偏移反推行号列号（都从 1 起；pos 越界时钳到最后） */
export function lineColAt(text: string, pos: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(pos, text.length));
  const before = text.slice(0, clamped);
  const line = (before.match(/\n/g) ?? []).length + 1;
  const lastNl = before.lastIndexOf('\n');
  return { line, column: clamped - lastNl };
}

/** 从引擎报错里抠 `position N`（N 可能是负数式描述，取整数即可） */
function parseErrorPosition(message: string): number {
  const m = /position\s+(-?\d+)/i.exec(message);
  return m ? Number(m[1]) : -1;
}

function errorOf(text: string, e: unknown): JsonError {
  const message = e instanceof Error ? e.message : String(e);
  const pos = parseErrorPosition(message);
  if (pos < 0) return { message, line: 0, column: 0 };
  const { line, column } = lineColAt(text, pos);
  return { message, line, column };
}

/** 只校验不产出格式化文本（输入即时校验用，别把半截输入 stringify 出去） */
export function validateJson(text: string): JsonResult {
  if (!text.trim()) {
    return { ok: false, error: { message: '空内容', line: 0, column: 0 } };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: errorOf(text, e) };
  }
}

/**
 * 校验 + 产出格式化文本（`indent` 传 2 是格式化、传 0 是压缩）。
 * 压缩走 `JSON.stringify(value)`（无空格），与"格式化"共用同一条解析路径，
 * 保证"校验说合法、格式化却报错"这种两套实现才会出现的漂移不存在。
 */
export function formatJson(text: string, indent: number): JsonResult {
  const parsed = validateJson(text);
  if (!parsed.ok) return parsed;
  const out = indent > 0 ? JSON.stringify(parsed.value, null, indent) : JSON.stringify(parsed.value);
  return { ok: true, value: out };
}

/** 展示用的一句话错误（有行号带行号，没有就只给原文案） */
export function jsonErrorText(e: JsonError): string {
  if (e.line > 0) return `第 ${e.line} 行第 ${e.column} 列附近：${e.message}`;
  return e.message;
}
