import { Injectable } from '@nestjs/common';
import {
  BizException,
  ErrorCode,
  TaskStatus,
  asStringArray,
  isDemoTaskNo,
  type MatchResult,
  type TaskListQueryDto,
} from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';

import { StationMatchService } from './station-match.service';

/** 任务条目（字段与 apps/mp/utils/api.ts 的 TaskItem 一一对应） */
export interface TaskItemDto {
  id: string;
  taskNo: string;
  title: string;
  description: string;
  /** 预算，单位**分**（金额一律用分，见红线） */
  budget: number;
  budgetType: string;
  deadline?: string;
  location?: string;
  skillTags: string[];
  status: string;
  source: string;
  applyCount: number;
  createdAt: string;
  /** 发布者摘要（大厅列表要显示"谁发的"与信用分） */
  publisher?: { id: string; nickname: string; creditScore: number };
  /**
   * 是否为**示例数据**（seed 写入的任务）。
   *
   * 服务端判定后下发，而不是让客户端去猜 `taskNo` 前缀 ——
   * 判据只维护一份（`@qz/core` 的 `isDemoTaskNo`），
   * 客户端只负责"看到 true 就显示角标"（红线 10）。
   */
  isDemo: boolean;
  /**
   * 与**当前登录用户**的匹配度（0~100）。未登录时不下发。
   *
   * ⚠️ 这个字段曾经是客户端编的（工作台用 `Math.max(60, 95 - i * 7)` 按序号递减），
   * 以"匹配度 95%"的形式展示给服务者 —— 用户无法分辨它是算出来的还是编的。
   * 现在由 `@qz/core` 的 `calcMatchScore` 真实计算，`matchReasons` 给出依据。
   */
  matchScore?: number;
  /** 为什么是这个分（如"技能命中 2/3：摄影、后期修图"） */
  matchReasons?: string[];
}

/**
 * 驿站 · 任务（任务清单 M3 的**只读切片**）
 *
 * ## 为什么先做只读、而不是整个驿站模块
 *
 * 小程序端 `stationApi` 的契约已冻结（`apps/mp/utils/api.ts`），首页与驿站 Tab
 * 在页面加载时就会请求 `GET /station/tasks`。该接口未实现时控制台会持续报 404 ——
 * 这会掩盖真正的错误，也让"驿站"看起来坏了。
 *
 * 本模块只实现**读**（任务大厅列表 + 任务详情），因为：
 *   · 它们是无副作用的公开只读接口，语义清晰、风险最低；
 *   · 足以让首页「热门任务」与驿站 Tab 正常渲染。
 * 写路径（发布 / 编辑 / 关闭 / 报名 / 选定 / AI 解析 / 智能匹配）仍然**未实现**，
 * 按 M3 里程碑推进 —— 那些涉及状态机、担保交易与通知，必须整块做（红线 9：
 * 宁可显示"未接入"，也不假装支持）。
 *
 * ## 两个实现细节
 *
 * ① **默认只返回已发布**：任务大厅的语义就是"可接的活"，草稿与审核中的需求
 *    出现在大厅是产品事故（用户会看到别人没写完的草稿）。要查其它状态必须显式传。
 * ② **关键词搜索用 LIKE 而非全文索引**：当前数据量（校园内几百条）下完全够用，
 *    引入 MySQL 全文索引需要额外迁移与分词策略；等有真实数据量再优化，
 *    而不是现在就为不存在的规模付复杂度成本。
 */
@Injectable()
export class StationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly match: StationMatchService,
  ) {}

  /**
   * 任务大厅。
   *
   * `viewerId` 有值时（带 token 的请求）会给每条任务附上**真实匹配度** ——
   * 服务者端据此排序"推荐给你的任务"，大厅也能按匹配度解释"为什么推给我"。
   * 未登录时不下发该字段，而不是下发一个 0 或平均值冒充。
   */
  async listTasks(
    query: TaskListQueryDto,
    viewerId?: string,
  ): Promise<{ list: TaskItemDto[]; total: number }> {
    const where = buildWhere(query, viewerId);
    const [rows, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.size,
        take: query.size,
        include: PUBLISHER_INCLUDE,
      }),
      this.prisma.task.count({ where }),
    ]);

    const list = rows.map(toTaskItem);
    if (!viewerId) return { list, total };

    const scores = await this.match.scoreTasks(viewerId, rows);
    return { list: list.map((item) => attachMatch(item, scores.get(item.id))), total };
  }

  /**
   * 任务详情（公开只读）。
   * 浏览量 +1 是**尽力而为**：统计失败不该让用户看不到任务详情。
   */
  async getTask(id: string, viewerId?: string): Promise<TaskItemDto> {
    const task = await this.prisma.task.findUnique({ where: { id }, include: PUBLISHER_INCLUDE });
    if (!task) {
      throw new BizException(ErrorCode.NotFound, undefined, '任务不存在或已下架');
    }

    await this.prisma.task
      .update({ where: { id }, data: { viewCount: { increment: 1 } } })
      .catch(() => undefined);

    const item = toTaskItem(task);
    if (!viewerId) return item;

    const scores = await this.match.scoreTasks(viewerId, [task]);
    return attachMatch(item, scores.get(item.id));
  }

  /**
   * 某条需求的报名者列表（**仅发布者可见**）。
   *
   * ## 为什么必须由服务端出这个接口
   *
   * 任务详情页的"报名情况"此前**恒为空** —— `applications` 从来没有被任何接口填充过，
   * 于是发布者永远看到"还没有人报名"。这比报错更糟：
   * 有人报名了，而发布者以为没人来，需求就一直挂在那里。
   *
   * ## 为什么只给发布者看
   *
   * 报名留言是服务者写给**发布者**的（可能含报价与联系方式），
   * 对其他用户公开等于把服务者的议价空间摊在明面上。
   */
  async listApplications(userId: string, taskId: string): Promise<ApplicationItemDto[]> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { publisherId: true },
    });
    if (!task) throw new BizException(ErrorCode.NotFound, undefined, '任务不存在或已下架');
    if (task.publisherId !== userId) {
      throw new BizException(ErrorCode.NoPermission, undefined, '只有发布者可以查看报名情况');
    }

    const rows = await this.prisma.taskApplication.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
      include: { provider: { select: PROVIDER_INCLUDE } },
    });

    const scores = await this.match.scoreForTask(
      taskId,
      rows.map((r) => r.providerId),
    );
    return rows.map((r) => toApplicationItem(r, scores.get(r.providerId)));
  }

  /**
   * 服务分类（M3-01）。
   *
   * 读库而不是把 9 个分类写死在前端：分类是运维可改的数据，
   * 写死在两端就一定会漂移（`check:categories` 守卫的存在正说明这曾经是个真问题）。
   */
  async categories(): Promise<{ id: string; name: string; icon?: string }[]> {
    const rows = await this.prisma.serviceCategory.findMany({
      orderBy: { sort: 'asc' },
      select: { id: true, name: true, icon: true },
    });
    return rows.map((r) => ({ id: r.id, name: r.name, icon: r.icon ?? undefined }));
  }
}

/** 报名者条目（发布者视角：谁报了、报价多少、匹配度多高） */
export interface ApplicationItemDto {
  id: string;
  providerId: string;
  nickname: string;
  avatar?: string;
  creditScore: number;
  completedOrders: number;
  /** 报价，单位**分**；0 表示未报价 */
  quote: number;
  message?: string;
  status: string;
  createdAt: string;
  matchScore?: number;
  matchReasons?: string[];
}

/**
 * 发布者摘要。
 *
 * 信用分在 `UserProfile` 上、校区在 `School` 上（都不在 `User` 表），必须一起带出来。
 * `schoolId` 与 `school.city` 是**匹配算法算距离用的**（同校满分 / 同城次之），
 * 少了它们匹配度里的距离项会恒为 0 —— 而"匹配度偏低"看起来像算法问题，不像缺字段。
 */
const PUBLISHER_INCLUDE = {
  publisher: {
    select: {
      id: true,
      nickname: true,
      schoolId: true,
      school: { select: { city: true } },
      profile: { select: { creditScore: true } },
    },
  },
} as const;

/** 组装查询条件 */
function buildWhere(query: TaskListQueryDto, viewerId?: string) {
  const keyword = query.keyword?.trim();
  /**
   * 默认状态的语义**取决于看不看"我的"**：
   *   · 大厅（无 role）—— 只看 `published`，草稿与已关闭的不该出现在可接列表里；
   *   · 我的任务（有 role）—— 不限状态，否则"我接的单"会因为默认筛 `published` 而恒空，
   *     而"列表是空的"看起来像"我确实没接过单"，不会让人怀疑是筛选条件写错了。
   */
  const status = query.status ?? (query.role ? undefined : TaskStatus.Published);

  return {
    ...(status ? { status } : {}),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(keyword
      ? { OR: [{ title: { contains: keyword } }, { description: { contains: keyword } }] }
      : {}),
    ...mine(query, viewerId),
  };
}

/**
 * "只看与我相关"的条件。
 *
 * ⚠️ 未登录却传了 `role` 时**直接报 401**，而不是静默忽略该条件 ——
 * 静默忽略会让客户端以为筛过了，实际拿到的是**全站数据**。
 * 工作台曾经正是这样：用 `status=assigned` 当"我的任务"，
 * 于是别人接的单出现在我的工作台上（越权看到他人订单，且看不出是错的）。
 */
function mine(query: TaskListQueryDto, viewerId?: string) {
  if (!query.role) return {};
  if (!viewerId) {
    throw new BizException(ErrorCode.Unauthorized, undefined, '查看「我的任务」需要先登录');
  }
  return query.role === 'publisher'
    ? { publisherId: viewerId }
    : { selectedProviderId: viewerId };
}

/** 把匹配结果并进条目。没有结果（如未登录）时原样返回，不下发占位值 */
function attachMatch(item: TaskItemDto, result: MatchResult | undefined): TaskItemDto {
  if (!result) return item;
  return { ...item, matchScore: result.score, matchReasons: result.reasons };
}

/** 报名者摘要的字段（信用分与完成数在 `UserProfile` 上，必须一起带出来） */
const PROVIDER_INCLUDE = {
  id: true,
  nickname: true,
  avatar: true,
  profile: { select: { creditScore: true, completedOrders: true } },
} as const;

/** 报名行 → 对端条目 */
function toApplicationItem(
  row: {
    id: string;
    providerId: string;
    quote: number;
    message: string | null;
    status: string;
    createdAt: Date;
    provider: {
      id: string;
      nickname: string | null;
      avatar: string | null;
      profile: { creditScore: number; completedOrders: number } | null;
    };
  },
  result: MatchResult | undefined,
): ApplicationItemDto {
  return {
    id: row.id,
    providerId: row.providerId,
    nickname: row.provider.nickname ?? '同学',
    ...(row.provider.avatar ? { avatar: row.provider.avatar } : {}),
    creditScore: row.provider.profile?.creditScore ?? 0,
    completedOrders: row.provider.profile?.completedOrders ?? 0,
    quote: row.quote,
    ...(row.message ? { message: row.message } : {}),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    ...(result ? { matchScore: result.score, matchReasons: result.reasons } : {}),
  };
}

/** 行 → 对端条目（`StationWriteService` 发布后也用它，避免两处形状漂移） */
export function toTaskItem(row: {
  id: string;
  taskNo: string;
  title: string;
  description: string;
  budget: number;
  budgetType: string;
  deadline: Date | null;
  location: string | null;
  skillTags: unknown;
  status: string;
  source: string;
  applyCount: number;
  createdAt: Date;
  publisher?: {
    id: string;
    nickname: string | null;
    profile: { creditScore: number } | null;
  } | null;
}): TaskItemDto {
  return {
    id: row.id,
    taskNo: row.taskNo,
    title: row.title,
    description: row.description,
    budget: row.budget,
    budgetType: row.budgetType,
    deadline: row.deadline?.toISOString(),
    location: row.location ?? undefined,
    // JSON 列在不同 MySQL 客户端下可能返回字符串，统一走 core 的容错解析
    skillTags: asStringArray(row.skillTags),
    status: row.status,
    source: row.source,
    applyCount: row.applyCount,
    createdAt: row.createdAt.toISOString(),
    // 红线 10：示例数据必须可辨识。判定放在服务端，客户端只管展示角标
    isDemo: isDemoTaskNo(row.taskNo),
    ...(row.publisher
      ? {
          publisher: {
            id: row.publisher.id,
            nickname: row.publisher.nickname ?? '同学',
            creditScore: row.publisher.profile?.creditScore ?? 0,
          },
        }
      : {}),
  };
}
