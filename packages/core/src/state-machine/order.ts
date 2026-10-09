import { OrderStatus } from '../enums';

import { IllegalTransitionError } from './index';

/**
 * 订单状态机（文档 6.6.3）
 *
 * 待支付 --支付--> 已支付(担保中) --服务者接单--> 服务中
 *    |                   |                          +--提交交付物--> 待验收
 *    |30min超时          |24h未接单可退              |                 |
 *    v                   v                          |        +--------+--------+
 * 已关闭              已退款                        |    通过v                  v要求修改
 *                                                   |   已完成 --> 待评价      服务中(回退)
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  [OrderStatus.PendingPayment]: [OrderStatus.Paid, OrderStatus.Closed],
  [OrderStatus.Paid]: [OrderStatus.InService, OrderStatus.Refunded, OrderStatus.Canceled],
  [OrderStatus.InService]: [OrderStatus.PendingAcceptance, OrderStatus.Canceled],
  [OrderStatus.PendingAcceptance]: [
    OrderStatus.Completed,
    OrderStatus.InService, // 要求修改，回退
    OrderStatus.RefundRequested,
  ],
  [OrderStatus.Completed]: [],
  [OrderStatus.RefundRequested]: [OrderStatus.Refunded, OrderStatus.InService],
  [OrderStatus.Refunded]: [],
  [OrderStatus.Closed]: [],
  [OrderStatus.Canceled]: [],
};

/** 终态（不可再迁移） */
export const ORDER_TERMINAL_STATUSES: readonly OrderStatus[] = [
  OrderStatus.Completed,
  OrderStatus.Refunded,
  OrderStatus.Closed,
  OrderStatus.Canceled,
];

/** 校验一次订单状态迁移是否合法；非法则抛 IllegalTransitionError */
export function transitionOrder(from: OrderStatus, to: OrderStatus): OrderStatus {
  const allowed = ORDER_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new IllegalTransitionError(from, to, 'order');
  }
  return to;
}

/** 是否可迁移（不抛错的版本，供 UI 判断按钮显隐） */
export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

/** 是否终态 */
export function isOrderTerminal(status: OrderStatus): boolean {
  return ORDER_TERMINAL_STATUSES.includes(status);
}
