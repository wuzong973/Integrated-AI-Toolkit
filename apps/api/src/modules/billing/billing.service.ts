import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { biz, JobStatus, shouldRefundPoints, type JobStatus as JobStatusType } from '@qz/core';

import type { AppConfig } from '../../common/config/configuration';
import { AppLogger } from '../../common/logger/logger.service';
import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * 积分流水类型（`points_ledger.kind`）
 *
 * 三种取值对应文档 6.11 的三个动作。**流水只增不改**：金额一旦写入永不改动，
 * 结清状态由"这个 jobId 下有没有 charge / refund 行"派生出来，
 * 而不是去改预扣行 —— 改历史记录会让对账失去依据。
 */
export const LedgerKind = {
  /** 预扣：调用前占用积分（points 立即减少） */
  Precharge: 'precharge',
  /** 转正：预扣转为正式消费 */
  Charge: 'charge',
  /** 退回：失败 / 取消 / 超时把预扣还回 */
  Refund: 'refund',
} as const;

/** 预扣结果 */
export interface HoldResult {
  /** 本次是否真的扣了积分（cost<=0 或已预扣过时为 false） */
  held: boolean;
  /** 是否命中已有的预扣（重复调用，积分未再次减少） */
  alreadyHeld: boolean;
  /** 操作后的积分余额 */
  balanceAfter: number;
}

/**
 * 积分计费（任务清单 M1-06）
 *
 * 三条路径（文档 6.11）：
 *   ① 调用前 **预扣** —— 余额不足直接拒绝，不让任务跑起来再失败；
 *   ② 执行成功 **转正** —— 预扣转为正式消费；
 *   ③ 失败 / 取消 / 超时 / 运行时才发现不可用 **退回** —— 积分原路还回。
 *
 * ## 为什么金额只从流水里取，不信调用方
 *
 * `refund` 的退回额取自预扣行的金额（`-pre.delta`），而不是再次传入的 cost。
 * 这样即使调用方算错了金额、或重复触发退款，**退回去的钱也不会多于当初扣的**。
 * 计费是少数"错了就会被刷"的地方，能少一个入参就少一个被刷的口子。
 *
 * ## 并发与幂等（验收项"重复回调不重复扣减"）
 *
 * 两道机制叠用：
 *   · **钱包行锁**（`SELECT ... FOR UPDATE`）—— 同一用户的计费操作串行化。
 *     JobRunner 的消息可能重复投递、用户可能连点两次、超时扫描与取消可能同时发生，
 *     这些都会并发出现在这里的入口。
 *   · **流水行判定** —— 每个动作先查该 jobId 是否已有对应流水，有则空操作。
 *
 * 为什么不用唯一索引兜底并发：`points_ledger` 目前没有
 * `(ref_id, kind)` 唯一约束，加它需要一次迁移。行锁已经足够，且不引入迁移风险；
 * 待下次确实要改表时再补索引作为第二道保险（已记入遗留事项）。
 *
 * ## 免费模式（前期默认）：开关落在这一类，别处不用改
 *
 * `BILLING_ENABLED=false` 时，`hold` / `settle` / `refund` / `onJobTerminal` 全部变成**空操作**：
 * 不碰 `wallet.points`、不写 `points_ledger`、也不会因余额不足抛 403。
 * 工具调用因此完全免费，**而 `ToolInvokeService` / `JobService` 一行都不用改** ——
 * 它们只是照常调用这里。这是本设计最重要的一点：
 *
 * > **计费的开关只有这一个作用点。** 任何"绕过 BillingService 直接动积分"的写法
 * > 都会同时绕过开关，所以纪律是：除本类之外，**禁止其它模块直接写 `wallet.points`
 * > 或 `points_ledger`**（现在也确实没有）。
 *
 * 免费期**仍然照常记录 `tool_job.cost`（工具标价）**，因此事后可以算出
 * "免费期一共让利了多少积分"；把开关打开后，新的作业才开始真正扣费。
 * 数据库里的 `tool.price` 始终不动，所以恢复计费时价格就是当初设定的值。
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
  ) {}

  /** 当前是否启用积分计费（对外暴露，供 /config/public 与业务判断使用） */
  get enabled(): boolean {
    return this.config.get<AppConfig>('app')?.billing.enabled ?? false;
  }

  /** 当前积分余额 */
  async points(userId: string): Promise<number> {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    return wallet?.points ?? 0;
  }

  /**
   * 预扣积分。
   *
   * @param cost 积分单价（来自 `tool.price`）；<=0 视为免费，不写流水
   * @throws BizException PointsNotEnough（403 / 40321），detail 带还差多少分
   *
   * 免费模式下直接返回 `held: false`，**不查询余额、不写流水** ——
   * 既不扣分也不会抛 403，调用方拿到的语义是"这次没有占用积分"，
   * 与"免费工具（cost<=0）"完全一致，因此调用方无须区分这两种情况。
   */
  async hold(userId: string, jobId: string, cost: number, reason: string): Promise<HoldResult> {
    if (!this.enabled) {
      return { held: false, alreadyHeld: false, balanceAfter: await this.points(userId) };
    }
    if (cost <= 0) {
      return { held: false, alreadyHeld: false, balanceAfter: await this.points(userId) };
    }

    return this.inWalletLock(userId, async (tx) => {
      const existed = await tx.pointsLedger.findFirst({
        where: { refId: jobId, kind: LedgerKind.Precharge },
      });
      if (existed) {
        return { held: false, alreadyHeld: true, balanceAfter: existed.balanceAfter };
      }

      // 条件更新即"原子扣减 + 余额校验"：
      // 若写成"先查余额再更新"，两个并发请求可能都通过检查而把余额扣成负数
      const affected = await tx.$executeRaw`
        UPDATE wallet SET points = points - ${cost}, updated_at = NOW(3)
        WHERE user_id = ${userId} AND points >= ${cost}`;
      if (affected === 0) {
        const wallet = await tx.wallet.findUnique({ where: { userId } });
        const have = wallet?.points ?? 0;
        // 复用 core 的快捷构造：错误码、HTTP 状态、文案模板（含"还差 N 分"）三端一致
        throw biz.pointsNotEnough(cost, have);
      }

      const wallet = await tx.wallet.findUnique({ where: { userId } });
      await tx.pointsLedger.create({
        data: {
          userId,
          delta: -cost,
          reason,
          refId: jobId,
          balanceAfter: wallet?.points ?? 0,
          kind: LedgerKind.Precharge,
        },
      });

      return { held: true, alreadyHeld: false, balanceAfter: wallet?.points ?? 0 };
    });
  }

  /**
   * 预扣转正式消费（成功路径）。
   * @returns 是否真的结清了（无预扣、已结清过、或**免费模式**时返回 false）
   */
  async settle(userId: string, jobId: string, reason: string): Promise<boolean> {
    // 免费模式下不会有预扣行，下面自然查不到；这里直接短路，省掉两次查询
    if (!this.enabled) return false;

    return this.inWalletLock(userId, async (tx) => {
      if (!(await this.hasPrecharge(tx, jobId))) return false;
      if (await this.hasSettled(tx, jobId)) return false;

      const wallet = await tx.wallet.findUnique({ where: { userId } });
      // 结清行 delta 为 0：经济上"什么也没变"（预扣时已经扣过），
      // 它的价值在于把"这笔预扣已确认消费"落成可查询的事实，
      // 从而让"有 precharge 但没有 charge/refund 的作业"成为可对账的异常集合
      await tx.pointsLedger.create({
        data: {
          userId,
          delta: 0,
          reason,
          refId: jobId,
          balanceAfter: wallet?.points ?? 0,
          kind: LedgerKind.Charge,
        },
      });
      return true;
    });
  }

  /**
   * 退回预扣（失败 / 取消 / 超时 / 运行时才发现不可用）。
   *
   * 退回额取自预扣行本身，因此不会被重复触发放大。
   * @returns 是否真的退了（无预扣、已结清过、或**免费模式**时返回 false）
   */
  async refund(userId: string, jobId: string, reason: string): Promise<boolean> {
    if (!this.enabled) return false;

    return this.inWalletLock(userId, async (tx) => {
      const precharge = await tx.pointsLedger.findFirst({
        where: { refId: jobId, kind: LedgerKind.Precharge },
      });
      if (!precharge) return false;
      if (await this.hasSettled(tx, jobId)) {
        this.logger.warn(`作业 ${jobId} 的预扣已结清，忽略退回请求`, 'Billing');
        return false;
      }

      const amount = -precharge.delta; // 退回额 = 当初扣的额度
      await tx.$executeRaw`
        UPDATE wallet SET points = points + ${amount}, updated_at = NOW(3)
        WHERE user_id = ${userId}`;

      const wallet = await tx.wallet.findUnique({ where: { userId } });
      await tx.pointsLedger.create({
        data: {
          userId,
          delta: amount,
          reason,
          refId: jobId,
          balanceAfter: wallet?.points ?? 0,
          kind: LedgerKind.Refund,
        },
      });
      return true;
    });
  }

  /**
   * 作业进入终态时的计费动作（由 JobService.transition 唯一出口调用）。
   *
   * 路由规则：
   *   · `succeeded` → 转正
   *   · `failed` / `canceled`（core 的 shouldRefundPoints）→ 退回
   *   · `rejected`  → 也走一次退回。正常路径上 rejected 发生在建作业之前、并未预扣；
   *                  但执行器在运行时才发现"工具未接入"时会 reject，
   *                  此时预扣已经发生。用"只退存在的预扣"来兜住，两种情况都正确。
   *
   * **异常必须吞掉**：作业状态已经落库，为了计费失败把状态改回去只会让不一致更大。
   * 失败会留下"未结清的预扣"，由流水可查、可补。
   */
  async onJobTerminal(userId: string, jobId: string, status: string): Promise<void> {
    // 免费模式：作业终态不产生任何积分动作，直接返回（不查库、不写流水）
    if (!this.enabled) return;

    const jobStatus = status as JobStatusType;
    try {
      if (jobStatus === JobStatus.Succeeded) {
        await this.settle(userId, jobId, '工具执行完成，预扣转为正式消费');
        return;
      }
      if (shouldRefundPoints(jobStatus) || jobStatus === JobStatus.Rejected) {
        await this.refund(userId, jobId, refundReason(jobStatus));
      }
    } catch (e) {
      this.logger.error(
        `作业 ${jobId} 的计费结清失败（status=${status}）：${(e as Error).message}` +
          `—— 预扣行仍未结清，可通过 points_ledger 对账补记`,
        undefined,
        'Billing',
      );
    }
  }

  // ---------- 内部 ----------

  /**
   * 在钱包行锁内执行。
   *
   * 先 upsert 再 `FOR UPDATE`：锁不住不存在的行 —— 新用户若还没有钱包记录，
   * 直接 SELECT ... FOR UPDATE 会"成功但没锁"，并发保护就静默失效了。
   *
   * `updated_at` 必须在原生 SQL 里显式赋值：`@updatedAt` 是 Prisma Client 的行为，
   * 绕过 Client 的 `$executeRaw` 不会自动更新它。
   */
  private async inWalletLock<T>(
    userId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.wallet.upsert({ where: { userId }, create: { userId }, update: {} });
      await tx.$queryRaw`SELECT user_id FROM wallet WHERE user_id = ${userId} FOR UPDATE`;
      return fn(tx);
    });
  }

  private async hasPrecharge(tx: Prisma.TransactionClient, jobId: string): Promise<boolean> {
    const row = await tx.pointsLedger.findFirst({
      where: { refId: jobId, kind: LedgerKind.Precharge },
      select: { id: true },
    });
    return !!row;
  }

  /** 已结清 = 存在 charge 或 refund 行 */
  private async hasSettled(tx: Prisma.TransactionClient, jobId: string): Promise<boolean> {
    const row = await tx.pointsLedger.findFirst({
      where: { refId: jobId, kind: { in: [LedgerKind.Charge, LedgerKind.Refund] } },
      select: { id: true },
    });
    return !!row;
  }
}

/** 退回原因：让用户在积分明细里看到"为什么退了"，而不是一行莫名的 +N */
function refundReason(status: JobStatusType): string {
  switch (status) {
    case JobStatus.Canceled:
      return '已取消，积分退回';
    case JobStatus.Rejected:
      return '未通过校验，积分退回';
    default:
      return '执行失败，积分退回';
  }
}
