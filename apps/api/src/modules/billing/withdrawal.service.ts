import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { biz, formatCents, LedgerType, type BizException } from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import { PrismaService } from '../../infra/prisma/prisma.service';

import { MIN_WITHDRAW_CENTS, type CreateWithdrawalDto } from './dto/withdrawal.dto';

/**
 * 提现申请与查询（任务清单 M3-13）
 *
 * ## 本期范围：只有"申请 + 我的记录"，没有审核
 *
 * 管理后台（M3-20）尚未开工，因此**没有 review 接口**，提现单会一直停在 `pending`。
 * 这不是半成品冒充功能：`pending` 是这张单子的**真实状态**，小程序侧如实显示"审核中"。
 * 待 M3-20 接入后在本服务补 `review(id, approve, remark)`，届时必须一并处理两件事：
 *   ① 状态机：`pending → approved → paid` / `pending → rejected` 的迁移要落到
 *      `packages/core/src/state-machine`（新增 withdrawal 表 + `transition()`），
 *      不能在服务里直接赋 `status`（红线：状态变更只能走 `transition()`）；
 *   ② 驳回回补：申请时余额已经**真扣**了，驳回必须写一条反向流水把钱还回去。
 *      现在扣减与建单在同一事务里，账务是自洽的，所以还钱只是"再来一笔 + 流水"，
 *      不需要改表。`wallet.frozen` 本期不用（语义是"担保冻结"，见订单模块），
 *      若将来想改成"审核中冻结余额"，要连同 `getWallet` 的展示口径一起改。
 *
 * ## 手续费为什么是 0
 *
 * 平台服务费（学生 5%、封顶 20 元）在**订单放款时**就已经扣掉了
 * （`order.service` 用 `calcPlatformFee` / `calcProviderIncome` 入账），
 * `wallet.balance` 里躺着的是**税后**收入。提现再收一次就是重复收费，
 * 所以 `fee` 恒为 0，字段留着是给 M3-20 的"提现通道费"（若微信商户号真收到）用的。
 *
 * ## 并发
 *
 * 与 `BillingService` 同一套做法：先 upsert 再 `SELECT ... FOR UPDATE` 锁钱包行
 * （锁不住不存在的行），再用**条件更新** `balance >= amount` 做"原子扣减 + 校验"。
 * 写成"先查余额再扣"会让用户连点两次（或客户端超时重试）把余额扣成负数。
 *
 * ## 幂等
 *
 * 有意**不加**"同一用户只能有一笔待审核提现"这类限制：本期没有任何接口能把单子的
 * 状态推出 `pending`，加上去等于第一次提现后永久锁死用户。
 * 同理也不依赖 `Idempotency-Key`（客户端尚未传）。真正的重复提交防线是行锁 +
 * 余额条件更新：最坏情况是"两笔都是真实申请"，都能被审核侧看到并处理。
 */

/** 提现单状态。本期只有 Pending —— 其余状态由 M3-20 审核接口产生。 */
export const WithdrawalStatus = { Pending: 'pending' } as const;

/** 列表返回上限（与 `user.service.getWallet` 的流水口径一致） */
export const WITHDRAWAL_LIST_LIMIT = 50;

/** `wallet_ledger.ref_type` 取值：流水指向提现单 */
const REF_TYPE_WITHDRAWAL = 'withdrawal';

/** 写进资金流水 / 提现单的说明文案：让用户在钱包页看得懂这笔钱为什么少了 */
const APPLY_REMARK = '提现申请，等待平台审核';

/** 提现记录（对外形状，时间为 ISO8601） */
export interface WithdrawalView {
  id: string;
  /** 提现金额（分） */
  amount: number;
  /** 提现手续费（分），本期恒为 0，见类注释 */
  fee: number;
  /** 状态，本期恒为 pending（审核中） */
  status: string;
  remark: string | null;
  createdAt: string;
}

/** 建单响应：比列表多一个 `balanceAfter`，供前端就地刷新余额 */
export interface WithdrawalCreatedView extends WithdrawalView {
  balanceAfter: number;
}

/** 服务内部用到的提现行形状（Prisma 返回值结构上满足它） */
interface WithdrawalRow {
  id: string;
  amount: number;
  fee: number;
  status: string;
  remark: string | null;
  createdAt: Date;
}

@Injectable()
export class WithdrawalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: AppLogger,
  ) {}

  /** 起提金额（分），供 controller / 文档 / 校验复用同一数字 */
  get minAmount(): number {
    return MIN_WITHDRAW_CENTS;
  }

  /**
   * 申请提现：扣余额 → 记流水 → 建提现单，三件事同一个事务。
   *
   * @throws BizException 400/40001 —— 金额非整数 / 低于起提额 / 余额不足（文案含具体数字）
   */
  async create(userId: string, input: CreateWithdrawalDto): Promise<WithdrawalCreatedView> {
    const amount = assertWithdrawAmount(input?.amount);

    const created = await this.prisma.$transaction(async (tx) => {
      await lockWallet(tx, userId);

      // 条件更新即"原子扣减 + 余额校验"：影响 0 行说明余额不够（或被人抢先花掉了）
      const affected = await tx.$executeRaw`
        UPDATE wallet SET balance = balance - ${amount}, updated_at = NOW(3)
        WHERE user_id = ${userId} AND balance >= ${amount}`;
      if (affected === 0) throw await notEnoughBalance(tx, userId, amount);

      const withdrawal = await tx.withdrawal.create({
        data: { userId, amount, fee: 0, status: WithdrawalStatus.Pending, remark: APPLY_REMARK },
      });
      const balanceAfter = (await tx.wallet.findUnique({ where: { userId } }))?.balance ?? 0;

      // 流水只增不改：它既是"余额 = 流水累加"的对账依据（M3-13 验收项），
      // 也是审核驳回时把钱还回去的凭据。
      // amount 存**正数**（与订单入账流水同一口径）：收支方向由 type 决定，
      // 小程序钱包页就是按 type 判正负号的（withdraw → "-¥"），存负数会变成"--¥20.00"。
      await tx.walletLedger.create({
        data: {
          userId,
          type: LedgerType.Withdraw,
          amount,
          balanceAfter,
          refType: REF_TYPE_WITHDRAWAL,
          refId: withdrawal.id,
          remark: APPLY_REMARK,
        },
      });

      return { withdrawal, balanceAfter };
    });

    this.logger.log(
      `用户 ${userId} 申请提现 ${formatCents(amount)}（${created.withdrawal.id}），` +
        `余额 ${created.balanceAfter} 分`,
      'Withdrawal',
    );

    return { ...toView(created.withdrawal), balanceAfter: created.balanceAfter };
  }

  /**
   * 我的提现记录：按申请时间倒序，最多 `WITHDRAWAL_LIST_LIMIT` 条。
   * `total` 是真实总数（可能大于 `list.length`），前端据此提示"仅展示最近 50 条"。
   */
  async list(userId: string): Promise<{ list: WithdrawalView[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.prisma.withdrawal.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: WITHDRAWAL_LIST_LIMIT,
      }),
      this.prisma.withdrawal.count({ where: { userId } }),
    ]);
    return { list: rows.map(toView), total };
  }
}

/**
 * 金额自检（服务层第二道闸）。
 *
 * HTTP 层已有 `ZodValidationPipe`，但本服务是 export 出去的领域服务，
 * 将来的审核脚本 / 管理后台可能直接调它 —— 账务入口的校验不能只长在最外层。
 * 用 `Number.isInteger` 一并挡掉小数与字符串（`Number.isInteger('1000') === false`）。
 */
function assertWithdrawAmount(amount: number): number {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw biz.paramInvalid(
      { field: 'amount', min: MIN_WITHDRAW_CENTS },
      '提现金额只能是以「分」为单位的整数（如 ¥12.34 请传 1234）',
    );
  }
  if (amount < MIN_WITHDRAW_CENTS) {
    throw biz.paramInvalid(
      { field: 'amount', min: MIN_WITHDRAW_CENTS },
      `单笔提现不能低于 ${formatCents(MIN_WITHDRAW_CENTS)}，请累积收入后再试`,
    );
  }
  return amount;
}

/**
 * 余额不足：文案必须带"当前可提现多少 / 本次申请多少 / 下一步做什么"，
 * 只说"余额不足"用户会反复点同一个按钮。
 *
 * ⚠️ 本期不复用 40321 PointsNotEnough —— 那是**积分**不足，混用会让用户看到
 * "积分不足（还差 N 分）"这种驴唇不对马嘴的提示。新增"余额不足"专用码要同步
 * `packages/core/src/errors/codes.ts` 与 `docs/dev/ERROR_CODES.md`（超出本次改动范围），
 * 故先用 40001 ParamInvalid + 明确文案，错误码归属留给接审核时一并整理。
 */
async function notEnoughBalance(
  tx: Prisma.TransactionClient,
  userId: string,
  amount: number,
): Promise<BizException> {
  const have = (await tx.wallet.findUnique({ where: { userId } }))?.balance ?? 0;
  return biz.paramInvalid(
    { field: 'amount', balance: have, requested: amount, shortBy: amount - have },
    `余额不足：当前可提现 ${formatCents(have)}，本次申请 ${formatCents(amount)}，请减少金额后重试`,
  );
}

/**
 * 锁住钱包行（同一用户的提现串行化）。
 *
 * 先 upsert 再 `FOR UPDATE`：新用户可能还没有 wallet 行，直接 SELECT 锁不住不存在的行，
 * 并发保护会**静默失效**。`updated_at` 必须在原生 SQL 里显式赋值 ——
 * `@updatedAt` 是 Prisma Client 的行为，`$executeRaw` 绕过它。
 */
async function lockWallet(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.wallet.upsert({ where: { userId }, create: { userId }, update: {} });
  await tx.$queryRaw`SELECT user_id FROM wallet WHERE user_id = ${userId} FOR UPDATE`;
}

function toView(row: WithdrawalRow): WithdrawalView {
  return {
    id: row.id,
    amount: row.amount,
    fee: row.fee,
    status: row.status,
    remark: row.remark,
    createdAt: row.createdAt.toISOString(),
  };
}
