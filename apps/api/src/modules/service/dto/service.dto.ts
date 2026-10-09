import { asStringArray, type ServiceStatusValue } from '@qz/core';

/**
 * 服务商品 · 对外形状与行映射（任务清单 M3-04）
 *
 * ## 为什么单独一个文件
 *
 * 读路径（`ServiceService`）与写路径（`ServiceWriteService`）**都要**把 Prisma 行
 * 转成同一份对端形状。写两遍就一定会漂移 —— 漂移的表现是"列表字段齐、详情少字段"
 * 这类不报错的差异。所以形状与映射只在这里有一份（驿站模块的 `toTaskItem` 同理）。
 *
 * ## 两个刻意的设计
 *
 * ① **评分均值无评价时是 `null`，不是 0**：0 在服务卡上读起来像"有人打了 0 分"，
 *    而"还没有人评价"与"口碑很差"是两种完全不同的处境。
 * ② **可空字段用条件展开**，不往对端对象里写 `null`（前端 `data.cover ? …` 判空
 *    与判 `undefined` 行为不同，小程序侧 WXML 里 `{{cover}}` 为 null 会渲染出 "null"）。
 */

/**
 * `service.status` 的取值常量。
 *
 * `satisfies` 不是形式主义：它既让 `ServiceStatus.On` 保留字面量类型
 * （状态机迁移表要用它当键），又保证每个值都在 core 的值域 `SERVICE_STATUSES` 里 ——
 * 手抖写成 `'one'` 会编译失败，而不是变成一条查不出也改不掉的状态。
 */
export const ServiceStatus = {
  Draft: 'draft',
  On: 'on',
  Off: 'off',
} as const satisfies Record<'Draft' | 'On' | 'Off', ServiceStatusValue>;

/** 状态的用户可见说法（报错文案要说清"现在是什么状态"，而不是只说"不允许"） */
export const SERVICE_STATUS_LABEL: Record<ServiceStatusValue, string> = {
  draft: '草稿',
  on: '已上架',
  off: '已下架',
};

/** 服务者摘要：服务卡与详情页都要显示"谁在提供、靠不靠谱" */
export interface ServiceProviderDto {
  id: string;
  nickname: string;
  avatar?: string;
  /**
   * 评分均值（1~5，保留一位小数）；**还没有人评价时为 `null`**。
   *
   * ⚠️ 数据源是 `user_profile.rating_sum / rating_count`，`seed.ts` 给示例服务者写了值
   * （58/12 → 4.8），但**线上没有任何累加方** —— 评价写入（M3-16）还没开工（`review` 表零接口）。
   * 所以真实用户的服务卡会一直显示"暂无评价"，这是**如实**而不是 bug；
   * 但别误读成"评分已经通了"。M3-16 落地时在评价提交处累加这两列
   * （或改成按 `review` 聚合），否则这条链路永远只有演示数据能动。
   */
  rating: number | null;
  ratingCount: number;
  creditScore: number;
  /** 该服务者累计成交单数（来自 `user_profile.completed_orders`） */
  completedOrders: number;
}

/** 服务商品条目（列表与详情同形状；列表少用不到任何额外字段，故不拆两份） */
export interface ServiceItemDto {
  id: string;
  title: string;
  description: string;
  cover?: string;
  /** 价格，单位**分**（红线：金额一律整数分，禁止浮点） */
  price: number;
  /** `fixed` 一口价 / `hourly` 按小时 / `negotiable` 面议 */
  priceUnit: string;
  /** 交付周期（天） */
  deliveryDays: number;
  /** `school` 校内 / `city` 同城 / `remote` 远程 */
  serviceArea: string;
  skillTags: string[];
  status: string;
  categoryId: string;
  categoryName?: string;
  /**
   * **本商品**的成交单数（`service.order_count`，与服务者的累计成交数不是一回事）。
   *
   * ⚠️ 这一列同样**没有累加方**：`POST /orders` 虽然能把订单挂到 `serviceId` 上
   * （`OrderService.createInTx` 已存该字段），但订单完成时没人回写 `order_count`。
   * 本期如实下发库里的值（新上架恒 0），不拿 `orderCount || completedOrders` 冒充热度 ——
   * 那属于红线 10 的"看着像有数据"。接线点在 M3-14 验收/完成那一支，见任务报告。
   */
  orderCount: number;
  viewCount: number;
  createdAt: string;
  updatedAt: string;
  provider: ServiceProviderDto;
}

/**
 * `prisma.service.findMany({ include: SERVICE_INCLUDE })` 返回行的结构。
 *
 * 写成手写接口而不是 `Prisma.ServiceGetPayload<…>`：单测里的 FakePrisma
 * 要能构造出同形状的行（驿站模块就是这么测的），而生成的 Payload 类型
 * 会把测试和某个特定 Prisma 版本锁死。
 */
export interface ServiceRow {
  id: string;
  title: string;
  description: string;
  cover: string | null;
  price: number;
  priceUnit: string;
  deliveryDays: number;
  serviceArea: string;
  /** JSON 列：读出来可能是数组，也可能被写成别的形态，统一走 `asStringArray` 容错 */
  skillTags: unknown;
  status: string;
  orderCount: number;
  viewCount: number;
  categoryId: string;
  createdAt: Date;
  updatedAt: Date;
  provider: {
    id: string;
    nickname: string | null;
    avatar: string | null;
    profile: {
      creditScore: number;
      completedOrders: number;
      ratingSum: number;
      ratingCount: number;
    } | null;
  } | null;
  category?: { id: string; name: string } | null;
}

/** 列表/详情统一带的关联字段。评分与成交数在 `user_profile` 上，必须一起带出来 */
export const SERVICE_INCLUDE = {
  provider: {
    select: {
      id: true,
      nickname: true,
      avatar: true,
      profile: {
        select: {
          creditScore: true,
          completedOrders: true,
          ratingSum: true,
          ratingCount: true,
        },
      },
    },
  },
  category: { select: { id: true, name: true } },
} as const;

/** 行 → 对端条目 */
export function toServiceItem(row: ServiceRow): ServiceItemDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    ...(row.cover ? { cover: row.cover } : {}),
    price: row.price,
    priceUnit: row.priceUnit,
    deliveryDays: row.deliveryDays,
    serviceArea: row.serviceArea,
    skillTags: asStringArray(row.skillTags),
    status: row.status,
    categoryId: row.categoryId,
    ...(row.category ? { categoryName: row.category.name } : {}),
    orderCount: row.orderCount,
    viewCount: row.viewCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    provider: toProviderSummary(row),
  };
}

/**
 * 服务者摘要。
 *
 * 单独一个函数有两个原因：一是市场列表与服务者主页都要它（M3-05 的服务者主页
 * 直接复用，不必再拼一次），二是可空字段的回落逻辑集中在一处才不会两种口径。
 */
export function toProviderSummary(row: Pick<ServiceRow, 'provider'>): ServiceProviderDto {
  const provider = row.provider;
  const profile = provider?.profile;
  // `providerId` 是必填外键（级联删除），带不出 provider 只可能是数据异常；
  // 这种情况给空串而不是编一个 id —— 空串在客户端显示不出来，
  // 而一个假 id 会让"点进服务者主页"变成一条静默的 404。
  return {
    id: provider?.id ?? '',
    nickname: provider?.nickname ?? '同学',
    ...(provider?.avatar ? { avatar: provider.avatar } : {}),
    rating: avgRating(profile?.ratingSum ?? 0, profile?.ratingCount ?? 0),
    ratingCount: profile?.ratingCount ?? 0,
    creditScore: profile?.creditScore ?? 0,
    completedOrders: profile?.completedOrders ?? 0,
  };
}

/** 评分均值：保留一位小数；没有评价时返回 `null`（不是 0 分） */
export function avgRating(ratingSum: number, ratingCount: number): number | null {
  if (ratingCount <= 0) return null;
  return Math.round((ratingSum / ratingCount) * 10) / 10;
}
