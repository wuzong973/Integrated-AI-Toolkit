import { describe, expect, it } from 'vitest';

import { readStatusBarHeight } from '../../apps/mp/utils/system';

/**
 * 状态栏高度解析的兜底分支
 *
 * ## 范围
 *
 * 只测**纯函数** `readStatusBarHeight`。同文件的 `statusBarHeight()` 会调
 * `getApp()` / `wx.getWindowInfo()`，在 Node 下不存在，属于端侧薄壳，留在开发者工具里验。
 *
 * ## 为什么这个值值得单独测
 *
 * 它直接决定"首页标题会不会被状态栏压住"。一旦异常输入下返回 0，
 * 页面就退回 2026-09-20 那个 bug 状态 —— 而真机上的表现只是"看起来没生效"，
 * **不报任何错**，正是最难回溯的一类问题。
 *
 * 默认兜底值 24px 与 `system.ts` 的 `FALLBACK_STATUS_BAR` 同源；
 * 这里按字面量断言，是因为它同时是一条产品约定：**宁可有间距，也不许贴顶**。
 */
describe('状态栏高度解析', () => {
  it('正常返回系统给的值', () => {
    expect(readStatusBarHeight({ statusBarHeight: 44 })).toBe(44);
  });

  it('刘海屏/挖孔屏的高状态栏值原样返回，不被夹断', () => {
    expect(readStatusBarHeight({ statusBarHeight: 48 })).toBe(48);
    expect(readStatusBarHeight({ statusBarHeight: 59 })).toBe(59);
  });

  it('字段缺失时走兜底（旧接口没有这个字段）', () => {
    expect(readStatusBarHeight({})).toBe(24);
    expect(readStatusBarHeight({ model: 'iPhone' })).toBe(24);
  });

  it('类型不对时走兜底，不把字符串硬转成数字', () => {
    expect(readStatusBarHeight({ statusBarHeight: '44' })).toBe(24);
    expect(readStatusBarHeight({ statusBarHeight: NaN })).toBe(24);
    expect(readStatusBarHeight({ statusBarHeight: Infinity })).toBe(24);
  });

  it('0 与负数不算有效值 —— 那正是 env() 失效时的症状', () => {
    expect(readStatusBarHeight({ statusBarHeight: 0 })).toBe(24);
    expect(readStatusBarHeight({ statusBarHeight: -1 })).toBe(24);
  });

  it('整体取不到时走兜底，且兜底值可覆盖', () => {
    expect(readStatusBarHeight(null)).toBe(24);
    expect(readStatusBarHeight(undefined)).toBe(24);
    expect(readStatusBarHeight('44')).toBe(24);
    expect(readStatusBarHeight(null, 0)).toBe(0);
  });
});
