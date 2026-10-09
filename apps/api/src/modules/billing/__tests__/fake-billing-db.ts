import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { AppLogger } from '../../../common/logger/logger.service';

/**
 * 计费单测用的假 Prisma
 *
 * ## 为什么需要它（而不是连真实数据库）
 *
 * 三条计费路径（预扣 / 转正 / 退回）与幂等判定，是有明确分支的业务逻辑，
 * 用真实数据库跑要处理迁移、清理、并发时序，成本高且不稳定。
 * 这里用内存实现把**逻辑**钉死；**原生 SQL 本身的正确性**
 * （`points = points - ?` 的条件更新、`FOR UPDATE` 行锁、`NOW(3)`）
 * 交给真实数据库的端到端脚本（`scripts/dev/verify-billing.mjs`）验证 —— 两者互补。
 *
 * ## 局限（必须知道，否则会误信）
 *
 * `$executeRaw` 是**按语句形状识别**的，只认下面两条：
 *   · `UPDATE wallet SET points = points - ...` （条件扣减，余额不足返回 0 行）
 *   · `UPDATE wallet SET points = points + ...` （退回）
 * 计费服务里若新增第三种原生写语句，这个假实现会静默返回 0 ——
 * 因此新增语句时必须同步补识别，并在真实数据库脚本里补一条断言。
 * 为此这里对未识别的语句**抛出异常**而不是返回 0，让疏漏立刻暴露。
 */

interface WalletRow {
  userId: string;
  balance: number;
  frozen: number;
  totalIncome: number;
  points: number;
  updatedAt: Date;
}

interface LedgerRow {
  id: string;
  userId: string;
  delta: number;
  reason: string;
  refId: string | null;
  balanceAfter: number;
  kind: string;
  createdAt: Date;
}

/** 记录一次行锁尝试，用于断言"确实走了钱包锁" */
export interface FakeBillingDb {
  prisma: PrismaService;
  ledgers: LedgerRow[];
  wallet: () => WalletRow;
  lockCount: () => number;
  /** 模拟"另一个请求已并发把余额花掉" */
  drain: (userId: string) => void;
}

export function createFakeBillingDb(seed: { userId: string; points: number }): FakeBillingDb {
  const wallets = new Map<string, WalletRow>([
    [
      seed.userId,
      {
        userId: seed.userId,
        balance: 0,
        frozen: 0,
        totalIncome: 0,
        points: seed.points,
        updatedAt: new Date(),
      },
    ],
  ]);
  const ledgers: LedgerRow[] = [];
  let seq = 0;
  let locks = 0;

  const client = {
    wallet: {
      upsert: async ({ where }: { where: { userId: string } }): Promise<WalletRow> => {
        if (!wallets.has(where.userId)) {
          wallets.set(where.userId, {
            userId: where.userId,
            balance: 0,
            frozen: 0,
            totalIncome: 0,
            points: 0,
            updatedAt: new Date(),
          });
        }
        return wallets.get(where.userId)!;
      },
      findUnique: async ({ where }: { where: { userId: string } }): Promise<WalletRow | null> =>
        wallets.get(where.userId) ?? null,
    },
    pointsLedger: {
      findFirst: async (args: { where: LedgerWhere }): Promise<LedgerRow | null> =>
        ledgers.find((l) => matches(l, args.where)) ?? null,
      create: async ({
        data,
      }: {
        data: Omit<LedgerRow, 'id' | 'createdAt'>;
      }): Promise<LedgerRow> => {
        seq += 1;
        const row: LedgerRow = { id: `ledger-${seq}`, createdAt: new Date(), ...data };
        ledgers.push(row);
        return row;
      },
    },
    $executeRaw: async (
      strings: TemplateStringsArray,
      ...values: (string | number)[]
    ): Promise<number> => {
      const sql = strings.join('?');

      // 条件扣减：余额不足时影响 0 行（真实 MySQL 的语义）
      if (sql.includes('points = points -')) {
        const [cost, userId] = values as [number, string];
        const w = wallets.get(userId);
        if (!w || w.points < cost) return 0;
        w.points -= cost;
        w.updatedAt = new Date();
        return 1;
      }

      if (sql.includes('points = points +')) {
        const [amount, userId] = values as [number, string];
        const w = wallets.get(userId);
        if (!w) return 0;
        w.points += amount;
        w.updatedAt = new Date();
        return 1;
      }

      throw new Error(`假 Prisma 未识别的原生语句（需同步补识别）：${sql}`);
    },
    $queryRaw: async (strings: TemplateStringsArray): Promise<unknown[]> => {
      if (strings.join('?').includes('FOR UPDATE')) locks += 1;
      return [];
    },
  };

  const prisma = {
    ...client,
    // 事务：直接把同一个假客户端交给回调（无需真正回滚，本测试不构造中途失败的场景）
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(client),
  } as unknown as PrismaService;

  return {
    prisma,
    ledgers,
    wallet: () => wallets.get(seed.userId)!,
    lockCount: () => locks,
    drain: (userId: string) => {
      const w = wallets.get(userId);
      if (w) w.points = 0;
    },
  };
}

/** 空的日志假实现（断言里偶尔需要看告警） */
export function createFakeLogger(): AppLogger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    log: () => undefined,
    debug: () => undefined,
    warn: (message: string) => {
      warnings.push(message);
    },
    error: () => undefined,
  } as unknown as AppLogger & { warnings: string[] };
}

type LedgerWhere = {
  refId?: string;
  kind?: string | { in: string[] };
};

function matches(row: LedgerRow, where: LedgerWhere): boolean {
  if (where.refId !== undefined && row.refId !== where.refId) return false;
  if (typeof where.kind === 'string' && row.kind !== where.kind) return false;
  if (where.kind && typeof where.kind === 'object' && !where.kind.in.includes(row.kind))
    return false;
  return true;
}
