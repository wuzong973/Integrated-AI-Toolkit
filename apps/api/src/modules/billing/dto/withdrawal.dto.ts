import { z } from 'zod';

/**
 * 提现申请入参（任务清单 M3-13）
 *
 * ## 为什么 schema 写在这里而不是 `packages/core/src/validators`
 *
 * 工程纪律是"校验规则前后端共用 core 的 zod schema"。本期提现只做后端 + 单测，
 * 小程序侧接线由另一条任务并行推进，改动范围被限定在 `modules/billing/**`，
 * 所以先把规则放在模块内，**常量 `MIN_WITHDRAW_CENTS` 已 export**：
 * mp 接线时应把本 schema 整体上移到 `@qz/core/validators` 再从这里 re-export，
 * 避免出现"后端 10 元起提、前端 20 元起提"这类两份真相。
 *
 * ## 金额单位：分（整数）
 *
 * 红线 4 / 文档 9.1：金额一律用「分」的整数，禁止浮点。
 * 因此这里刻意用 `z.number().int()` 而不是 `z.coerce.number()`：
 *   · `coerce` 会把 `"12.34"` 变成 `12.34`，浮点就这样溜进了账务；
 *   · 更糟的是 `Number('')` 与 `Number(null)` 分别是 0 与 0，
 *     "没填金额"会被静默当成"提 0 元"，用户看到成功提示却没动钱。
 * 非整数在管道层就被 400 挡掉，服务层再兜一次（见 `assertWithdrawAmount`）。
 */

/** 起提金额（分）：10 元起提。低于此值的申请连审核人力成本都不够覆盖。 */
export const MIN_WITHDRAW_CENTS = 1000;

/** 提现申请 body */
export const CreateWithdrawalSchema = z.object({
  amount: z
    .number({ invalid_type_error: '提现金额必须是整数（单位：分）' })
    .int('提现金额必须是整数（单位：分），不支持小数')
    .positive('提现金额必须大于 0'),
});
export type CreateWithdrawalDto = z.infer<typeof CreateWithdrawalSchema>;
