import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it } from 'vitest';
import { BizException, ErrorCode } from '@qz/core';

import { BillingService, LedgerKind } from '../billing.service';

import { createFakeBillingDb, createFakeLogger, type FakeBillingDb } from './fake-billing-db';

/**
 * M1-06 验收测试
 *
 * 验收标准（任务清单 M1-06）：**三条路径单测全绿；重复回调不重复扣减**。
 *
 * 三条路径 = 预扣 → 成功转正 / 失败退回。本文件把每条路径的**重复触发**
 * 也一起覆盖：作业消息会重复投递、用户会连点两次、超时扫描与取消可能同时到达，
 * "只跑一次正常路径"的测试在真实环境里几乎必然漏掉重复这一半。
 *
 * 另有一组 **免费模式（`BILLING_ENABLED=false`）** 的用例 —— 它是前期的主状态，
 * 必须证明两件事：① 开关关掉后一个积分都不动；② 再打开时行为与原来**逐字节一致**。
 */
const USER = 'user-1';

/** 计费开关的假配置 */
function billingConfig(enabled: boolean): ConfigService {
  return { get: () => ({ billing: { enabled } }) } as unknown as ConfigService;
}

describe('M1-06 积分计费', () => {
  let db: FakeBillingDb;
  let billing: BillingService;
  let logger: ReturnType<typeof createFakeLogger>;

  beforeEach(() => {
    db = createFakeBillingDb({ userId: USER, points: 100 });
    logger = createFakeLogger();
    billing = new BillingService(db.prisma, billingConfig(true), logger);
  });

  // ---------- 路径一：预扣 ----------

  describe('预扣', () => {
    it('余额充足：扣减积分并写预扣流水，balanceAfter 为扣后余额', async () => {
      const r = await billing.hold(USER, 'job-1', 30, '「生成 PPT」预扣');

      expect(r.held).toBe(true);
      expect(r.balanceAfter).toBe(70);
      expect(db.wallet().points).toBe(70);
      expect(db.ledgers).toHaveLength(1);
      expect(db.ledgers[0]).toMatchObject({
        delta: -30,
        kind: LedgerKind.Precharge,
        refId: 'job-1',
        balanceAfter: 70,
      });
    });

    it('余额不足：抛 403/40321 且积分不变、不写流水', async () => {
      await expect(billing.hold(USER, 'job-2', 150, '预扣')).rejects.toMatchObject({
        code: ErrorCode.PointsNotEnough,
        httpStatus: 403,
      });

      expect(db.wallet().points).toBe(100);
      expect(db.ledgers).toHaveLength(0);
    });

    it('余额不足的错误 detail 带"还差多少分"（前端要能提示具体数字）', async () => {
      try {
        await billing.hold(USER, 'job-3', 130, '预扣');
        throw new Error('应当抛错');
      } catch (e) {
        expect(e).toBeInstanceOf(BizException);
        expect((e as BizException).detail).toEqual({ n: 30 });
      }
    });

    it('⭐ 同一作业重复预扣：只扣一次（重复回调不重复扣减）', async () => {
      await billing.hold(USER, 'job-4', 30, '预扣');
      const second = await billing.hold(USER, 'job-4', 30, '预扣');

      expect(second.held).toBe(false);
      expect(second.alreadyHeld).toBe(true);
      expect(second.balanceAfter).toBe(70); // 仍只扣了一次
      expect(db.wallet().points).toBe(70);
      expect(db.ledgers).toHaveLength(1);
    });

    it('免费工具（cost=0）不写流水、不动余额', async () => {
      const r = await billing.hold(USER, 'job-5', 0, '预扣');
      expect(r.held).toBe(false);
      expect(db.wallet().points).toBe(100);
      expect(db.ledgers).toHaveLength(0);
    });

    it('并发扣减不会把余额扣成负数（条件更新兜底）', async () => {
      // 模拟"另一个请求先把钱花掉"：这里的扣减应当直接失败，而不是扣成负
      db.drain(USER);
      await expect(billing.hold(USER, 'job-6', 10, '预扣')).rejects.toBeInstanceOf(BizException);
      expect(db.wallet().points).toBe(0);
    });

    it('所有计费动作都在钱包行锁内执行（并发保护的前提）', async () => {
      await billing.hold(USER, 'job-7', 10, '预扣');
      expect(db.lockCount()).toBeGreaterThan(0);
    });
  });

  // ---------- 路径二：成功转正 ----------

  describe('成功转正', () => {
    it('写结清确认行（delta=0），余额不再变动', async () => {
      await billing.hold(USER, 'job-10', 30, '预扣');
      const settled = await billing.settle(USER, 'job-10', '执行完成');

      expect(settled).toBe(true);
      expect(db.wallet().points).toBe(70); // 预扣时已扣，转正不再动钱
      expect(db.ledgers).toHaveLength(2);
      expect(db.ledgers[1]).toMatchObject({
        delta: 0,
        kind: LedgerKind.Charge,
        refId: 'job-10',
        balanceAfter: 70,
      });
    });

    it('⭐ 重复转正：只写一条确认行', async () => {
      await billing.hold(USER, 'job-11', 30, '预扣');
      expect(await billing.settle(USER, 'job-11', '执行完成')).toBe(true);
      expect(await billing.settle(USER, 'job-11', '执行完成')).toBe(false);

      expect(db.ledgers.filter((l) => l.kind === LedgerKind.Charge)).toHaveLength(1);
      expect(db.wallet().points).toBe(70);
    });

    it('没有预扣的作业（免费工具）转正时空操作', async () => {
      expect(await billing.settle(USER, 'job-12', '执行完成')).toBe(false);
      expect(db.ledgers).toHaveLength(0);
    });
  });

  // ---------- 路径三：失败退回 ----------

  describe('失败退回', () => {
    it('退回预扣：写退回流水并恢复余额', async () => {
      await billing.hold(USER, 'job-20', 30, '预扣');
      expect(db.wallet().points).toBe(70);

      const refunded = await billing.refund(USER, 'job-20', '执行失败，积分退回');

      expect(refunded).toBe(true);
      expect(db.wallet().points).toBe(100);
      expect(db.ledgers).toHaveLength(2);
      expect(db.ledgers[1]).toMatchObject({
        delta: 30,
        kind: LedgerKind.Refund,
        refId: 'job-20',
        balanceAfter: 100,
      });
    });

    it('⭐ 重复退回：只退一次（不会把钱退多）', async () => {
      await billing.hold(USER, 'job-21', 30, '预扣');
      expect(await billing.refund(USER, 'job-21', '失败')).toBe(true);
      expect(await billing.refund(USER, 'job-21', '失败')).toBe(false);
      expect(await billing.refund(USER, 'job-21', '失败')).toBe(false);

      expect(db.wallet().points).toBe(100); // 回到原值，而不是 130
      expect(db.ledgers.filter((l) => l.kind === LedgerKind.Refund)).toHaveLength(1);
    });

    it('退回额取自预扣流水，不接受外部传入的金额', async () => {
      await billing.hold(USER, 'job-22', 25, '预扣');
      await billing.refund(USER, 'job-22', '失败');
      // 无论谁调用、调用几次，退回的始终是当初扣掉的 25
      expect(db.ledgers[1].delta).toBe(25);
      expect(db.wallet().points).toBe(100);
    });

    it('没有预扣的作业退回时空操作（rejected 的正常情形）', async () => {
      expect(await billing.refund(USER, 'job-23', '未通过校验')).toBe(false);
      expect(db.wallet().points).toBe(100);
      expect(db.ledgers).toHaveLength(0);
    });

    it('已转正的作业不再退回（避免"成功后又被退钱"）', async () => {
      await billing.hold(USER, 'job-24', 30, '预扣');
      await billing.settle(USER, 'job-24', '执行完成');

      expect(await billing.refund(USER, 'job-24', '失败')).toBe(false);
      expect(db.wallet().points).toBe(70);
      expect(logger.warnings.some((w) => w.includes('已结清'))).toBe(true);
    });
  });

  // ---------- 与作业终态的联动 ----------

  describe('作业终态联动（JobService 唯一出口调用）', () => {
    it('succeeded → 转正', async () => {
      await billing.hold(USER, 'job-30', 40, '预扣');
      await billing.onJobTerminal(USER, 'job-30', 'succeeded');

      expect(db.ledgers.map((l) => l.kind)).toEqual([LedgerKind.Precharge, LedgerKind.Charge]);
      expect(db.wallet().points).toBe(60);
    });

    for (const status of ['failed', 'canceled']) {
      it(`${status} → 退回`, async () => {
        await billing.hold(USER, 'job-31', 40, '预扣');
        await billing.onJobTerminal(USER, 'job-31', status);

        expect(db.ledgers.map((l) => l.kind)).toEqual([LedgerKind.Precharge, LedgerKind.Refund]);
        expect(db.wallet().points).toBe(100);
      });
    }

    it('rejected → 退回（兼容"运行时才发现工具未接入"的情形）', async () => {
      await billing.hold(USER, 'job-32', 40, '预扣');
      await billing.onJobTerminal(USER, 'job-32', 'rejected');
      expect(db.wallet().points).toBe(100);
    });

    it('非终态（running / queued）不触发任何计费动作', async () => {
      await billing.hold(USER, 'job-33', 40, '预扣');
      await billing.onJobTerminal(USER, 'job-33', 'running');
      await billing.onJobTerminal(USER, 'job-33', 'queued');

      expect(db.ledgers).toHaveLength(1); // 还只有预扣行
    });

    it('计费失败不会向外抛错（作业状态已经落库，不能被计费回滚）', async () => {
      const broken = new BillingService(
        {
          ...(db.prisma as object),
          $transaction: async () => {
            throw new Error('数据库连接中断');
          },
        } as never,
        billingConfig(true),
        logger,
      );
      await expect(broken.onJobTerminal(USER, 'job-34', 'succeeded')).resolves.toBeUndefined();
    });
  });

  // ---------- 端到端：一整条生命周期 ----------

  it('完整生命周期：预扣 → 失败退回 → 余额归位；重复回调不改变结果', async () => {
    const before = db.wallet().points;

    await billing.hold(USER, 'job-40', 30, '预扣');
    await billing.onJobTerminal(USER, 'job-40', 'failed');
    // 队列重投、超时扫描、用户重试都会再触发一次
    await billing.onJobTerminal(USER, 'job-40', 'failed');
    await billing.onJobTerminal(USER, 'job-40', 'canceled');

    expect(db.wallet().points).toBe(before);
    expect(db.ledgers.filter((l) => l.kind === LedgerKind.Refund)).toHaveLength(1);
    // 流水净额为零，账实相符
    expect(db.ledgers.reduce((sum, l) => sum + l.delta, 0)).toBe(0);
  });

  it('完整生命周期：预扣 → 成功转正；流水净额为负的消费额', async () => {
    const before = db.wallet().points;

    await billing.hold(USER, 'job-41', 30, '预扣');
    await billing.onJobTerminal(USER, 'job-41', 'succeeded');
    await billing.onJobTerminal(USER, 'job-41', 'succeeded');

    expect(db.wallet().points).toBe(before - 30);
    expect(db.ledgers.reduce((sum, l) => sum + l.delta, 0)).toBe(-30);
  });
});

/**
 * 免费模式（`BILLING_ENABLED=false`）—— 前期的主状态
 *
 * 这一组的价值不在"功能能用"，而在**证明开关真的干净**：
 * 关掉之后不能有任何积分变动、不能写流水、不能因为余额不足拒绝用户，
 * 也不能留下任何"半结清"的脏状态。只要有一条不成立，将来打开开关就会冒出对账差异。
 */
describe('免费模式（BILLING_ENABLED=false）', () => {
  let db: FakeBillingDb;
  let billing: BillingService;

  beforeEach(() => {
    db = createFakeBillingDb({ userId: USER, points: 0 }); // 余额为 0 才最能暴露"偷偷扣费"
    billing = new BillingService(db.prisma, billingConfig(false), createFakeLogger());
  });

  it('开关状态可读（供 /config/public 与业务判断）', () => {
    expect(billing.enabled).toBe(false);
  });

  it('⭐ 预扣变成空操作：不扣分、不写流水、余额为 0 也不报错', async () => {
    const r = await billing.hold(USER, 'job-f1', 30, '预扣');

    expect(r.held).toBe(false);
    expect(r.alreadyHeld).toBe(false);
    expect(r.balanceAfter).toBe(0);
    expect(db.wallet().points).toBe(0); // 没有扣成负数
    expect(db.ledgers).toHaveLength(0); // 没有流水
    expect(db.lockCount()).toBe(0); // 连行锁都没去抢（免费模式不该有任何计费开销）
  });

  it('⭐ 余额不足不再拒绝用户（免费开放，40321 不会出现）', async () => {
    // 余额 0 且单价 999：计费模式下必然抛 PointsNotEnough，免费模式下必须放行
    await expect(billing.hold(USER, 'job-f2', 999, '预扣')).resolves.toMatchObject({
      held: false,
    });
  });

  it('成功路径不写结清行、失败路径不写退回行', async () => {
    expect(await billing.settle(USER, 'job-f3', '完成')).toBe(false);
    expect(await billing.refund(USER, 'job-f3', '失败')).toBe(false);

    await billing.hold(USER, 'job-f3', 30, '预扣');
    await billing.onJobTerminal(USER, 'job-f3', 'succeeded');
    await billing.onJobTerminal(USER, 'job-f4', 'failed');
    await billing.onJobTerminal(USER, 'job-f5', 'canceled');

    expect(db.ledgers).toHaveLength(0);
    expect(db.wallet().points).toBe(0);
  });

  it('所有作业终态都不产生积分动作', async () => {
    for (const status of ['succeeded', 'failed', 'canceled', 'rejected', 'running', 'queued']) {
      await billing.onJobTerminal(USER, `job-${status}`, status);
    }
    expect(db.ledgers).toHaveLength(0);
  });

  it('⭐ 平滑切换：开关打开后，同一套逻辑立即恢复三条路径', async () => {
    // 免费期：跑了几个作业，账户与流水都没有任何痕迹
    await billing.hold(USER, 'job-free-1', 30, '预扣');
    await billing.onJobTerminal(USER, 'job-free-1', 'succeeded');
    expect(db.ledgers).toHaveLength(0);
    expect(db.wallet().points).toBe(0);

    // 给用户充值（模拟运营动作），然后**只改开关、不改代码**
    db.wallet().points = 100;
    const paid = new BillingService(db.prisma, billingConfig(true), createFakeLogger());

    await paid.hold(USER, 'job-paid-1', 30, '预扣');
    expect(db.wallet().points).toBe(70);
    await paid.onJobTerminal(USER, 'job-paid-1', 'succeeded');
    expect(db.ledgers.map((l) => l.kind)).toEqual([LedgerKind.Precharge, LedgerKind.Charge]);

    // 且"重复回调不重复扣减"这条保证在切换后依然成立
    await paid.onJobTerminal(USER, 'job-paid-1', 'succeeded');
    expect(db.wallet().points).toBe(70);
  });

  it('免费期的作业不会被"事后补扣"（免费就是免费）', async () => {
    await billing.hold(USER, 'job-old', 30, '预扣');
    db.wallet().points = 100;

    const paid = new BillingService(db.prisma, billingConfig(true), createFakeLogger());
    // 免费期跑的作业在计费期进入终态：没有预扣行，因此只会"无可结清"，不会倒扣
    await paid.onJobTerminal(USER, 'job-old', 'succeeded');

    expect(db.wallet().points).toBe(100);
    expect(db.ledgers).toHaveLength(0);
  });
});
