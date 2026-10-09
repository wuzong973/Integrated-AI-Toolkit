import { Injectable } from '@nestjs/common';
import { BizException, ErrorCode, type ServiceListQueryDto } from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';

import {
  SERVICE_INCLUDE,
  toServiceItem,
  ServiceStatus,
  type ServiceItemDto,
} from './dto/service.dto';
import type { ServiceMarketQueryDto } from './dto/service-query.dto';

/**
 * 服务商品 · 读路径（任务清单 M3-04，供 M3-05 服务市场页消费）
 *
 * ## 对应表
 *
 * `service`（服务商品）+ `service_category`（分类，M3-01 已有）。
 * 本模块是 `service` 表的**第一个**读写点 —— 在它之前这张表零流量，
 * 驿站 Tab 的「服务市场」是个占位空态（排查报告 M3-04 行）。
 *
 * ## 三条容易写错的规则
 *
 * ① **市场列表只出 `status='on'`**，且**不给客户端传 status 的口子**。
 *    下架（`off`）的商品出现在大厅 = 用户点了个买不了的卡，
 *    而"下架后不再出现在市场"正是 M3-04 的验收标准。
 *    想看自己的下架商品走 `GET /services/mine`（那条**不限状态**）。
 *    2026-09-19 加了一个 `providerId` 筛选（服务者主页 · M3-05）：
 *    它只把范围缩到"这个人挂出来的服务"，**不放宽状态过滤**（见下方 `listServices`）。
 * ② **详情对非本人只暴露 `on`**：下架商品的直接链接必须 404，
 *    而不是"列表里没有、但把 id 发给别人还能打开"。
 * ③ **分页用 `skip/take`，`total` 是过滤后的总数**：
 *    `total` 若取成本页条数，前端永远算不出还有没有下一页。
 *
 * ## 关键词检索：为什么这一期是 LIKE 而不是全文索引
 *
 * `keyword` 经 Prisma 的 `contains` 生成**参数化** `LIKE ?`（值绑在占位符上，
 * 不拼进 SQL，注入面为零），匹配标题与描述。
 *
 * ⚠️ **`M4-07 搜索升级`目前是个悬空能力**：`MysqlFulltextSearchProvider`（`search_index`
 * 表 + ngram 分词）已实现、也注册进了 `Providers`，但**没有任何业务模块调用
 * `providers.search`**，`search_index` 里连一行数据都没有（`index()` 无调用点），
 * 全库检索也没有 HTTP 入口。所以这里**不能**改成"调 SearchProvider" ——
 * 那会拿到恒定空结果，比 LIKE 更糟。
 * 等 M4-07 把索引写入（上架/改状态时同步 `index()`）与检索入口一起接上时，
 * 本方法的关键词分支换成 `providers.search.search('service', …)`，
 * 上限触发条件见任务清单 A15（任务总量 > 5 万或搜索 P95 > 500ms 才升级 ES）。
 *
 * 数据量层面 LIKE 也够用：驿站是校园场景，商品数在千级；
 * `service` 上已有 `[status, category_id]` 复合索引，先按状态+分类缩小再过滤关键词。
 */
@Injectable()
export class ServiceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 服务市场列表（公开）。只返回已上架的商品，按更新时间倒序 ——
   * 新上架与最近有过变化的排在前面，冷启动时大厅不至于只剩几条老数据。
   *
   * `providerId` 是给**服务者主页**（M3-05）用的"看这个人挂出来的服务"：
   * 它只是把范围缩小，**不会放宽状态过滤** —— 下架与草稿仍然出不来，
   * 所以拿别人的 id 也看不到任何不该看的东西（自己的下架商品走 `GET /services/mine`）。
   */
  async listServices(query: ServiceMarketQueryDto): Promise<ServicePage> {
    const providerId = query.providerId?.trim();
    return this.page(query, {
      status: ServiceStatus.On,
      ...(providerId ? { providerId } : {}),
    });
  }

  /**
   * 我上架的服务（含 `off`）。
   *
   * **不限状态**：服务者下架后要能找回它、再上架。
   * 若这里也默认筛 `on`，下架的商品就"消失"了 —— 列表空着，
   * 而用户以为是自己删掉了（这条在驿站「我的任务」上踩过同样的坑）。
   */
  async listMine(providerId: string, query: ServiceListQueryDto): Promise<ServicePage> {
    return this.page(query, { providerId });
  }

  /**
   * 服务详情（公开只读）。
   *
   * `viewerId` 是**可选**的：未登录也能浏览（M3-05 的入口在驿站 Tab 上，
   * 强制登录只会把用户挡在看见价值之前）。
   * 已下架的商品只有本人打得开 —— 别人拿到 id 也是 404。
   */
  async getService(id: string, viewerId?: string): Promise<ServiceItemDto> {
    const row = await this.prisma.service.findUnique({ where: { id }, include: SERVICE_INCLUDE });
    if (!row) throw new BizException(ErrorCode.NotFound, undefined, '服务不存在或已被删除');
    if (row.status !== ServiceStatus.On && row.providerId !== viewerId) {
      throw new BizException(ErrorCode.NotFound, undefined, '该服务已下架');
    }

    // 浏览量是尽力而为：统计写失败不该让用户看不到详情（与驿站任务详情同一处理）
    await this.prisma.service
      .update({ where: { id }, data: { viewCount: { increment: 1 } } })
      .catch(() => undefined);

    return toServiceItem(row);
  }

  // ---------- 内部 ----------

  /** 列表与「我的」共用同一套分页 / 筛选逻辑，只差一个基础 where */
  private async page(
    query: ServiceListQueryDto,
    base: Record<string, unknown>,
  ): Promise<ServicePage> {
    const where = { ...base, ...filterOf(query) };
    const skip = (query.page - 1) * query.pageSize;

    const [rows, total] = await Promise.all([
      this.prisma.service.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: query.pageSize,
        include: SERVICE_INCLUDE,
      }),
      this.prisma.service.count({ where }),
    ]);
    return { list: rows.map(toServiceItem), total };
  }
}

/** 分页响应（文档 9.1：`{ list, total }`，客户端据此算总页数） */
export interface ServicePage {
  list: ServiceItemDto[];
  total: number;
}

/** 分类 / 关键词两个可选条件。空串按"没传"处理，避免 `LIKE '%%'` 白扫一遍 */
function filterOf(query: ServiceListQueryDto): Record<string, unknown> {
  const keyword = query.keyword?.trim();
  return {
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(keyword
      ? { OR: [{ title: { contains: keyword } }, { description: { contains: keyword } }] }
      : {}),
  };
}
