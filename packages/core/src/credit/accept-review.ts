import { z } from 'zod';

import { AcceptSchema } from '../validators';

/**
 * 验收时附带的**评价内容**（任务清单 M3-16；文档 6.6.4）。
 *
 * ## 为什么不直接给 `AcceptSchema` 加字段
 *
 * 那个 schema 是已冻结的验收契约（`apps/mp/utils/api.ts` 的 `orderApi.accept`
 * 只发 `{ rating }`），改它的形状等于改已有导出签名 —— 要走得通契约变更流程。
 * 这里用 `.extend()` **派生**一个只增加可选字段的宽版：老客户端原样通过，
 * 新客户端可以顺带把正文/标签/匿名一次提交，不必"先验收再评价"两个来回
 * （两次提交就会出现"验收成功、评价失败"的半状态，且没有回滚通道）。
 *
 * ## 为什么放在 `credit/` 而不是 `validators/index.ts`
 *
 * `validators/index.ts` 的**有效行**已贴着 300 行红线（工程纪律 8），
 * 而本 schema 与信用域是同一个主题，放进来正好（域目录自带契约是本仓既有形态，
 * 参考 `station/match.ts`）。
 *
 * ## `images` 刻意**不开放**
 *
 * 评价图要落 `Review.images`，但两件事还没就绪：图片内容审核（M4-05 只做文本）
 * 与文件归属校验。先开这个口子等于开一条绕过内容安全的旁路 ——
 * 所以本 schema 里没有 images 字段，等上面两项接上再加。
 */
export const AcceptReviewSchema = AcceptSchema.extend({
  /** 评价正文（可空：只打星不写字是主流量） */
  content: z.string().max(500).optional(),
  /** 评价标签（文档 6.6.4 的多选项，如"按时交付"） */
  tags: z.array(z.string().max(20)).max(10).optional(),
  /** 匿名评价：对被评价方隐藏昵称（信用加减**照常生效**，文档 6.6.4） */
  isAnonymous: z.boolean().optional(),
});
export type AcceptReviewDto = z.infer<typeof AcceptReviewSchema>;

/** 评价写入的最小输入（验收流程用；与 schema 同字段，避免服务层依赖 zod 类型） */
export interface RatingInput {
  rating: number;
  content?: string;
  tags?: string[];
  isAnonymous?: boolean;
}
