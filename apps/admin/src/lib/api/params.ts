/**
 * 查询对象 → SDK 需要的 `Record<string, unknown>`。
 *
 * ## 为什么不给查询 DTO 加索引签名
 *
 * 加了 `[key: string]: unknown` 之后，`usersApi.list({ keywrod: 'x' })`
 * 也能编译通过 —— 而后端 zod 默认**丢弃未知字段**，于是筛选条件被静默忽略，
 * 界面表现为"搜了但结果没变"。这类问题没有任何报错，只能靠人发现。
 *
 * 所以查询 DTO 保持严格（无索引签名），转换收敛到这一个函数；
 * 调用点写对象字面量时，拼错键名仍会被 TS 的"多余属性检查"拦住
 * （见 `apps/admin/src/pages/**` 的调用方式）。
 *
 * `T extends object` 而非 `Record<string, unknown>`：接口类型没有隐式索引签名，
 * 用后者会导致所有 DTO 都传不进来（这正是当初编译失败的原因）。
 */
export function flattenParams<T extends object>(source: T): Record<string, unknown> {
  return { ...source } as Record<string, unknown>;
}
