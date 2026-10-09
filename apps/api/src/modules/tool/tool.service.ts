import { Injectable } from '@nestjs/common';
import { BizException, ErrorCode, type ToolListQueryDto } from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';

/** 工具箱分类（对齐 apps/mp/utils/api.ts 的 ToolCategoryItem，并补充 toolCount） */
export interface ToolCategoryItem {
  id: string;
  name: string;
  icon: string | null;
  scene: string;
  /** 该分类下用户可见的工具数，供工具箱左侧导航显示 (n) */
  toolCount: number;
}

/** 工具条目（对齐 apps/mp/utils/api.ts 的 ToolItem） */
export interface ToolItem {
  name: string;
  displayName: string;
  categoryId: string;
  description: string;
  price: number;
  status: string;
  sync: boolean;
  useCount: number;
  requiresCopyrightAck: boolean;
}

/** 工具详情：在 ToolItem 基础上补表单渲染与配额所需字段 */
export interface ToolDetail extends ToolItem {
  inputSchema: unknown;
  outputSchema: unknown;
  timeoutSec: number;
  dailyQuota: number;
  version: string;
  /** false = Agent 内部工具，不进工具箱 UI（M1-02 调用时会再做权限校验） */
  visible: boolean;
}

/**
 * 工具目录服务（任务清单 M1-01）
 *
 * 只负责"读目录"：分类、列表、详情。
 * 调用入口（POST /tools/{name}/invoke）属 M1-02，本模块暂不涉及。
 *
 * 可见性规则：`visible=false` 的分类与工具是 Agent 在编排中调用的内部能力
 * （create_task / parse_requirement / search_knowledge / moderate_content 等），
 * 默认不出现在目录里；传 includeInternal=true 时才返回，供后台与 Tool Registry 使用。
 */
@Injectable()
export class ToolService {
  constructor(private readonly prisma: PrismaService) {}

  /** 分类列表（仅用户可见分类），按 sort 升序 */
  async listCategories(): Promise<ToolCategoryItem[]> {
    const categories = await this.prisma.toolCategory.findMany({
      where: { visible: true },
      orderBy: { sort: 'asc' },
      include: {
        _count: { select: { tools: { where: { visible: true } } } },
      },
    });

    return categories.map((c) => ({
      id: c.id,
      name: c.name,
      icon: c.icon,
      scene: c.scene,
      toolCount: c._count.tools,
    }));
  }

  /** 工具列表：支持分类筛选与关键词搜索 */
  async listTools(query: ToolListQueryDto): Promise<ToolItem[]> {
    const tools = await this.prisma.tool.findMany({
      where: buildToolWhere(query),
      orderBy: [{ categoryId: 'asc' }, { sort: 'asc' }],
    });
    return tools.map(toToolItem);
  }

  /** 工具详情（含 inputSchema，用于执行页动态渲染表单） */
  async getTool(name: string): Promise<ToolDetail> {
    const tool = await this.prisma.tool.findUnique({ where: { name } });
    if (!tool) {
      throw new BizException(ErrorCode.NotFound, undefined, `工具不存在：${name}`);
    }
    return {
      ...toToolItem(tool),
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      timeoutSec: tool.timeoutSec,
      dailyQuota: tool.dailyQuota,
      version: tool.version,
      visible: tool.visible,
    };
  }
}

/** 组装查询条件：关键词同时匹配工具名 / 显示名 / 描述 */
function buildToolWhere(query: ToolListQueryDto) {
  const keyword = query.keyword?.trim();
  return {
    ...(query.includeInternal ? {} : { visible: true }),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(keyword
      ? {
          OR: [
            { name: { contains: keyword } },
            { displayName: { contains: keyword } },
            { description: { contains: keyword } },
          ],
        }
      : {}),
  };
}

function toToolItem(t: {
  name: string;
  displayName: string;
  categoryId: string;
  description: string;
  price: number;
  status: string;
  sync: boolean;
  useCount: number;
  requiresCopyrightAck: boolean;
}): ToolItem {
  return {
    name: t.name,
    displayName: t.displayName,
    categoryId: t.categoryId,
    description: t.description,
    price: t.price,
    status: t.status,
    sync: t.sync,
    useCount: t.useCount,
    requiresCopyrightAck: t.requiresCopyrightAck,
  };
}
