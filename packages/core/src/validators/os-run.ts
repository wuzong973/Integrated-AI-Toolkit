import { z } from 'zod';

/**
 * 青智 OS · 计划 Run 的节点操作校验（任务清单 M2-06）
 *
 * ## 为什么不写在 `validators/index.ts` 里
 *
 * 那份文件已经贴着 ESLint 的 300 行红线（`max-lines`），再加一段就会红。
 * 按主题拆出来与 `ai-capability.catalog.ts / .params.ts / .files.ts` 的做法一致：
 * 一个主题一个文件，`validators/index.ts` 末尾 `export *` 汇总，对外的
 * `@qz/core` 出口不变。
 *
 * ⚠️ 这里**不重复定义** `goal` / `budget` 这类已有约束：
 * 规划请求本身仍是 `index.ts` 的 `OsPlanSchema`（它只多了一个可选的 `sessionId`）。
 * 两份 schema 描述同一个对象时，"改一份忘另一份"是必然发生的。
 */

/**
 * HITL 节点确认（`POST /os/runs/{runId}/nodes/{nodeId}/confirm`）。
 *
 * 两个字段都是可选的 —— 「确认」这个动作本身才是业务，
 * 用户点一下"确认"不该被一个必填表单挡住。
 * `decision` / `note` 会原样写进节点的 `result`，
 * 目的是**留下"是谁拍板、说了什么"的凭据**（文档 6.2.5：HITL 是人工决策，
 * 决策内容不落库就等于没有这回事，事后无法向用户解释计划为什么这么走）。
 */
export const ConfirmOsNodeSchema = z.object({
  decision: z.string().max(200, '决策内容过长').optional(),
  note: z.string().max(500, '备注过长').optional(),
});
export type ConfirmOsNodeDto = z.infer<typeof ConfirmOsNodeSchema>;

/**
 * 人力节点一键发布到驿站（`POST /os/runs/{runId}/nodes/{nodeId}/publish`，M2-06 + M3-21）。
 *
 * ## 为什么 `categoryId` 必填、而标题/描述可以省
 *
 * 规划器产出的节点只有"名字 + 类型 + 依赖"，**没有分类也没有预算**
 * （它不知道该把摄影归进哪个服务分类）。分类决定需求出现在大厅的哪个页签、
 * 谁能报上名，猜一个分类等于替用户决定"谁能看到这条需求"，
 * 且发布后立即 `published`（无草稿态、无人工复审）—— 猜错了没法悄悄挽回。
 * 所以这里要求客户端把用户挑的分类传进来（发布页本就有分类选择器），
 * 而不是服务端兜一个默认值。
 *
 * 标题与描述则**可以**省：默认取节点名与「节点名 + 计划目标」，
 * 服务端仍会用 `PublishTaskSchema` 复核（标题 ≥4 字、描述 ≥10 字），
 * 不合规时报 40001 让用户补，而不是硬发一条格式不合规的需求。
 *
 * ## 预算单位
 *
 * `budget` 与全站一致，**单位是分**（红线）。缺省取节点上的 `budget`
 * （规划器不产出预算时为 0，配合 `budgetType: 'negotiable'` 表示"面议"）。
 */
export const PublishOsNodeSchema = z.object({
  categoryId: z.string().min(1, '请选择服务分类'),
  title: z.string().min(4, '标题至少 4 个字').max(60).optional(),
  description: z.string().min(10, '请补充需求描述').max(2000).optional(),
  budget: z.number().int().nonnegative().optional(),
  budgetType: z.enum(['fixed', 'negotiable', 'hourly']).optional(),
  /** 截止日期：ISO8601（对外时间一律 ISO8601，见规范第二章） */
  deadline: z.string().datetime().optional(),
  location: z.string().max(120).optional(),
});
export type PublishOsNodeDto = z.infer<typeof PublishOsNodeSchema>;
