/**
 * 订单状态展示文案（列表页与详情页**共用**）。
 *
 * ## 为什么要抽出来
 *
 * 订单状态文案原先只写在 `pkg-station/order-detail/index.ts` 里。
 * 列表页接入接口后也需要同一套映射 —— 两处各写一份的话，
 * 以后加一个状态（比如"仲裁中"）必然只改一边，出现
 * "列表显示 `refund_requested`、详情显示 退款中"这种低级不一致。
 *
 * ⚠️ 这里只做**展示映射**，不做状态判断逻辑 ——
 * 状态能否迁移由 `@qz/core` 的 `order.ts` 状态机唯一裁定（红线）。
 */

/** 状态 → 中文文案 */
export const ORDER_STATUS_TEXT: Record<string, string> = {
  pending_payment: '待支付',
  paid: '担保中',
  in_service: '服务中',
  pending_acceptance: '待验收',
  completed: '已完成',
  refund_requested: '退款中',
  refunded: '已退款',
  closed: '已关闭',
  canceled: '已取消',
};

/** 未知状态原样返回，便于一眼看出后端加了新状态而前端还没跟进 */
export function orderStatusText(status: string): string {
  return ORDER_STATUS_TEXT[status] ?? status;
}

/** 订单进度条步骤（详情页用） */
export const ORDER_STEPS = ['待支付', '担保中', '服务中', '待验收', '已完成'];
