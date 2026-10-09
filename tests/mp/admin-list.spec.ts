import { describe, expect, it } from 'vitest';

import {
  ADMIN_USER_STATUSES,
  OrderStatus,
  Role,
  VerificationStatus,
} from '../../packages/core/src';
import {
  ORDER_STATUS_LABELS,
  ORDER_STATUS_VALUES,
  ROLE_LABELS,
  USER_STATUS_LABELS,
  USER_STATUS_VALUES,
  VERIFICATION_STATUS_LABELS,
  VERIFICATION_STATUS_VALUES,
} from '../../apps/mp/pkg-mine/admin/filters';

/**
 * 后台列表页状态取值与后端枚举的漂移守卫。
 *
 * ## 为什么这条必须存在
 *
 * 后端 `AdminOrderListQuerySchema.status` 是 `z.string()`（不是 enum），
 * 传一个 `OrderStatus` 里不存在的值**不会报错**，只会返回空列表。
 * 于是筛选条上打错一个字，界面就显示「没有服务中的订单」，
 * 而真相是"这个条件后端从来不理"。空列表和"确实没有"在界面上长得一模一样 ——
 * 这正是本项目红线要拦的那类"不报错的错"。
 *
 * 页面文件在模块作用域就调用了 `Page({})`，测试导不进来，
 * 所以取值集中在 `apps/mp/pkg-mine/admin/filters.ts`，这里只跟它对账。
 */

/** '' 是"全部"这个 chip 的哨兵值，不参与枚举对账 */
const withoutAll = (values: readonly string[]) => values.filter((v) => v !== '');

describe('订单状态取值必须与 OrderStatus 同集合', () => {
  it('小程序侧的每一个非空状态都是后端枚举里的真实值', () => {
    const real = new Set<string>(Object.values(OrderStatus));
    const bogus = withoutAll(ORDER_STATUS_VALUES).filter((v) => !real.has(v));
    expect(bogus).toEqual([]);
  });

  it('后端新增的订单状态不会在筛选条上静默消失', () => {
    const shown = new Set(withoutAll(ORDER_STATUS_VALUES));
    const missing = Object.values(OrderStatus).filter((v) => !shown.has(v));
    expect(missing).toEqual([]);
  });

  it('每个状态都有中文文案（没有文案的 chip 会直接显示枚举原值，读起来像报错）', () => {
    for (const v of ORDER_STATUS_VALUES) {
      expect(ORDER_STATUS_LABELS[v] ?? '').not.toBe('');
    }
  });
});

describe('认证审核状态取值必须与 VerificationStatus 同集合', () => {
  it('双向一致（后端 `AdminVerificationListQuerySchema` 用的是 z.enum，传错值会直接 400）', () => {
    expect([...withoutAll(VERIFICATION_STATUS_VALUES)].sort()).toEqual(
      [...Object.values(VerificationStatus)].sort(),
    );
  });

  it('每个状态都有中文文案', () => {
    for (const v of VERIFICATION_STATUS_VALUES) {
      expect(VERIFICATION_STATUS_LABELS[v] ?? '').not.toBe('');
    }
  });
});

describe('用户状态取值必须与 ADMIN_USER_STATUSES 同集合', () => {
  it('双向一致（后端是 z.enum，多一个少一个都会 400 或筛不出东西）', () => {
    expect([...withoutAll(USER_STATUS_VALUES)].sort()).toEqual([...ADMIN_USER_STATUSES].sort());
  });

  it('每个状态都有中文文案', () => {
    for (const v of USER_STATUS_VALUES) {
      expect(USER_STATUS_LABELS[v] ?? '').not.toBe('');
    }
  });
});

describe('角色文案覆盖 Role 全集', () => {
  it('每个角色都有中文名（后台列表里角色是以胶囊展示的，缺文案会露出英文枚举）', () => {
    for (const r of Object.values(Role)) {
      expect(ROLE_LABELS[r] ?? '').not.toBe('');
    }
  });
});
