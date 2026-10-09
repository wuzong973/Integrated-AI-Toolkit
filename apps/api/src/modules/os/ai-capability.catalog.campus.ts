/**
 * 校园服务类内部能力的目录数据（2026-09-20 新增）。
 *
 * 拆出来的原因与前两张子表相同：主表已贴 300 行红线，
 * 而每加一条能力就是十几行"什么时候该调 / 不该调"的描述。
 *
 * ## 这里为什么只有"只读 / 解析"两类能力
 *
 * `seed.ts` 里 `campus` 类共有 6 个工具，本表**只登记其中 2 个**：
 *
 * | 工具 | 状态 |
 * |---|---|
 * | `parse_requirement`、`search_service_provider` | 已登记（只读 / 解析，调用无副作用） |
 * | `create_task`、`create_order`、`calculate_price` | 未登记（写操作 / 依赖已发布任务） |
 *
 * 写操作不登记是**刻意的**：`create_order` 会走担保支付预扣，模型只要把
 * "预算 50 元"理解成"50 分"就会**真的产生一笔订单**。这类能力需要
 * "先给用户看将要执行什么 → 用户确认 → 再执行"的两段式交互，
 * 而那套确认卡尚未落地。宁可让助手如实说"我帮你把需求整理好，发布请点按钮",
 * 也不拿用户账号冒险（红线 10：不许让假执行冒充执行）。
 */
import type { AiCapability } from './ai-capability.types';

export const CAMPUS_CAPABILITIES: readonly AiCapability[] = [
  {
    toolName: 'parse_requirement',
    source: 'internal',
    intent: 'campus_service',
    title: '需求结构化解析',
    scene:
      '把用户**一句话描述的需求**整理成结构化草稿（标题/描述/预算/时间/地点/技能标签）。' +
      '例如"我明天下午想在宿舍修一下笔记本，预算一百左右"。' +
      '⚠️ 这只是**解析**，不会发布。解析完要请用户确认，并引导他去驿站发布页发布。',
    notFor: [
      '用户只是问"驿站怎么用"这类方法问题',
      '用户要的是找服务者（那应该用 search_service_provider）',
    ],
    invocation: 'auto',
    needsFile: false,
    resultKind: 'text',
    resultHint: '已整理成草稿',
    // 内部能力没有工具表那份 inputSchema，故在此就地声明参数规范
    params: {
      type: 'object',
      properties: {
        requirement: {
          type: 'string',
          description: '用户的**需求原话**。尽量保留他的表述，不要自己改写或补充他没说过的信息。',
        },
      },
      required: ['requirement'],
      additionalProperties: false,
    },
  },
  {
    toolName: 'search_service_provider',
    source: 'internal',
    intent: 'campus_service',
    title: '服务者检索',
    scene:
      '用户想**找会做某事的人**时调用，如"有没有人能帮我修电脑""找个会剪辑的同学"。' +
      'keyword 填服务类型。只返回**已上架**的服务，不会推荐下架或未过审的。',
    notFor: [
      '用户要发布需求让别人来报名（那应该用 parse_requirement 给他整理草稿）',
      // 实测（2026-09-20）：问"你会做 PPT 吗"时模型误调了本能力（取 keyword="PPT"）。
      // 那类问题是在问**平台能力**，不是找服务者 —— 必须显式排除，否则助手会答成"我帮你找做 PPT 的人"。
      '用户在问"你能不能做某事""有没有这个功能"（问的是平台能力，应直接回答，不要检索）',
    ],
    invocation: 'auto',
    needsFile: false,
    resultKind: 'text',
    resultHint: '已检索服务',
    params: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '服务类型关键词，如"修电脑""剪辑""摄影"。与 categoryId 至少给一个。',
        },
        categoryId: {
          type: 'string',
          description: '分类 id（可选）。不确定就不要填，用 keyword 检索即可。',
        },
      },
      additionalProperties: false,
    },
  },
];