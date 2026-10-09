/**
 * 信用域入口（任务清单 M3-16；文档 6.6.4）
 *
 * 只放**纯规则与契约**：信用分的写入在 `apps/api/src/modules/order/`
 * （评价产生时同一个事务里记分），读取在 `modules/user`（`GET /user/credit`）。
 */
export * from './credit-rules';
export * from './accept-review';
