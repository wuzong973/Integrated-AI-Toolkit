import { z } from 'zod';
import { ServiceListQuerySchema } from '@qz/core';

/**
 * 服务市场列表的查询（`GET /services`）= core 的公共查询 **+ 一个 `providerId`**。
 *
 * ## 为什么写成 `extend` 而不是回 core 里加字段
 *
 * 工程纪律是"校验规则前后端共用 `@qz/core/validators`"。这次 `providerId` 的唯一
 * 需求方是**服务者主页**（M3-05，`GET /services?providerId=xxx`），
 * 而本期改动范围被明确限定在 `modules/service/**`（`packages/core` 与其他页面
 * 由并行任务持有），所以先把这一条筛选条件放在模块内 ——
 * 与 `modules/billing/dto/withdrawal.dto.ts` 同一套取舍：**下一期接线时整体上移到
 * `@qz/core` 再从这里 re-export**，绝不允许 mp 侧再抄一份校验。
 *
 * 用 `extend` 而不是重写一份，是为了让 `page` / `pageSize` 的口径
 * （`pageSize` 上限 50、越界即 40001）继续只有一份真相。
 *
 * ## 这个参数**不**是"给客户端传 status 的口子"
 *
 * `service.service.ts` 规则 ①：市场列表只出 `status='on'`，且不接受客户端指定状态。
 * `providerId` 只是把范围缩到"某个人挂出来的服务"，
 * 它拼在 `status='on'` **之后**（见 `ServiceService.listServices`），
 * 所以拿它既看不到别人的下架商品，也看不到自己的（自己的走 `GET /services/mine`）。
 *
 * ⚠️ `GET /services/mine` 仍用 core 的 `ServiceListQuerySchema`（不含本字段）：
 * 「我的」列表的服务者身份只能来自 token。若把本 schema 用在那条路由上，
 * 查询串里的 `providerId` 就有机会变成"看别人的下架商品"的通道。
 */
export const ServiceMarketQuerySchema = ServiceListQuerySchema.extend({
  /** 服务者用户 id（`user.id`）。上限 40 与 `categoryId` 一致 */
  providerId: z.string().max(40).optional(),
});
export type ServiceMarketQueryDto = z.infer<typeof ServiceMarketQuerySchema>;
