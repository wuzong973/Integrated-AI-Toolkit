import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 计费文案（小程序侧）
 *
 * 验证的是**用户实际看到的那句话**：
 *   · 免费开放期价格位置必须显示"免费"，而不是"N 积分"；
 *   · 免费期**任何**面向用户的文案都不得出现"积分"二字。
 * 这类文案改错了不会报错、只会让人困惑，所以用测试钉住。
 *
 * 手法说明：`apps/mp/utils/billing.ts` 会先从 `wx.getStorageSync` 恢复上次的模式，
 * 因此这里 stub 存储 + `wx.request` 即可，不必真的拉起小程序。
 */
type Storage = Record<string, unknown>;

let storage: Storage;
/** 接口调用次数（用于验证缓存是否真的省掉了请求） */
let requestCount = 0;
/** 接口返回的模式；`null` = 让请求失败（模拟断网 / 后端无此接口） */
let remoteMode: 'free' | 'points' | null = null;

function stubWx(): void {
  (globalThis as unknown as { wx: unknown }).wx = {
    getStorageSync: (key: string) => storage[key] ?? '',
    setStorageSync: (key: string, value: unknown) => {
      storage[key] = value;
    },
    request: (opts: { success?: (r: unknown) => void; fail?: (e: unknown) => void }) => {
      requestCount += 1;
      if (!remoteMode) {
        opts.fail?.(new Error('network down'));
        return;
      }
      opts.success?.({
        statusCode: 200,
        header: {},
        data: {
          code: 0,
          message: 'ok',
          data: {
            version: '0.1.0',
            billing: {
              enabled: remoteMode === 'points',
              mode: remoteMode,
              notice: remoteMode === 'free' ? '限时免费开放中' : '',
            },
          },
        },
      });
    },
  };

  /**
   * 请求层在响应里会调 `getApp()?.setDemoMode()` 同步"演示模式"角标。
   * 测试环境没有这个全局函数，不补桩的话**响应回调会抛错**，
   * 表现为"接口调了但结果没生效" —— 排查时极具误导性。
   */
  (globalThis as unknown as { getApp: unknown }).getApp = () => ({ setDemoMode: () => {} });
}

/** 每个用例都重置模块状态（billing.ts 有模块级缓存），并按需预置存储与接口返回值 */
async function loadBilling(seed: Storage = {}, remote: 'free' | 'points' | null = null) {
  storage = { ...seed };
  requestCount = 0;
  remoteMode = remote;
  stubWx();
  vi.resetModules();
  return import('../../apps/mp/utils/billing');
}

/** 一小时前的时间戳（必然超过缓存 TTL） */
const STALE_AT = Date.now() - 60 * 60 * 1000;

beforeEach(() => {
  storage = {};
  requestCount = 0;
  remoteMode = null;
  stubWx();
});

afterEach(() => {
  vi.resetModules();
});

describe('价格文案', () => {
  it('⭐ 免费开放期：价格位置显示"免费"，不显示"N 积分"', async () => {
    const billing = await loadBilling({ qz_billing_mode: 'free' });

    expect(billing.isBillingFree()).toBe(true);
    expect(billing.priceText(5)).toBe('免费');
    expect(billing.priceText(1)).toBe('免费');
    expect(billing.priceText(0)).toBe('免费');
  });

  it('计费期：显示"N 积分"；工具本身免费时仍显示"免费"', async () => {
    const billing = await loadBilling({ qz_billing_mode: 'points' });

    expect(billing.isBillingFree()).toBe(false);
    expect(billing.priceText(5)).toBe('5 积分');
    expect(billing.priceText(2)).toBe('2 积分');
    expect(billing.priceText(0)).toBe('免费');
  });

  it('⭐ 结果页费用：免费期说"本次免费"，不能说"消耗 N 积分"', async () => {
    const free = await loadBilling({ qz_billing_mode: 'free' });
    expect(free.costText(5)).toBe('本次免费');

    const paid = await loadBilling({ qz_billing_mode: 'points' });
    expect(paid.costText(5)).toBe('消耗 5 积分');
    expect(paid.costText(0)).toBe('免费');
  });

  it('⭐ 失败文案：免费期不能说"积分已退回"（压根没扣）', async () => {
    const free = await loadBilling({ qz_billing_mode: 'free' });
    expect(free.failureHint()).toBe('本次免费，可以重新生成');

    const paid = await loadBilling({ qz_billing_mode: 'points' });
    expect(paid.failureHint()).toBe('积分已退回，可以重新生成');
  });

  it('⭐ 免费期所有面向用户的文案都不含"积分"二字', async () => {
    const billing = await loadBilling({ qz_billing_mode: 'free' });

    const texts = [
      billing.priceText(5),
      billing.costText(5),
      billing.failureHint(),
      billing.freeNotice(),
      billing.creditHeadSub(),
    ];
    for (const t of texts) {
      expect(t).not.toContain('积分');
    }
  });

  it('免费期说明文案来自服务端下发（各端一致）', async () => {
    const billing = await loadBilling({
      qz_billing_mode: 'free',
      qz_billing_notice: '限时免费开放中',
    });
    expect(billing.freeNotice()).toBe('限时免费开放中');
  });
});

describe('积分账户 UI 的显隐', () => {
  it('免费期不展示积分账户（余额/流水/如何获得一律隐藏）', async () => {
    const free = await loadBilling({ qz_billing_mode: 'free' });
    expect(free.showPoints()).toBe(false);
  });

  it('计费期恢复展示积分账户', async () => {
    const paid = await loadBilling({ qz_billing_mode: 'points' });
    expect(paid.showPoints()).toBe(true);
  });
});

describe('模式缓存的刷新（曾导致"后端已免费、界面却一直显示价格"）', () => {
  it('⭐ 缓存过期后会重新拉取，陈旧值不会永久生效', async () => {
    const billing = await loadBilling(
      { qz_billing_mode: 'points', qz_billing_mode_at: STALE_AT },
      'free',
    );

    expect(await billing.loadBillingMode()).toBe('free');
    expect(billing.priceText(5)).toBe('免费');
    expect(requestCount).toBe(1);
  });

  it('⭐ 旧版本存储没有时间戳时同样会刷新（用户不必手动清缓存）', async () => {
    const billing = await loadBilling({ qz_billing_mode: 'points' }, 'free');

    expect(await billing.loadBillingMode()).toBe('free');
    expect(billing.priceText(5)).toBe('免费');
  });

  it('缓存新鲜时不重复请求（避免每个页面都打一次接口）', async () => {
    const billing = await loadBilling(
      { qz_billing_mode: 'free', qz_billing_mode_at: Date.now() },
      'free',
    );

    await billing.loadBillingMode();
    await billing.loadBillingMode();
    expect(requestCount).toBe(0);
  });

  it('force=true 时忽略新鲜缓存强制拉取（冷启动用）', async () => {
    const billing = await loadBilling(
      { qz_billing_mode: 'points', qz_billing_mode_at: Date.now() },
      'free',
    );

    expect(await billing.loadBillingMode(true)).toBe('free');
    expect(requestCount).toBe(1);
  });

  it('刷新失败时保留旧值，不把价格闪回来', async () => {
    const billing = await loadBilling(
      { qz_billing_mode: 'free', qz_billing_mode_at: STALE_AT },
      null,
    );

    expect(await billing.loadBillingMode()).toBe('free');
    expect(billing.priceText(5)).toBe('免费');
  });
});

describe('fail-safe 默认值', () => {
  it('从未成功拉取过时按"计费"处理（宁可显得贵，不能显得骗人）', async () => {
    const billing = await loadBilling();

    expect(billing.currentBillingMode()).toBe('points');
    expect(billing.priceText(5)).toBe('5 积分');
  });

  it('存储里是脏值时同样按 fail-safe 处理', async () => {
    const billing = await loadBilling({ qz_billing_mode: 'whatever' });
    expect(billing.currentBillingMode()).toBe('points');
  });

  it('存储不可用（异常）时不影响返回值', async () => {
    (globalThis as unknown as { wx: unknown }).wx = {
      getStorageSync: () => {
        throw new Error('storage unavailable');
      },
      setStorageSync: () => {
        throw new Error('storage unavailable');
      },
    };
    vi.resetModules();
    const billing = await import('../../apps/mp/utils/billing');

    expect(billing.currentBillingMode()).toBe('points');
    expect(billing.priceText(5)).toBe('5 积分');
  });
});
