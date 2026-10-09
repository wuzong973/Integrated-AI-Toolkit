import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AppLogger } from '../../common/logger/logger.service';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** 一次后台操作留痕 */
export interface AuditInput {
  /** 操作人 `user.id`（不是 `admin_account.id` —— 追溯要落到"同一个人"） */
  actorId: string;
  /** 动作名，形如 `user.status.update` / `order.resolve`，用点分层便于按前缀筛 */
  action: string;
  targetType?: string;
  targetId?: string;
  /** 变更前快照（只放**受影响的字段**，不要把整个实体塞进来） */
  before?: unknown;
  after?: unknown;
  /**
   * 操作理由（可选）。
   *
   * `audit_log` 表没有独立的 reason 列，这里会把它并进 `after` 的 JSON 里。
   * 不新增列的原因：理由只对**部分动作**有意义（封禁要写、看列表不用写），
   * 给它开一个大多数行都是 NULL 的列，不如留在 JSON 里按需读取。
   */
  reason?: string;
  ip?: string;
  traceId?: string;
}

/**
 * 后台操作审计（任务清单 M0-23；`audit_log` 表此前建好但无人写入）
 *
 * ## 为什么必须有它
 *
 * 后台能做的是封号、放款、退款、改他人角色。这些动作**事后必须能回答
 * "谁在什么时候、基于什么，把什么改成了什么"** —— 没有这层记录，
 * 一次误封或一笔错放的款就只剩客服的口头描述。
 *
 * ## 什么时候传事务
 *
 * 与被审计的业务写入**在同一个事务里**时，必须把 `tx` 传进来：
 * 否则可能出现"业务改了、审计没写"（留下一个无法追溯的变更），
 * 或反过来"审计写了、业务回滚了"（留下一条根本没发生的记录，比没有更糟）。
 *
 * 不传 `tx` 时（只读类动作、或业务本身不在事务里），写失败**只记日志不抛错**：
 * 审计是**旁路**，不该把一次已经成功的业务操作变成 500。
 * 这一点与审核（fail-closed）的取舍不同，原因是被保护的对象不同 ——
 * 那里拦不住会放过违规内容，这里拦不住只是少一条日志。
 */
@Injectable()
export class AdminAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: AppLogger,
  ) {}

  async record(input: AuditInput, tx?: Prisma.TransactionClient): Promise<void> {
    const data = buildRow(input);

    if (tx) {
      await tx.auditLog.create({ data });
      return;
    }

    try {
      await this.prisma.auditLog.create({ data });
    } catch (e) {
      this.logger.error(
        `审计日志写入失败：${(e as Error).message}`,
        undefined,
        'AdminAudit',
        { action: data.action, targetId: data.targetId },
      );
    }
  }
}

/** 落库前统一裁剪长度并转成 JSON 安全值 */
function buildRow(input: AuditInput) {
  const after = mergeReason(input.after, input.reason);
  return {
    actorId: input.actorId,
    action: input.action.slice(0, 60),
    targetType: input.targetType?.slice(0, 40) ?? null,
    targetId: input.targetId?.slice(0, 60) ?? null,
    before: toJson(input.before),
    after: toJson(after),
    ip: input.ip?.slice(0, 60) ?? null,
    traceId: input.traceId?.slice(0, 60) ?? null,
  };
}

/** 把理由并进 after（对象 → 加 `reason` 键；非对象 → 包一层，避免理由被丢掉） */
function mergeReason(after: unknown, reason?: string): unknown {
  if (!reason) return after;
  if (after && typeof after === 'object' && !Array.isArray(after)) {
    return { ...(after as Record<string, unknown>), reason };
  }
  return after === undefined || after === null ? { reason } : { after, reason };
}

/**
 * 转成可入库的 JSON。
 *
 * 走一次 `JSON.parse(JSON.stringify(v))`：快照里经常带 `Date`、`undefined`、
 * 甚至一整行 Prisma 对象，直接塞进 Json 列会抛错或产生"看似写入、实际丢字段"的结果。
 * 先在内存里走一遍 JSON 往返，能保证入库的就是屏幕上看到的那份数据。
 */
function toJson(v: unknown): Prisma.InputJsonValue | undefined {
  if (v === undefined || v === null) return undefined;
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}
