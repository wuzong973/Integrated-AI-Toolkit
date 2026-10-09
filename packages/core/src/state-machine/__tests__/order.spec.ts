import { describe, expect, it } from 'vitest';

import { OrderStatus } from '../../enums';
import { ORDER_TRANSITIONS, canTransitionOrder, isOrderTerminal, transitionOrder } from '../order';

describe('订单状态机（文档 6.6.3 / 附录 E.3）', () => {
  it('全部合法迁移通过、全部非法迁移抛错（自迁移视为非法）', () => {
    const all = Object.values(OrderStatus);
    for (const from of all) {
      const allowed = ORDER_TRANSITIONS[from] ?? [];
      for (const to of all) {
        if (to !== from && allowed.includes(to)) {
          expect(() => transitionOrder(from, to)).not.toThrow();
          expect(transitionOrder(from, to)).toBe(to);
        } else {
          expect(() => transitionOrder(from, to)).toThrow(/非法状态迁移/);
        }
      }
    }
  });

  it('主链路：待支付 → 已支付 → 服务中 → 待验收 → 已完成', () => {
    let s = OrderStatus.PendingPayment;
    s = transitionOrder(s, OrderStatus.Paid);
    s = transitionOrder(s, OrderStatus.InService);
    s = transitionOrder(s, OrderStatus.PendingAcceptance);
    s = transitionOrder(s, OrderStatus.Completed);
    expect(s).toBe(OrderStatus.Completed);
    expect(isOrderTerminal(s)).toBe(true);
  });

  it('要求修改应回退到服务中，且可再次提交验收', () => {
    let s = transitionOrder(OrderStatus.PendingAcceptance, OrderStatus.InService);
    s = transitionOrder(s, OrderStatus.PendingAcceptance);
    expect(s).toBe(OrderStatus.PendingAcceptance);
  });

  it('已完成是终态，不允许再迁移', () => {
    expect(canTransitionOrder(OrderStatus.Completed, OrderStatus.Refunded)).toBe(false);
    expect(() => transitionOrder(OrderStatus.Completed, OrderStatus.Refunded)).toThrow();
  });

  it('30 分钟未支付可关闭', () => {
    expect(transitionOrder(OrderStatus.PendingPayment, OrderStatus.Closed)).toBe(
      OrderStatus.Closed,
    );
  });

  it('24h 未接单可从已支付退款', () => {
    expect(transitionOrder(OrderStatus.Paid, OrderStatus.Refunded)).toBe(OrderStatus.Refunded);
  });

  it('纠纷：待验收可申请退款，退款可被驳回回到服务中', () => {
    const s = transitionOrder(OrderStatus.PendingAcceptance, OrderStatus.RefundRequested);
    expect(transitionOrder(s, OrderStatus.InService)).toBe(OrderStatus.InService);
  });
});
