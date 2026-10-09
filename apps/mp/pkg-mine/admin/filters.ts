/**
 * 后台列表页的状态取值与文案（用户 / 认证审核 / 订单）。
 *
 * ## 为什么单独成文件而不是写在各页里
 *
 * 这些字符串**必须**与后端的枚举同集合，而写错的方式极其隐蔽：
 * `AdminOrderListQuerySchema.status` 是 `z.string()`，传一个 `OrderStatus` 里
 * 没有的值**不会报错**，只会返回空列表 —— 于是界面显示「没有服务中的订单」，
 * 而真相是筛选条件打错了一个字。那种假结论比红屏难发现得多。
 *
 * 所以要有一份能被子测试导入的单一来源：
 * `tests/mp/admin-list.spec.ts` 拿这里的数组与 `packages/core` 的枚举对账。
 * （页面文件本身导不进测试 —— 它们在模块作用域就调用了 `Page({})`。）
 *
 * ## 认不出的值怎么办
 *
 * 一律**原样显示 + 灰色底**，不折叠成"正常/其他"。后台里一个被吞掉的状态，
 * 等于运营看不到这条记录的真实情况。
 */

/** `packages/core` → `ADMIN_USER_STATUSES` */
export const USER_STATUS_VALUES = ['', 'active', 'banned', 'disabled'] as const;
export const USER_STATUS_LABELS: Record<string, string> = {
  '': '全部',
  active: '正常',
  banned: '已封禁',
  disabled: '已停用',
};
export const USER_STATUS_CLS: Record<string, string> = {
  active: 'st-ok',
  banned: 'st-bad',
  disabled: 'st-mute',
};

/** `packages/core` → `VerificationStatus` */
export const VERIFICATION_STATUS_VALUES = ['pending', 'approved', 'rejected'] as const;
export const VERIFICATION_STATUS_LABELS: Record<string, string> = {
  pending: '待审',
  approved: '已通过',
  rejected: '已驳回',
};
export const VERIFICATION_STATUS_CLS: Record<string, string> = {
  pending: 'st-warn',
  approved: 'st-ok',
  rejected: 'st-bad',
};

/** `packages/core` → `OrderStatus`（顺序按运营实际关心的程度排，不是枚举声明序） */
export const ORDER_STATUS_VALUES = [
  '',
  'pending_payment',
  'paid',
  'in_service',
  'pending_acceptance',
  'completed',
  'refund_requested',
  'refunded',
  'closed',
  'canceled',
] as const;
export const ORDER_STATUS_LABELS: Record<string, string> = {
  '': '全部',
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
export const ORDER_STATUS_CLS: Record<string, string> = {
  completed: 'st-ok',
  in_service: 'st-ok',
  pending_acceptance: 'st-warn',
  pending_payment: 'st-warn',
  refund_requested: 'st-bad',
  refunded: 'st-bad',
  closed: 'st-mute',
  canceled: 'st-mute',
};

/**
 * 角色取值（`packages/core` → `Role`）。
 * 用户列表与后台身份带都要用，所以也放在这里一起对账。
 */
export const ROLE_LABELS: Record<string, string> = {
  guest: '游客',
  student: '学生',
  provider: '服务者',
  organization: '组织方',
  merchant: '商户',
  admin: '管理员',
};
