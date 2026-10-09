/**
 * 采样参数档位表（Q9）
 *
 * ## 它解决什么
 *
 * 改造前 `temperature` 以字面量散落在 10 个调用点（0.1 / 0.2 / 0.3 / 0.4 / 0.6 / 0.7），
 * 而 `top_p` **一处在用、一处在查** —— 全仓零使用。
 *
 * 散落带来的不是"不好看"，而是三个具体问题：
 *
 * 1. **同类任务取值不一致**：意图识别在 `os.service` 用 0.1、在 `station-parse` 用 0.2，
 *    两者都是"结构化抽取"，本该同一档；差异没人解释过，只是各自写的时候随手定的。
 * 2. **调优无法一次生效**：想把"抽取类"整体调稳一点，得翻遍全仓改 5 处，
 *    而且下次新增调用点又得重新想一遍该填几。
 * 3. **`top_p` 缺失**：只有 `temperature` 时，长尾采样仍可能选中离谱的 token。
 *    `top_p` 截掉长尾，与低 `temperature` 配合才是"稳"的完整做法。
 *
 * ## 档位按**任务语义**分，不按文件分
 *
 * 判据是"这次调用要的是什么"，与它写在哪个模块无关：
 *
 * | 档位 | 任务性质 | 与温度的关系 |
 * |---|---|---|
 * | `extract` | 抽取固定字段、不要发挥 | 最低温（0.1） |
 * | `classify` | 分类 / 打标，允许略微模糊 | 略高于抽取 |
 * | `grounded` | 依据给定材料作答（RAG、数据分析解读） | 低，但不能太低 |
 * | `plan` | 规划 / 拆解（结构要稳、思路要活） | 中低 |
 * | `chat` | 对话正文（要自然） | 中 |
 * | `create` | 创作（更长、更有变化） | 最高 |
 *
 * ## 为什么不能一刀切都调低
 *
 * "温度越低越准"是错的：`create` 档（写文档 / PPT 大纲）温度过低会让产出
 * **句式高度雷同**，而质量评分里"表达多样性"是明确扣分项 ——
 * 为了稳定牺牲表达，反而降低了产出质量。所以档位保留梯度。
 */
import type { LlmCallOptions } from './types';

/** 采样档位名 */
export type SamplingProfile =
  | 'extract'
  | 'classify'
  | 'grounded'
  | 'plan'
  | 'chat'
  | 'create';

/**
 * 各档位的采样参数。
 *
 * `topP` 的取值口径：
 * - 抽取 / 分类 / 依据材料作答：0.9 —— 收窄到高概率区，减少"自由发挥"；
 * - 规划 / 对话 / 创作：0.95 —— 保留必要的表达空间（规划要能想到不同路径，
 *   创作要有句式变化）。
 *
 * `maxTokens` 只给**建议值**（调用方可覆盖）：各工具的产物长度差异很大，
 * 这里定的是"这一档的常见量级"，不是硬上限。
 */
export const SAMPLING: Record<
  SamplingProfile,
  { temperature: number; topP: number; maxTokens: number }
> = {
  extract: { temperature: 0.1, topP: 0.9, maxTokens: 800 },
  classify: { temperature: 0.15, topP: 0.9, maxTokens: 2000 },
  grounded: { temperature: 0.2, topP: 0.9, maxTokens: 2000 },
  plan: { temperature: 0.3, topP: 0.95, maxTokens: 4000 },
  chat: { temperature: 0.6, topP: 0.95, maxTokens: 2000 },
  create: { temperature: 0.7, topP: 0.95, maxTokens: 4000 },
};

/**
 * 取某档的调用参数。
 *
 * `overrides` 用于覆盖该档的建议值（如某个工具需要更长的产出）。
 * 这样调用点写的是"我要创作档，但产物较长"，而不是"温度 0.7、maxTokens 6000"
 * —— 前者表达了意图，后者只是两个谜之数字。
 */
export function sampling(
  profile: SamplingProfile,
  overrides: Partial<Pick<LlmCallOptions, 'maxTokens' | 'temperature' | 'topP'>> = {},
): Pick<LlmCallOptions, 'temperature' | 'topP' | 'maxTokens'> {
  const base = SAMPLING[profile];
  return {
    temperature: overrides.temperature ?? base.temperature,
    topP: overrides.topP ?? base.topP,
    maxTokens: overrides.maxTokens ?? base.maxTokens,
  };
}