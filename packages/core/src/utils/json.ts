/**
 * Json 列取值工具（MySQL 迁移配套，见 docs/architecture/DB-MIGRATION-POSTGRES-TO-MYSQL.md）
 *
 * 背景：PostgreSQL 的 `String[]` 标量数组在 MySQL 中不存在，schema 里统一落成
 *       Json 数组。Prisma 读出来是 `JsonValue`，不能直接当 `string[]` 用，必须显式收窄。
 *
 * 纪律：凡从 Json 列读数组/对象的地方一律走这里，禁止写 `as string[]` 之类的强转
 *       —— 强转在数据异常（null、被写成对象）时会把脏值带进业务逻辑，
 *          而这里会安全降级为空数组，问题只体现在数据缺失而非运行时报错。
 */

/** 把 JsonValue 收窄为 string[]（非数组返回 []；非字符串项直接丢弃） */
export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** 把 JsonValue 收窄为 unknown[]（仅保证是数组，元素原样保留） */
export function asJsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 把 JsonValue 收窄为普通对象（null / 数组 / 基本类型一律返回 null） */
export function asJsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
