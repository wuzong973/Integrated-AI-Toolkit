import { Injectable } from '@nestjs/common';
import {
  BizException,
  ErrorCode,
  OrderStatus,
  Role,
  asStringArray,
  calcMatchScore,
  type MatchCandidate,
  type MatchResult,
  type MatchTask,
} from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * 候选服务者扫描上限。
 *
 * 校园场景下服务者规模是几十到几百，全量评分完全可行；
 * 但"完全可行"不该写成"无上限"—— 不加上限的话，一旦数据长起来，
 * 这个接口会变成一次全表扫描 + 内存排序，而它挂在**任务详情页**上，
 * 是用户每次打开都会走的路径。
 */
const CANDIDATE_LIMIT = 200;

/** 推荐服务者条目（发布者视角） */
export interface MatchedProviderDto {
  userId: string;
  nickname: string;
  avatar?: string;
  skills: string[];
  creditScore: number;
  completedOrders: number;
  /** 匹配度 0~100（真实算法，非估算） */
  score: number;
  /** 为什么是这个分 */
  reasons: string[];
}

/** 参与匹配所需的全部事实（查一次，复用给所有任务/候选） */
interface Facts {
  skills: string[];
  creditScore: number;
  completedOrders: number;
  canceledOrders: number;
  avgPriceCents: number;
  schoolId: string | null;
  city: string | null;
  lastActiveAt: Date | null;
}

/** 可被评分的任务（调用方需带上发布者的校区信息） */
export interface ScorableTask {
  id: string;
  skillTags: unknown;
  budget: number;
  publisher: { schoolId: string | null; school: { city: string | null } | null } | null;
}

/**
 * 驿站智能匹配（任务清单 M3-09，设计文档 6.6.2）。
 *
 * ## 两个方向，一个算法
 *
 *   · **发布者视角**（`matchProviders`）：为这条任务找合适的服务者 —— 发布后展示 TopN；
 *   · **服务者视角**（`scoreTasks`）：为当前用户算一批任务的匹配度 —— 大厅与工作台排序。
 *
 * 两边的分数都来自 `@qz/core` 的 `calcMatchScore`（纯函数、有单测）。
 * 之所以不让客户端算：那正是**假匹配度的来源**（工作台曾用
 * `Math.max(60, 95 - i * 7)` 按列表序号递减），而且客户端拿不到信用分与历史成交数据。
 *
 * ## 查询纪律：批量取事实，不做 N+1
 *
 * 候选服务者最多 200 个，逐个查"信用分 + 历史订单"会打出 400 次查询。
 * 所以订单统计走**一次 `groupBy(providerId, status)`**，画像走一次 `findMany`。
 */
@Injectable()
export class StationMatchService {
  constructor(private readonly prisma: PrismaService) {}

  /** 为任务推荐服务者（按匹配度降序） */
  async matchProviders(taskId: string, limit: number): Promise<MatchedProviderDto[]> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, skillTags: true, budget: true, publisherId: true },
    });
    if (!task) throw new BizException(ErrorCode.NotFound, undefined, '任务不存在或已下架');

    const ids = await this.candidateIds();
    // 自己不能给自己干活 —— 发布者不进候选
    const candidates = ids.filter((id) => id !== task.publisherId);
    if (!candidates.length) return [];

    const [facts, briefs, publisher] = await Promise.all([
      this.loadFactsBatch(candidates),
      this.loadBriefs(candidates),
      this.loadFacts(task.publisherId),
    ]);

    const matchTask: MatchTask = {
      skillTags: asStringArray(task.skillTags),
      budget: task.budget,
    };
    const now = new Date();

    // 用显式循环而不是 `.map().filter().sort()` 链：过滤掉 `null` 需要类型谓词，
    // 而谓词要求目标类型与推导类型**完全一致**，`avatar?: string` 这类可选字段
    // 会让它悄悄变成"不可赋值"。循环里判空最直白，也不会被类型体操绊住。
    const scored: MatchedProviderDto[] = [];
    for (const id of candidates) {
      const f = facts.get(id);
      const brief = briefs.get(id);
      if (!f || !brief) continue;

      const result = calcMatchScore(matchTask, toCandidate(id, f, publisher), now);
      scored.push({
        userId: id,
        nickname: brief.nickname ?? '同学',
        ...(brief.avatar ? { avatar: brief.avatar } : {}),
        skills: f.skills,
        creditScore: f.creditScore,
        completedOrders: f.completedOrders,
        score: result.score,
        reasons: result.reasons,
      });
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * 为一组**指定的**服务者算对某条任务的匹配度（报名者列表用）。
   *
   * 与 `matchProviders` 的区别：那个是从**全站候选池**里挑最合适的；
   * 这个是给"已经报名的人"打分。发布者选定服务者时，
   * 名单来自报名表而不是推荐池 —— 不能因为某人没被推荐就看不见他的分数。
   */
  async scoreForTask(taskId: string, providerIds: string[]): Promise<Map<string, MatchResult>> {
    const out = new Map<string, MatchResult>();
    if (!providerIds.length) return out;

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { skillTags: true, budget: true, publisherId: true },
    });
    if (!task) return out;

    const [facts, publisher] = await Promise.all([
      this.loadFactsBatch(providerIds),
      this.loadFacts(task.publisherId),
    ]);

    const matchTask: MatchTask = {
      skillTags: asStringArray(task.skillTags),
      budget: task.budget,
    };
    const now = new Date();

    for (const id of providerIds) {
      const f = facts.get(id);
      if (!f) continue;
      out.set(id, calcMatchScore(matchTask, toCandidate(id, f, publisher), now));
    }
    return out;
  }

  /**
   * 为当前用户算一批任务的匹配度（服务者视角）。
   *
   * 返回 `taskId → 结果`。任务列表里没有标签、预算为 0 也能算 ——
   * 那两项会走中性分，而不是让整个列表因为一条脏数据而算不出来。
   */
  async scoreTasks(userId: string, tasks: ScorableTask[]): Promise<Map<string, MatchResult>> {
    const out = new Map<string, MatchResult>();
    if (!tasks.length) return out;

    const me = await this.loadFacts(userId);
    const now = new Date();

    for (const t of tasks) {
      const other = {
        schoolId: t.publisher?.schoolId ?? null,
        city: t.publisher?.school?.city ?? null,
      };
      out.set(
        t.id,
        calcMatchScore(
          { skillTags: asStringArray(t.skillTags), budget: t.budget },
          toCandidate(userId, me, other),
          now,
        ),
      );
    }
    return out;
  }

  // ---------- 内部：数据装载 ----------

  /** 有服务者身份且**开着接单开关**的用户 id */
  private async candidateIds(): Promise<string[]> {
    const roles = await this.prisma.userRole.findMany({
      where: { role: Role.Provider, status: 'active' },
      select: { userId: true },
      take: CANDIDATE_LIMIT,
    });
    const ids = roles.map((r) => r.userId);
    if (!ids.length) return [];

    // 关掉接单开关的人不该被推荐 —— 推给他只会让发布者白等
    const profiles = await this.prisma.userProfile.findMany({
      where: { userId: { in: ids }, acceptOrders: true },
      select: { userId: true },
    });
    return profiles.map((p) => p.userId);
  }

  /** 单个用户的事实 */
  private async loadFacts(userId: string): Promise<Facts> {
    const [facts, user] = await Promise.all([
      this.loadFactsBatch([userId]),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { schoolId: true, school: { select: { city: true } } },
      }),
    ]);
    return {
      ...(facts.get(userId) ?? EMPTY_FACTS),
      schoolId: user?.schoolId ?? null,
      city: user?.school?.city ?? null,
    };
  }

  /** 批量事实：画像一次、订单统计一次 */
  private async loadFactsBatch(ids: string[]): Promise<Map<string, Facts>> {
    const out = new Map<string, Facts>();
    if (!ids.length) return out;

    const [profiles, stats] = await Promise.all([
      this.prisma.userProfile.findMany({ where: { userId: { in: ids } } }),
      this.orderStats(ids),
    ]);

    for (const id of ids) {
      const p = profiles.find((x) => x.userId === id);
      const s = stats.get(id);
      out.set(id, {
        skills: asStringArray(p?.skills),
        creditScore: p?.creditScore ?? EMPTY_FACTS.creditScore,
        completedOrders: p?.completedOrders ?? 0,
        canceledOrders: s?.canceled ?? 0,
        avgPriceCents: s?.avgPrice ?? 0,
        schoolId: null,
        city: null,
        lastActiveAt: p?.lastActiveAt ?? null,
      });
    }
    return out;
  }

  /** 昵称 / 头像（评分只需要 id，展示才需要这两个） */
  private async loadBriefs(
    ids: string[],
  ): Promise<Map<string, { nickname: string | null; avatar: string | null }>> {
    const rows = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, nickname: true, avatar: true },
    });
    return new Map(rows.map((r) => [r.id, { nickname: r.nickname, avatar: r.avatar }]));
  }

  /**
   * 一次 `groupBy` 拿到"完成数 / 取消数 / 完成总额"。
   *
   * 完成率与均价都只算**已完结**的订单：进行中的单还没结果，
   * 算进去等于用"还没做完"去评价"做得怎么样"。
   */
  private async orderStats(
    ids: string[],
  ): Promise<Map<string, { canceled: number; avgPrice: number }>> {
    const out = new Map<string, { canceled: number; avgPrice: number }>();
    if (!ids.length) return out;

    const rows = await this.prisma.order.groupBy({
      by: ['providerId', 'status'],
      where: { providerId: { in: ids } },
      _count: { _all: true },
      _sum: { amount: true },
    });

    const acc = new Map<string, { canceled: number; done: number; amount: number }>();
    for (const r of rows) {
      const cur = acc.get(r.providerId) ?? { canceled: 0, done: 0, amount: 0 };
      if (r.status === OrderStatus.Completed) {
        cur.done += r._count._all;
        cur.amount += r._sum.amount ?? 0;
      } else if (r.status === OrderStatus.Canceled || r.status === OrderStatus.Refunded) {
        cur.canceled += r._count._all;
      }
      acc.set(r.providerId, cur);
    }

    for (const [id, v] of acc) {
      out.set(id, {
        canceled: v.canceled,
        avgPrice: v.done > 0 ? Math.round(v.amount / v.done) : 0,
      });
    }
    return out;
  }
}

/** 无画像时的兜底（信用分默认 80，与 `user_profile.credit_score` 的默认值一致） */
const EMPTY_FACTS: Facts = {
  skills: [],
  creditScore: 80,
  completedOrders: 0,
  canceledOrders: 0,
  avgPriceCents: 0,
  schoolId: null,
  city: null,
  lastActiveAt: null,
};

/** 事实 + 对手方位置 → core 的候选结构 */
function toCandidate(
  userId: string,
  f: Facts,
  other: { schoolId: string | null; city: string | null },
): MatchCandidate {
  return {
    userId,
    skills: f.skills,
    creditScore: f.creditScore,
    completedOrders: f.completedOrders,
    canceledOrders: f.canceledOrders,
    avgPriceCents: f.avgPriceCents,
    sameSchool: !!f.schoolId && f.schoolId === other.schoolId,
    sameCity: !!f.city && f.city === other.city,
    lastActiveAt: f.lastActiveAt,
  };
}
