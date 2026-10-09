import { Injectable } from '@nestjs/common';
import { JobStatus, OrderStatus } from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';

import {
  growthPoint,
  growthWindows,
  startOfToday,
  type GrowthPoint,
} from './admin-dashboard.window';

export interface AdminDashboardStats {
  users: {
    total: number;
    /**
     * 账号状态正常（`status = 'active'`）的用户数，是**账号状态**不是"登录活跃"。
     * ⚠️ 见类注释「为什么没有登录用户数 / 活跃用户数」。
     */
    active: number;
    banned: number;
    newToday: number;
    /** 近 7 个日历日（含今天）注册的用户，窗口口径见 `admin-dashboard.window.ts` */
    newWeek: number;
    /** 近 30 个日历日（含今天）注册的用户 */
    newMonth: number;
    /** 新增用户的日 / 周 / 月环比（微信统计页「指标 + 三期环比」口径） */
    growth: { day: GrowthPoint; week: GrowthPoint; month: GrowthPoint };
  };
  verifications: { pending: number };
  orders: {
    total: number;
    inProgress: number;
    disputed: number;
    completed: number;
    /** 成交额（分）。只统计已完成订单 —— 未完成的钱还在托管里，不是"成交" */
    gmv: number;
    refundedCount: number;
  };
  jobs: { total: number; today: number; failedToday: number; queued: number; running: number };
  tools: { total: number; active: number; planned: number };
  /** 近 7 天作业量 Top 工具（识别"没人用"与"最该盯的"） */
  topTools: { toolName: string; displayName: string; jobs7d: number }[];
  /** 待办提醒：需要人动手的事情汇总，首页顶部直接显示 */
  todos: { pendingVerifications: number; disputedOrders: number; failedJobsToday: number };
}

/** 进行中的订单状态（钱已托管、还没结清） */
const IN_PROGRESS: string[] = [
  OrderStatus.Paid,
  OrderStatus.InService,
  OrderStatus.PendingAcceptance,
  OrderStatus.RefundRequested,
];

/**
 * 数据看板（任务清单 M0-23；本期环比扩展对应 M3-20 · 管理后台）
 *
 * ## 为什么首页不是"各种漂亮的图表"，而是数字 + 待办
 *
 * 后台首页真正要回答的是两件事：**"现在有多少活要干"** 与
 * **"有没有东西在悄悄坏掉"**。前者是 `todos`，后者是 `failedToday`
 * 与近 7 天用量分布。趋势曲线好看，但回答不了这两个问题，
 * 而且要为它引入图表依赖（本项目新增依赖要先登记合规表）。
 *
 * ## `gmv` 只算 `completed`
 *
 * 未完成订单的钱还在平台托管账户里，随时可能退款。把它算进"成交额"
 * 会让数字虚高，且与管理端"放款了多少钱"对不上 —— 那种对不上的数字
 * 最后没人敢用。
 *
 * ## 为什么**没有**「登录用户数 / 活跃用户数」
 *
 * 刻意不做，不是漏做。`auth.service.ts` 在**注册时也会**写 `lastLogin = new Date()`
 * （`login()` 的新用户分支 `createUser()` 里就带着这行），所以
 * `count(lastLogin != null)` 恒等于 `count(*)` ——
 * 把它标成"登录用户数"是一句永远为真的假话，违反红线 10（禁止假数据冒充功能）。
 * 真要"7 日活跃"，需要的是**登录事件流水**（现在没有这张表），而不是给
 * `lastLogin` 换个名字。运营视角的替代指标已经在这里了：`newToday / newWeek /
 * newMonth` 与 `growth`（新增趋势）、`active / banned`（账号状态）。
 * `admin-dashboard.service.spec.ts` 有一条守卫断言：任何查询都不许出现 `lastLogin`。
 */
@Injectable()
export class AdminDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async stats(): Promise<AdminDashboardStats> {
    // `now` 只取一次：三个环比窗口共用同一时刻，日界沿用 `startOfToday()` 的本地时区口径，
    // 这样 `growth.day.current` 与 `newToday` 天然是同一个数（不会出现两个"今日新增"）。
    const now = new Date();
    const todayStart = startOfToday(now);
    const windows = growthWindows(now, todayStart);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

    const [
      userTotal,
      userActive,
      userBanned,
      userNewToday,
      userNewWeek,
      userNewMonth,
      userPrevDay,
      userPrevWeek,
      userPrevMonth,
      pendingVerifications,
      orderTotal,
      orderInProgress,
      orderDisputed,
      orderCompleted,
      orderRefunded,
      gmvAgg,
      jobTotal,
      jobToday,
      jobFailedToday,
      jobQueued,
      jobRunning,
      toolTotal,
      toolActive,
      groupedTools,
    ] = await this.prisma.$transaction([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { status: 'active' } }),
      this.prisma.user.count({ where: { status: 'banned' } }),
      this.prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
      // 本期窗口只写下界（理由见 admin-dashboard.window.ts 文件头）
      this.prisma.user.count({ where: { createdAt: { gte: windows.week.from } } }),
      this.prisma.user.count({ where: { createdAt: { gte: windows.month.from } } }),
      // 上期窗口两端都要闭：它是本期整体前移一个周期得到的等长窗口
      this.prisma.user.count({
        where: { createdAt: { gte: windows.day.prevFrom, lt: windows.day.prevTo } },
      }),
      this.prisma.user.count({
        where: { createdAt: { gte: windows.week.prevFrom, lt: windows.week.prevTo } },
      }),
      this.prisma.user.count({
        where: { createdAt: { gte: windows.month.prevFrom, lt: windows.month.prevTo } },
      }),
      this.prisma.verification.count({ where: { status: 'pending' } }),
      this.prisma.order.count(),
      this.prisma.order.count({ where: { status: { in: IN_PROGRESS } } }),
      this.prisma.order.count({
        where: {
          OR: [{ status: OrderStatus.RefundRequested }, { refundReason: { not: null } }],
        },
      }),
      this.prisma.order.count({ where: { status: OrderStatus.Completed } }),
      this.prisma.order.count({ where: { status: OrderStatus.Refunded } }),
      this.prisma.order.aggregate({
        where: { status: OrderStatus.Completed },
        _sum: { amount: true },
      }),
      this.prisma.toolJob.count(),
      this.prisma.toolJob.count({ where: { createdAt: { gte: todayStart } } }),
      this.prisma.toolJob.count({
        where: { createdAt: { gte: todayStart }, status: JobStatus.Failed },
      }),
      this.prisma.toolJob.count({ where: { status: JobStatus.Queued } }),
      this.prisma.toolJob.count({ where: { status: JobStatus.Running } }),
      this.prisma.tool.count(),
      this.prisma.tool.count({ where: { status: 'active' } }),
      this.prisma.toolJob.groupBy({
        by: ['toolName'],
        where: { createdAt: { gte: weekAgo } },
        _count: { _all: true },
        orderBy: { toolName: 'asc' },
      }),
    ]);

    // 排序放在 JS 里做：`groupBy` 配 `orderBy: { _count: ... }` 时 Prisma 的
    // `_count` 会退化成联合类型（`true | {...}`），读 `_all` 需要额外收窄。
    // 这里只有几十个工具，内存排序更简单也更类型安全。
    const topTools = await this.withDisplayNames(
      groupedTools
        .map((g) => ({ toolName: g.toolName, jobs7d: countOf(g._count) }))
        .sort((a, b) => b.jobs7d - a.jobs7d)
        .slice(0, 8),
    );

    return {
      users: {
        total: userTotal,
        active: userActive,
        banned: userBanned,
        newToday: userNewToday,
        newWeek: userNewWeek,
        newMonth: userNewMonth,
        growth: {
          day: growthPoint(userNewToday, userPrevDay),
          week: growthPoint(userNewWeek, userPrevWeek),
          month: growthPoint(userNewMonth, userPrevMonth),
        },
      },
      verifications: { pending: pendingVerifications },
      orders: {
        total: orderTotal,
        inProgress: orderInProgress,
        disputed: orderDisputed,
        completed: orderCompleted,
        gmv: gmvAgg._sum.amount ?? 0,
        refundedCount: orderRefunded,
      },
      jobs: {
        total: jobTotal,
        today: jobToday,
        failedToday: jobFailedToday,
        queued: jobQueued,
        running: jobRunning,
      },
      tools: { total: toolTotal, active: toolActive, planned: toolTotal - toolActive },
      topTools,
      todos: {
        pendingVerifications,
        disputedOrders: orderDisputed,
        failedJobsToday: jobFailedToday,
      },
    };
  }

  /** 补上工具显示名（groupBy 只回 toolName，用它再去查一次显示名） */
  private async withDisplayNames(
    rows: { toolName: string; jobs7d: number }[],
  ): Promise<{ toolName: string; displayName: string; jobs7d: number }[]> {
    if (rows.length === 0) return [];
    const names = rows.map((r) => r.toolName);
    const tools = await this.prisma.tool.findMany({
      where: { name: { in: names } },
      select: { name: true, displayName: true },
    });
    const labelByName = new Map(tools.map((t) => [t.name, t.displayName]));
    return rows.map((r) => ({
      toolName: r.toolName,
      displayName: labelByName.get(r.toolName) ?? r.toolName,
      jobs7d: r.jobs7d,
    }));
  }
}

/**
 * 收窄 `groupBy` 的 `_count`。
 *
 * Prisma 生成的是 `true | { _all?: number }` 这样的联合类型（取决于是否传了
 * `orderBy`），直接读 `._all` 编译不过。这里统一兜底为 0 —— 计数拿不到时
 * 显示 0 比抛异常更适合看板（看板挂掉会让首页整页白屏）。
 */
function countOf(c: unknown): number {
  if (typeof c === 'number') return c;
  const rec = (c ?? {}) as Record<string, number | undefined>;
  return rec._all ?? rec.toolName ?? 0;
}
