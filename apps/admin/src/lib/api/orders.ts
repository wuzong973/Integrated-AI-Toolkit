import { http } from '../http';
import type {
  AdminOrderDetail,
  AdminOrderItem,
  AdminOrderListQuery,
  AdminOrderResolveBody,
  ListResult,
} from '../types';

import { flattenParams } from './params';

/**
 * 订单与纠纷裁决。
 *
 * ## 只有两个动作，且是**真正动钱**的
 *
 * `release`（放款给服务者）/ `refund`（退款给买家）都走
 * `OrderPayService.accept` / `refund` —— 后端唯一一份资金实现。
 * 界面上必须二次确认 + 强制填理由（后端也强制，`reason` 至少 4 字）。
 *
 * ## 时间线上的操作人不是管理员
 *
 * 后端以**买家身份**触发这两个方法（它们校验 `order.buyerId === userId`），
 * 所以订单时间线的 `operatorId` 记的是买家。管理员的真实身份与理由记在
 * `audit_log`（`order.release` / `order.refund`）。
 * 详情页因此要显式提示"裁决人请以操作日志为准"，否则复盘时会找错人。
 */
export const ordersApi = {
  list: (query: AdminOrderListQuery) =>
    http.get<ListResult<AdminOrderItem>>('/admin/orders', flattenParams(query)),
  detail: (id: string) => http.get<AdminOrderDetail>(`/admin/orders/${id}`),
  resolve: (id: string, body: AdminOrderResolveBody) =>
    http.post<AdminOrderDetail>(`/admin/orders/${id}/resolve`, body),
};
