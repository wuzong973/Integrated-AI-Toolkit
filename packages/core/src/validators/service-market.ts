import { z } from 'zod';

// ============================================================
// 服务商品（M3-04 上架 / 下架，M3-05 服务市场）
// ============================================================
/** 上架服务商品 */
export const UpsertServiceSchema = z.object({
  title: z.string().min(4).max(60),
  categoryId: z.string().min(1),
  description: z.string().min(10).max(2000),
  cover: z.string().url().optional(),
  price: z.number().int().nonnegative(),
  priceUnit: z.enum(['fixed', 'hourly', 'negotiable']),
  deliveryDays: z.number().int().min(1).max(90).optional().default(3),
  serviceArea: z.enum(['school', 'city', 'remote']).optional().default('school'),
  skillTags: z.array(z.string().max(20)).max(10).optional().default([]),
});
export type UpsertServiceDto = z.infer<typeof UpsertServiceSchema>;

/**
 * `service.status` 的全部取值。库里这一列是无约束的 VarChar，
 * 所以取值只在这里定义一次 —— 后端读写、前端筛选都以它为准
 * （分类改名只改一边的那类漂移，AGENTS.md 的 `check:categories` 就是为它造的）。
 *
 *   draft —— 草稿。本期的写入口**不产生**这个状态：上架是"填完即公开"，
 *            与需求发布（M3-06）是同一套取舍 —— 内容安全是同步 fail-closed 的
 *            （M4-05），违规在入口就被 40051 拦掉，再让用户等一次审核换不来合规收益。
 *            引入人工复审时要改回 `draft → reviewing → on`，并在这里补上 reviewing。
 *   on    —— 已上架。**只有这个状态出现在服务市场**。
 *   off   —— 已下架。仅本人在「我的服务」里可见。
 */
export const SERVICE_STATUSES = ['draft', 'on', 'off'] as const;
export type ServiceStatusValue = (typeof SERVICE_STATUSES)[number];

/**
 * 上架服务商品（M3-04 的 `POST /services`）。
 *
 * ⚠️ 字段约束**复用** `UpsertServiceSchema`，不是再抄一份：
 * 两份 schema 描述同一个对象时，"改一份忘另一份"是必然发生的。
 * 起这个与接口同名的别名，是为了让控制器与前端读起来都在说"创建服务"，
 * 将来若编辑接口（M3-04 的 U 部分）需要与上架不同的约束，再拆出独立的 schema。
 */
export const ServiceCreateSchema = UpsertServiceSchema;
export type ServiceCreateDto = UpsertServiceDto;

/**
 * 服务市场 / 我的服务列表查询（M3-04、M3-05 共用）。
 *
 * 参数名用 `page` + **`pageSize`**（文档 9.1 的统一分页口径），
 * 而不是任务大厅那套 `page` + `size` —— 服务卡列表的筛选组件按 `pageSize` 设计。
 * `pageSize` 上限 50：超了直接 40001，而不是静默夹到 50 ——
 * 静默夹会让客户端以为自己传对了、拿到的却是另一页的条数。
 */
export const ServiceListQuerySchema = z.object({
  categoryId: z.string().max(40).optional(),
  /** 关键词：匹配标题 / 描述。上限 40 与任务大厅一致，也避免把整段文案塞进 LIKE */
  keyword: z.string().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export type ServiceListQueryDto = z.infer<typeof ServiceListQuerySchema>;
