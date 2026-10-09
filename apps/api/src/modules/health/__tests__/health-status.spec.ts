import { describe, expect, it } from 'vitest';

import { buildDegradedReasons, resolveHealthStatus } from '../health.controller';

/**
 * 锁死 /health 的三态判定（排查报告 P0-2）。
 *
 * 这段逻辑曾经的缺陷是 **顶层 status 恒为 'ok'**：Redis 挂掉、队列降级为进程内执行时
 * 仍报 'ok'，监控与告警完全漏报 —— 属于"降级静默"的一种，违反 M0-11 判据。
 * 因此这里的断言重点是 **"任何降级都必须体现为 degraded，绝不能是 ok"**。
 *
 * ## 第二轮修复（服务层降级曾不计入）
 *
 * 修完"恒为 ok"之后又发现一格漏洞：`degradations`（如微信登录未配 AppSecret →
 * 返回伪 openid）**没有参与顶层判定**，于是出现过自相矛盾的响应：
 * `status: 'ok'` + `degradedReasons: []` + `degradations: [wechat-login]`。
 * 监控看到绿灯，实际上登录是假的。所以下面专门有一组用例锁住这一格。
 */

/** 构造输入时的默认值；只有关心某几项的用例才显式覆盖 */
const healthy = { dbOk: true, redisOk: true, queueDegraded: false };

describe('resolveHealthStatus —— 依赖降级必须体现在顶层 status', () => {
  it('全绿 → ok', () => {
    expect(resolveHealthStatus({ ...healthy, degradationCount: 0 })).toBe('ok');
  });

  it('数据库挂 → down（优先级高于其它降级）', () => {
    expect(resolveHealthStatus({ ...healthy, dbOk: false, degradationCount: 0 })).toBe('down');
    // 数据库挂了，即使 Redis 是好的，也必须是 down 而不是 degraded
    expect(
      resolveHealthStatus({ dbOk: false, redisOk: false, queueDegraded: true, degradationCount: 1 }),
    ).toBe('down');
  });

  it('Redis 挂 → degraded（不再冒充 ok）', () => {
    expect(resolveHealthStatus({ ...healthy, redisOk: false, degradationCount: 0 })).toBe('degraded');
  });

  it('队列降级 → degraded（即使 Redis ping 通）', () => {
    // 这是最容易漏的一格：Redis ping 通但队列仍标记降级，说明降级另有原因，
    // 不能因为 redisOk 就判定整体健康。
    expect(resolveHealthStatus({ ...healthy, queueDegraded: true, degradationCount: 0 })).toBe(
      'degraded',
    );
  });

  it('有服务层降级 → degraded（即使基础设施全绿）', () => {
    // ⚠️ 这一格曾经漏判：degradations 非空时 status 仍是 'ok'。
    // 典型场景：未配 WECHAT_SECRET → 登录返回伪 openid，而监控看到的是绿灯。
    expect(resolveHealthStatus({ ...healthy, degradationCount: 1 })).toBe('degraded');
    expect(resolveHealthStatus({ ...healthy, degradationCount: 3 })).toBe('degraded');
  });

  it('服务层降级再叠加基础设施降级，仍然是 degraded 而不是更轻的档位', () => {
    expect(
      resolveHealthStatus({ dbOk: true, redisOk: false, queueDegraded: true, degradationCount: 1 }),
    ).toBe('degraded');
  });
});

describe('buildDegradedReasons —— 降级原因必须可定位', () => {
  it('无降级时为空数组（便于调用方用 length 判断）', () => {
    expect(buildDegradedReasons({ ...healthy, degradations: [] })).toEqual([]);
  });

  it('同时命中多项时逐条列出，不合并、不丢失', () => {
    const reasons = buildDegradedReasons({
      dbOk: false,
      redisOk: false,
      queueDegraded: true,
      degradations: [],
    });
    expect(reasons).toHaveLength(3);
    expect(reasons.join('\n')).toContain('数据库');
    expect(reasons.join('\n')).toContain('Redis');
    expect(reasons.join('\n')).toContain('队列');
  });

  it('原因条数与降级项数一致（防止新增依赖时漏写原因）', () => {
    expect(
      buildDegradedReasons({ ...healthy, redisOk: false, degradations: [] }),
    ).toHaveLength(1);
    expect(
      buildDegradedReasons({ ...healthy, queueDegraded: true, degradations: [] }),
    ).toHaveLength(1);
    expect(
      buildDegradedReasons({ ...healthy, redisOk: false, queueDegraded: true, degradations: [] }),
    ).toHaveLength(2);
  });

  it('服务层降级也进原因清单，且带上降级点名称', () => {
    const reasons = buildDegradedReasons({
      ...healthy,
      degradations: [{ name: 'wechat-login', reason: '登录返回伪 openid' }],
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('wechat-login');
    expect(reasons[0]).toContain('伪 openid');
  });

  it('多个服务层降级逐条平铺，不合并成一句', () => {
    const reasons = buildDegradedReasons({
      ...healthy,
      degradations: [
        { name: 'wechat-login', reason: 'A' },
        { name: 'wechat-pay', reason: 'B' },
      ],
    });
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain('wechat-login');
    expect(reasons[1]).toContain('wechat-pay');
  });

  it('status 与 degradedReasons 长度必须一致（非空必 degraded）', () => {
    // 这条是"两者口径不一致"的兜底断言：只要算出了原因，状态就不能是 ok。
    const input = { dbOk: true, redisOk: false, queueDegraded: false };
    const degradations = [{ name: 'x', reason: 'y' }];
    const reasons = buildDegradedReasons({ ...input, degradations });
    const status = resolveHealthStatus({ ...input, degradationCount: degradations.length });
    expect(reasons.length).toBeGreaterThan(0);
    expect(status).not.toBe('ok');
  });
});
