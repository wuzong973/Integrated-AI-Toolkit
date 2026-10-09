/**
 * 驿站领域（任务清单 M3）。
 *
 * 目前只放**纯计算**：匹配分算法（M3-09）。
 * 涉及数据库、状态迁移、外部调用的部分留在 `apps/api/src/modules/station/` ——
 * core 不依赖 Prisma（红线 9）。
 */
export * from './match';
