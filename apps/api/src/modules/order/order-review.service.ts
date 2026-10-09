import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  CREDIT_SCORE_DEFAULT,
  advanceCreditScore,
  asStringArray,
  creditDeltaForRating,
  type RatingInput,
} from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * 评价与信用闭环（任务清单 M3-16；文档 6.6.4）
 *
 * ## 为什么评价的**写入**挂在验收里，而不是单独一个"提交评价"接口
 *
 * `Review` 的唯一键就是 `(orderId, reviewerId)`，而"谁能评谁"完全由订单决定：
 * 买家验收时给服务者打分。做成两个接口就会出现"验收成功、评价失败"的半状态
 * —— 而钱已经放出去了，评价却没了，且没有任何回滚通道。
 * 所以本文件的写函数**跑在 OrderPayService.accept 的事务里**：
 * 放款、评价、记分三件事要么全发生，要么全不发生。
 *
 * ## 信用分落在 `user_profile.credit_score`，不在 `user` 表
 *
 * schema 里 `User` 没有信用字段（`CreditLog` 只是流水，不含余额），
 * 分数的唯一权威是 `UserProfile.creditScore`。`GET /user/credit` 读的也是它，
 * 所以这里写的每一分，信用页都能看到 —— 闭环成立的正是这一点。
 *
 * ## 记分口径只有一份
 *
 * 增减值来自 `@qz/core` 的 `creditDeltaForRating()`（文档 6.6.4 / 信用页 RULES 展示
 * 同源），0~100 的夹取来自 `advanceCreditScore()`。本文件不自己写 `+2 / -3`。
 *
 * ## 尚未覆盖的部分（不是遗漏，是没做的上游）
 *
 * · 追评（`review` 表没有父评价外键，文档"完成后 30 天内可追评一次"未开工）；
 * · 服务者反向评价买家（缺"买家完成"这个触发动作）；
 * · 刷单不计分（同设备/IP 反作弊，属 M4 风控）；
 * · 单日 +6 加分上限（文档 6.6.4 备注，需要跨订单聚合，同上）。
 */

/** 评价可见性（`review.status`）：举报后管理端置 `hidden`，两边都不该再看到 */
const REVIEW_VISIBLE = 'normal';
/** 匿名评价对被评价方显示的昵称。留空会让界面出现空白行，写成"匿名"又像缺数据 */
const ANONYMOUS_NICKNAME = '匿名同学';
/** 昵称为空时的兜底（与 `order.service.ts` 的 `asParty()` 同口径） */
const FALLBACK_NICKNAME = '同学';
/** 单次返回条数（评价是流水型数据，与订单列表同口径，不做深分页） */
const REVIEW_PAGE_SIZE = 50;

/** 列表方向：received=别人给我的（我是被评价方）｜given=我给出的 */
export type ReviewSide = 'received' | 'given';

/**
 * 单条评价（字段与信用页/评价列表对齐）。
 *
 * 可选字段**不降级成 null**：`content` 缺失就不下发该键，与本项目
 * "可空字段不写 null 泄漏给前端"的既有约定一致（见 station 模块同名单测）。
 */
export interface ReviewItemDto {
  id: string;
  /** 所属订单：买卖双方本来就认识这条订单，不构成越权信息 */
  orderId: string;
  rating: number;
  content?: string;
  tags: string[];
  /** 本条是否对被评价方匿名（given 列表里是"我选了匿名"这个事实） */
  anonymous: boolean;
  /** 对方昵称；匿名评价只在这里被隐藏 */
  nickname: string;
  /** 对方用户 id：匿名时不下发，否则等于昵称藏了、id 没藏 */
  peerId?: string;
  createdAt: string;
}

export interface ReviewListDto {
  list: ReviewItemDto[];
  total: number;
}

/** 记分入参：调用方（验收事务）已确认 reviewerId 就是这条订单的买家 */
export interface RecordRatingArgs extends RatingInput {
  tx: Prisma.TransactionClient;
  orderId: string;
  orderNo: string;
  /** 评价人 = 验收的买家 */
  reviewerId: string;
  /** 被评价人 = 服务者，信用分加/扣在他身上 */
  targetId: string;
}

/**
 * 把一次验收评价落库：`Review` → `CreditLog` → `user_profile.credit_score`。
 *
 * ## 幂等判据是"这条订单这个人是否已有评价"
 *
 * 与 `creditProvider()` 用"是否已有入账流水"判重同理，**不信任调用方只调一次**。
 * 已有评价就整段跳过：评价、流水、分数三者一起不重复，
 * 而不是"再写一条流水把分数扣两次" —— 后者是最坏形态（用户连点两下信用就崩了）。
 *
 * ## 为什么分数要 `upsert` → `FOR UPDATE` → 读 → 写
 *
 * 两步不可省：① 锁不住不存在的行（老服务者可能还没有 `user_profile`），
 * 直接 `FOR UPDATE` 会"成功但没锁"，并发保护静默失效；② 读必须在拿锁**之后**，
 * 否则并发评价会各自读到同一个旧分数、后写覆盖前写（丢更新）。
 * 与 `order-pay.service.ts` 的钱包入账完全同构，不是重复设计。
 */
export async function recordAcceptRating(args: RecordRatingArgs): Promise<void> {
  const { tx, orderId, orderNo, reviewerId, targetId, rating } = args;

  // `review` 表本来就有 `@@unique([orderId, reviewerId])`（无需改 schema），
  // 这里按该组合查一次：既是幂等判据，也让"一行/订单/评价人"这个约束显式成立。
  const existed = await tx.review.findFirst({
    where: { orderId, reviewerId },
    select: { id: true },
  });
  if (existed) return;

  const delta = creditDeltaForRating(rating); // 非法星级在这里抛，事务整体回滚（不写错账）

  await tx.review.create({
    data: {
      orderId,
      reviewerId,
      targetId,
      rating,
      tags: args.tags ?? [],
      content: args.content ?? null,
      isAnonymous: args.isAnonymous ?? false,
    },
  });

  const score = await applyCreditDelta(tx, targetId, delta);

  // 评分聚合：服务者均分 = ratingSum / ratingCount（读侧在 service 模块与主页展示）。
  // 不写这两列，评价闭环只接了信用、均分永远"暂无评价"——同一事务里一并结掉。
  await tx.userProfile.update({
    where: { userId: targetId },
    data: { ratingSum: { increment: rating }, ratingCount: { increment: 1 } },
  });

  await tx.creditLog.create({
    data: {
      userId: targetId,
      delta,
      // `credit_log.reason` 是 VarChar(60)：orderNo 最长 40，本串约 50 字仍在界内。
      // 正因如此这里刻意**不拼**评价正文/标签 —— 那些是不定长内容，
      // 一旦超列宽 MySQL 直接报错，整笔验收跟着回滚（分数没记上、钱也放不出去）。
      reason: `订单 ${orderNo} 获得 ${rating} 星评价`,
      refId: orderId,
      balanceAfter: score,
    },
  });
}

/**
 * 信用分增减并回写，返回**夹取后**的新分数（给流水当 balanceAfter）。
 *
 * 3 星会记一条 `delta: 0` 的流水：它是"这次评价没让分数动过"的凭证。
 * 流水的价值在于"每一次评价都可解释分数为什么是这个数"，把它省掉，
 * 用户下次看到分数变化就只能猜。
 */
async function applyCreditDelta(
  tx: Prisma.TransactionClient,
  userId: string,
  delta: number,
): Promise<number> {
  await tx.userProfile.upsert({ where: { userId }, create: { userId }, update: {} });
  await tx.$queryRaw`SELECT user_id FROM user_profile WHERE user_id = ${userId} FOR UPDATE`;
  const profile = await tx.userProfile.findUnique({
    where: { userId },
    select: { creditScore: true },
  });
  const score = advanceCreditScore(profile?.creditScore ?? CREDIT_SCORE_DEFAULT, delta);
  await tx.userProfile.update({ where: { userId }, data: { creditScore: score } });
  return score;
}

/** 收到的评价带评价人，给出的评价带被评价人 —— 一次查两缘，映射时按方向取 */
const REVIEW_INCLUDE = {
  reviewer: { select: { id: true, nickname: true } },
  target: { select: { id: true, nickname: true } },
} as const;

/** `findMany` 出来的行（结构上覆盖两种方向，避免为每个方向写一套映射） */
type ReviewRow = {
  id: string;
  orderId: string;
  rating: number;
  content: string | null;
  tags: unknown;
  isAnonymous: boolean;
  createdAt: Date;
  reviewer: { id: string; nickname: string | null };
  target: { id: string; nickname: string | null };
};

/**
 * 评价读取服务（`GET /orders/reviews/received` / `given`）。
 *
 * ## 权限是"结构性"的，不靠判断语句
 *
 * 两个方法各按一个列过滤：`targetId = 我` / `reviewerId = 我`。
 * 没有任何一条路径能把别人的评价查出来 —— 所以这里没有 `if (row.xxxId !== userId) throw`
 * 那种"忘了写就把家交出去"的分支。越权在读接口上的正确形态是**查不到**，
 * 而不是 403（403 反而确认了"这条评价存在"）。
 */
@Injectable()
export class OrderReviewService {
  constructor(private readonly prisma: PrismaService) {}

  /** 别人给我的评价（我是被评价方）；匿名评价在此处隐藏昵称与 peerId */
  received(userId: string): Promise<ReviewListDto> {
    return this.listBy(userId, 'received');
  }

  /** 我给出的评价（我是评价人）；对方昵称照常显示 —— 评的是谁我自己知道 */
  given(userId: string): Promise<ReviewListDto> {
    return this.listBy(userId, 'given');
  }

  private async listBy(userId: string, side: ReviewSide): Promise<ReviewListDto> {
    const where = {
      status: REVIEW_VISIBLE,
      ...(side === 'received' ? { targetId: userId } : { reviewerId: userId }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.review.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: REVIEW_PAGE_SIZE,
        include: REVIEW_INCLUDE,
      }),
      this.prisma.review.count({ where }),
    ]);
    return { list: rows.map((row) => toReviewItem(row, side)), total };
  }
}

/** 行 → 对端展示条目 */
function toReviewItem(row: ReviewRow, side: ReviewSide): ReviewItemDto {
  // 匿名只作用于"别人给我的"这一侧：我给出的评价里，对方是谁是我自己选的
  const anonymous = side === 'received' && row.isAnonymous;
  const peer = side === 'received' ? row.reviewer : row.target;
  return {
    id: row.id,
    orderId: row.orderId,
    rating: row.rating,
    tags: asStringArray(row.tags),
    anonymous,
    nickname: anonymous ? ANONYMOUS_NICKNAME : peer.nickname ?? FALLBACK_NICKNAME,
    createdAt: row.createdAt.toISOString(),
    ...(anonymous ? {} : { peerId: peer.id }),
    ...(row.content ? { content: row.content } : {}),
  };
}
