import { describe, expect, it } from 'vitest';

import type { MineMenuGroup } from '../../apps/mp/utils/mine-menu';
import { MENU_GROUPS, showsAdminEntry } from '../../apps/mp/utils/mine-menu';

/**
 * 「我的」页入口的可见性规则
 *
 * ## 为什么这段逻辑值得单独测
 *
 * 它是**权限相关**的：管理员入口一旦露给普通学生，用户点进去看到 403 或空白 ——
 * 真机上**不报任何错**，只能靠人发现。而"少显示一个入口"同样无声：
 * 管理员自己找不到后台入口，也不会有人告诉他。
 *
 * ⚠️ 隐藏入口**不是**权限控制（真正的拦截在后端 `AdminPermissionGuard`）。
 * 这里测的是"别让普通用户看到一个必然失败的位置"，以及"别把该看到的人挡住"。
 *
 * ## 2026-10-08 之后菜单里为什么不再有「管理后台」
 *
 * 后台入口挪到了页面底部的固定栏（`showsAdminEntry` + `pages/mine/index.wxml` 的
 * `.qz-footer-bar`），并且有了小程序内的原生后台页，不再是"只能跳网页"的特殊项。
 * 因此 `MineMenuItem.url` 改成必填 —— 原来那条"非 adminOnly 必须有 url"的不变量
 * 现在由类型系统保证，这里再留一条运行时断言兜住数据被改回去的情况。
 */
const flat = (groups: MineMenuGroup[]) => groups.flat();
const ITEMS = flat(MENU_GROUPS);

describe('showsAdminEntry：后台入口的可见性', () => {
  it('只有后端明确回了 isAdmin === true 才亮出入口', () => {
    expect(showsAdminEntry({ isAdmin: true })).toBe(true);
  });

  it('普通用户看不到', () => {
    expect(showsAdminEntry({ isAdmin: false })).toBe(false);
  });

  it('资料还没到（null / undefined / 缺字段）一律按非管理员处理 —— fail-closed', () => {
    // 宁可管理员晚一帧看到入口，也不要在身份未定时先把入口亮出来
    expect(showsAdminEntry(null)).toBe(false);
    expect(showsAdminEntry(undefined)).toBe(false);
    expect(showsAdminEntry({})).toBe(false);
  });

  it('客户端自己算的"看起来像管理员"不算数（只认后端那一个字段）', () => {
    expect(showsAdminEntry({ role: 'admin' } as unknown as { isAdmin?: boolean })).toBe(false);
    expect(showsAdminEntry({ isAdmin: 'true' } as unknown as { isAdmin?: boolean })).toBe(false);
  });
});

describe('我的页二级菜单', () => {
  it('⭐ 菜单里不再出现 admin —— 后台入口已挪到底部固定栏', () => {
    // 谁把它加回菜单，这条会红；正确做法是改 `showsAdminEntry` 的调用点
    expect(ITEMS.map((i) => i.key)).not.toContain('admin');
  });

  it('每个入口都有 url（没有 url 的入口点了就是"没反应"）', () => {
    const bad = ITEMS.filter((i) => !i.url || !i.url.startsWith('/'));
    expect(bad.map((i) => i.key)).toEqual([]);
  });

  it('所有 key 唯一（wx:key 重复会导致列表渲染错乱）', () => {
    const keys = ITEMS.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('每个入口都有 icon / label / desc（缺 desc 用户不知道点进去干嘛）', () => {
    for (const item of ITEMS) {
      expect(item.icon).toMatch(/^qz-i-/);
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.desc.length).toBeGreaterThan(0);
    }
  });

  it('菜单分组非空且每组至少一项（空组会渲染出一张没有内容的卡）', () => {
    expect(MENU_GROUPS.length).toBeGreaterThan(0);
    for (const g of MENU_GROUPS) expect(g.length).toBeGreaterThan(0);
  });
});
