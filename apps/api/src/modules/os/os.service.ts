import { Inject, Injectable } from '@nestjs/common';
import {
  BizException,
  ErrorCode,
  type CreateOsSessionDto,
  type LlmMessage,
  type LlmResponse,
  type OsIntentResult,
  type OsPlanResult,
  type Providers,
  type SendOsMessageDto,
  sampling,
} from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import { PROVIDERS } from '../../infra/providers/providers.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { ModerationService } from '../moderation/moderation.service';

import { buildChatPrompt } from './os-chat-prompt';
import { tryClarify } from './os-clarify';
import { INTENT_JSON_SCHEMA, buildIntentMessages, normalizeIntent } from './os-intent';
import { PLAN_JSON_SCHEMA, buildPlanMessages, degraded, normalizePlan } from './os-planner';
import { OsRunService } from './os-run.service';
import { guardFalseCompletion, isFalseCompletion, sanitizeAssistantReply } from './os-reply-guard';
import { OsCapabilityRegistry } from './os-capability.registry';
import { buildFilesCard, type OsToolCard } from './os-tool-card';
// ⚠️ 这里**不能**用 `import type`：Nest 靠 `emitDecoratorMetadata` 产出的
// 构造参数类型来解析依赖，而 `import type` 会被完全擦除 →
// 运行时报 "Nest can't resolve dependencies of the OsService (... ?)"，
// 且报错里那个参数显示为 `Function`，很难联想到是 import 写法的问题。
// 编译期不会报错、单测也不会报错（单测是手工 new 的），只有真启动才暴露。
import { OsToolRegistry } from './os-tools';

/** 会话条目（对齐 apps/mp 的会话列表渲染） */
export interface OsSessionItem {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}

/** 消息条目（字段与小程序 `ChatMessage` 一一对应） */
export interface OsMessageItem {
  id: string;
  role: string;
  agentName?: string;
  kind: string;
  content: string;
  /** 结果卡（AI 能力调用的产物入口）。没有调用能力时为 undefined */
  cards?: OsToolCard[];
  createdAt: string;
}

/** 带进模型的历史消息条数（只取最近的，避免 token 无限增长） */
const HISTORY_LIMIT = 12;

/**
 * 工具调用循环的最大轮数。
 *
 * 取 2 而不是更多：每轮都是一次完整的模型往返（数秒级），
 * 而小程序请求超时只有 30 秒 —— 轮数给多了会让"等超时"变成常态。
 * 详见 `chatWithTools` 的说明。
 */
const MAX_TOOL_ROUNDS = 2;

/**
 * 任务规划的最大尝试次数。
 *
 * 取 2（首次 + 重试 1 次）而不是更多：Provider 内部已有 `LLM_MAX_RETRY` 次
 * **网络级**重试，这里只补"输出不合法"这一类。两者叠加时最坏耗时会相乘，
 * 而整个链路还受 `LLM_TOTAL_BUDGET_MS` 总预算约束 —— 次数给多了，
 * 预算会被前一次吃光，重试根本发不出去。
 */
const PLAN_ATTEMPTS = 2;

/**
 * 规划输出的 token 预算。
 *
 * 12 个节点 × 每节点约 60 token（id + 中文名 + 类型 + 依赖数组）≈ 720，
 * 留到 3000 是为了给**推理型模型**的思考过程留余量：
 * 智谱 GLM 系会先写 `reasoning_content` 再给 `content`，预算给少了会出现
 * "推理吃光 token、content 为空"（Provider 的 `assertContentPresent` 会因此报错）。
 */
const PLAN_MAX_TOKENS = 3000;

/**
 * 青智 OS（AI 助手）
 *
 * ## 这一层之前是缺失的
 *
 * 小程序早就在调 `/os/sessions`、`/os/intent`，但后端**没有 os 模块**，
 * 这些请求全部 404 —— 界面靠 `pages/os/index.ts` 里的 `localIntent()` 关键词规则
 * 硬撑着，模型一次都没被调用过。本模块把这条链路真正接上。
 *
 * ## 提示词与规则的分工
 *
 * 服务端负责"用模型理解"；小程序保留一份**离线规则兜底**
 *（断网 / 后端未启动时仍能用）。两份逻辑**刻意不合并**：
 * 服务端这份追求准确，客户端那份只保证"不白屏"。
 * 但**意图取值必须两边一致**，见 `packages/core/src/validators/index.ts` 的 `OS_INTENTS`。
 */
@Injectable()
export class OsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROVIDERS) private readonly providers: Providers,
    private readonly logger: AppLogger,
    private readonly tools: OsToolRegistry,
    private readonly capabilities: OsCapabilityRegistry,
    private readonly moderation: ModerationService,
    /** 计划 Run 持久化（M2-06）。⚠️ 不能用 `import type`，理由同 `OsToolRegistry` */
    private readonly runs: OsRunService,
  ) {}

  /** 新建会话（客户端进入 AI 页时调用） */
  async createSession(userId: string, dto: CreateOsSessionDto): Promise<{ id: string }> {
    const session = await this.prisma.osSession.create({
      data: { userId, title: dto.title ?? '青智 OS', scene: dto.scene },
      select: { id: true },
    });
    return session;
  }

  /** 我的会话列表（按最近活跃排序，只出**聊过**的会话） */
  async listSessions(userId: string): Promise<OsSessionItem[]> {
    const rows = await this.prisma.osSession.findMany({
      // `messages: { some: {} }` = 只出至少有一条消息的会话。
      // 客户端的 AI 页每次进入都会先建一个会话，不过滤的话历史列表会被一堆
      // 空壳会话淹掉 —— 用户点进去只看到"这段对话没有内容"，真正聊过的那几段
      // 反而被挤到后面（列表 take 30）。
      where: { userId, status: 'active', messages: { some: {} } },
      orderBy: { updatedAt: 'desc' },
      take: 30,
      select: { id: true, title: true, status: true, updatedAt: true },
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title ?? '青智 OS',
      status: r.status,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /** 会话消息（按时间正序） */
  async listMessages(userId: string, sessionId: string): Promise<OsMessageItem[]> {
    await this.requireSession(userId, sessionId);
    const rows = await this.prisma.osMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return rows.map((row) => toMessageItem(row));
  }

  /**
   * 发送消息：落库 → 带上下文调模型（含工具循环）→ 落库回复 + 结果卡。
   *
   * 返回 `messageId` 是**回复**的 id（客户端用它定位/滚动到最新一条）。
   *
   * `dto.fileIds` 是当前对话里用户已上传的文件 —— 有了它，
   * "帮我抠图"这类请求才能在对话里**直接执行**，而不是只能引导用户去上传。
   */
  async sendMessage(
    userId: string,
    sessionId: string,
    dto: SendOsMessageDto,
  ): Promise<{ messageId: string; reply: OsMessageItem }> {
    const session = await this.requireSession(userId, sessionId);

    /*
     * 用户消息既是**入库并回显的 UGC**，又是**可能触发工具副作用**的指令入口
     * （助手能创建文件、发布任务），所以输入侧必须过一遍内容安全（M4-05）。
     * 放在 `requireSession` 之后：越权访问应当先报 403，
     * 而不是先告诉对方"你的内容有问题"。
     *
     * 注意这**不能**替代出口侧的净化 —— `os-reply-guard` 管的是模型输出，
     * 这里管的是用户输入，两者是两条独立的边界。
     */
    await this.moderation.assertText(dto.content, {
      userId,
      scene: 'log',
      field: '消息内容',
    });

    await this.prisma.osMessage.create({
      data: { sessionId: session.id, role: 'user', content: dto.content, contentType: 'text' },
    });

    const history = await this.recentHistory(session.id);
    // M2-06 第 2 点：本会话若有未终态的计划 Run，把它的 id 穿过工具上下文带给作业。
    // 注意这**只到 run 级**——一次工具调用对应不上具体节点（理由见 os-run.service.ts 头部）。
    const runId = await this.runs.openRunId(session.id);

    /*
     * 澄清判定（Q13）：信息不足时**先追问，不执行**。
     *
     * ## 为什么必须放在服务端、且放在执行之前
     *
     * 小程序端是 `intent` 与 `send` **并发**发起的，意图回来时正文往往已经在生成 ——
     * 客户端拿到 `needsClarification` 也来不及拦。只有服务端掌握"是否真的执行"。
     *
     * ## 为什么带超时上限
     *
     * 实测意图识别要 3.5~6.7s，而客户端对回复的等待上限是 15s。
     * 澄清只是一次"要不要先问一句"的优化，**不值得让用户为它白等**：
     * 判定超时就照常回答（宁可答得不那么贴合，也不要卡住）。
     * 超时不等于失败 —— 这里用 catch 静默降级，与"可选能力静默降级"的纪律一致。
     */
    const clarification = await tryClarify({
      text: dto.content,
      recognize: (text) => this.recognizeIntent(text),
      logger: this.logger,
      userId,
    });
    if (clarification) {
      return this.saveAssistantReply(session.id, clarification, []);
    }

    const { res, cards, executed } = await this.chatWithTools(
      [{ role: 'system', content: await this.systemPrompt() }, ...history],
      { userId, sessionId: session.id, fileIds: dto.fileIds ?? [], runId },
    );

    /*
     * 出口两道净化（提示词拦不住的部分在这里兜住）：
     *   ① `sanitizeAssistantReply` —— 编造的链接（降级到 glm-4-flash 时会发生）；
     *   ② `guardFalseCompletion` —— **声称做完了但这一轮什么都没执行**。
     *      它依据的是服务端确知的事实（工具循环跑没跑出东西），
     *      而不是对文案的猜测，所以不会误伤。
     */
    const sanitized = sanitizeAssistantReply(res.content);
    const lied = isFalseCompletion(sanitized, executed);
    const finalCards = lied ? [...cards, ...(await this.existingFilesCards(userId))] : cards;

    return this.saveAssistantReply(
      session.id,
      guardFalseCompletion(sanitized, executed),
      finalCards,
      res.usage,
    );
  }

  /**
   * 落一条助手消息（含结果卡与 token 记账）。
   *
   * 抽成方法的原因：**澄清追问**也要走这条路 —— 它同样是一条助手消息，
   * 同样要落库、要回给客户端。两处各写一份 insert 必然出现"一处记得更新 token、
   * 另一处忘了"的漂移（本项目在 orders / jobs 上已踩过同类问题）。
   */
  private async saveAssistantReply(
    sessionId: string,
    content: string,
    cards: OsToolCard[],
    usage?: { completionTokens?: number; totalTokens?: number },
  ) {
    const reply = await this.prisma.osMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        agentName: 'coordinator',
        content,
        // 有卡就用 `card`：小程序据此渲染产物入口（与纯文本气泡是不同的组件）
        contentType: cards.length ? 'card' : 'text',
        cards: cards as never,
        tokens: usage?.completionTokens ?? 0,
      },
    });

    await this.prisma.osSession.update({
      where: { id: sessionId },
      data: { tokenUsed: { increment: usage?.totalTokens ?? 0 } },
    });

    return { messageId: reply.id, reply: toMessageItem(reply, cards) };
  }

  /**
   * 假成功时的「我的文件」卡。
   *
   * ## 为什么光说"这轮没执行"不够
   *
   * 模型之所以会说"已经为您生成…"，恰恰是因为**上一轮真的生成过** ——
   * 东西很可能就躺在用户名下。这时候只补一句"本轮没有实际执行"，
   * 用户听到的是坏消息（没做），却依然不知道该去哪找手上那份文件。
   *
   * 所以再给一张卡把"东西在哪"答完：既不谎报本轮，也不让用户空手。
   *
   * ## 为什么查数量但**不**用它做门槛
   *
   * 数量只用来决定文案怎么说（有文件报数、没文件就别报数）。
   * 真机探针发现：长任务（PPT）是异步的，触发净化时作业**往往还在跑、文件尚未落盘** ——
   * 若拿 `count > 0` 当门槛，最需要这张卡的时刻它恰好不出现。
   * 而文案已明说"这一轮没有实际生成文件"，空列表与这句话是一致的，不算误导。
   *
   * 只在**净化真的触发时**才查这一次（正常对话一分钱不花）；
   * 查库失败按 0 处理 —— 宁可文案保守，也不要让整轮对话失败。
   */
  private async existingFilesCards(userId: string): Promise<OsToolCard[]> {
    const count = await this.prisma.fileAsset
      .count({ where: { userId, deletedAt: null } })
      .catch(() => 0);

    return [buildFilesCard(count)];
  }

  /**
   * 系统提示词：能力清单**从对账结果生成**（见 `os-chat-prompt.ts` 的说明）。
   *
   * 每次都重新拼一遍字符串本身没有成本（对账结果有 60s 缓存），
   * 但不缓存拼装结果，可以让"运维刚下线某工具"在下一轮对话就反映到提示词里。
   */
  private async systemPrompt(): Promise<string> {
    return buildChatPrompt(await this.capabilities.promptLines());
  }

  /**
   * 带工具调用的对话循环（M2-08 / M2-09 的可用形态）。
   *
   * ## 这个循环此前只会"查资料"
   *
   * 原来工具清单里只有 `search_knowledge`，所以助手能做的全部事情就是查校规，
   * 而工具箱里 20 个真能跑的 AI 能力一个都没接上。**不是没实现，是没接线。**
   * 现在清单来自 `OsToolRegistry`（目录 ∩ 工具表 ∩ 执行器），
   * 用户说"帮我做个 PPT"就会真的建作业、真的出 `.pptx`。
   *
   * ## 为什么最多两轮
   *
   * 每一轮都是一次完整的模型往返（实测 generate 档数秒）。给三轮以上时，
   * 用户会对着转圈等十几秒，而**小程序请求超时只有 30 秒** ——
   * 超时之后前端断开，后端还在继续打请求烧配额。
   * 两轮足够覆盖"查一次资料/生成一次内容再回答"这个最常见形态。
   *
   * ## 轮次用尽后一定要再要一次无工具的答复
   *
   * 否则最后一轮的结果是"模型发起了工具调用"，而我们没有对应的回答文本，
   * 用户会收到一条**空消息**。宁可多花一次往返，也要保证对话有结尾。
   *
   * ## 工具结果进上下文但不进数据库
   *
   * 检索到的原文、执行结果都可能有几千字。存进 `os_message` 会让会话列表
   * 每条消息都很长，而它们只在**当轮**有用（下一轮的历史里模型已经看到过结论了）。
   * 所以工具结果只活在本次循环的消息数组里 —— 但**结果卡要落库**，
   * 因为卡是给用户回看产物的入口，不是给模型的上下文。
   *
   * ## 为什么要把 `executed` 报出去
   *
   * "这一轮到底执行过没有"是服务端**确知的事实**，而模型可能在没执行的情况下
   * 说"已经为您生成好了"（它把历史里自己上一轮的话当成了既成事实）。
   * 出口净化需要一个不依赖文案判读的客观依据，这就是那个依据。
   */
  private async chatWithTools(
    messages: LlmMessage[],
    ctx: { userId: string; sessionId: string; fileIds: string[]; runId?: string },
  ): Promise<{ res: LlmResponse; cards: OsToolCard[]; executed: boolean }> {
    const convo: LlmMessage[] = [...messages];
    const specs = await this.tools.specs();
    const cards: OsToolCard[] = [];
    let executed = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await this.providers.llm.chat(convo, {
        tier: 'generate',
        // 对话正文档：要自然，但不需要创作档那种变化幅度
        ...sampling('chat'),
        tools: specs,
      });

      const calls = res.toolCalls ?? [];
      if (!calls.length) return { res, cards, executed };

      // assistant 那条要把 toolCalls 原样带上，否则模型下一轮不知道
      // 自己已经请求过工具，会重复发起同一个调用
      convo.push({ role: 'assistant', content: res.content ?? '', toolCalls: calls });

      for (const [i, call] of calls.entries()) {
        const out = await this.tools.execute(
          { name: call.name, args: call.arguments, callToken: `${round}-${i}` },
          ctx,
        );
        // 只有真正到达执行层的才算"执行过"：
        // 缺文件回引导卡、白名单拒绝等**都没执行**，不能让它们成为谎报的挡箭牌
        if (out.executed) executed = true;
        if (out.card) cards.push(out.card);
        convo.push({
          role: 'tool',
          content: out.forModel,
          toolCallId: call.id,
          name: call.name,
        });
      }
    }

    this.logger.warn(`工具调用达到 ${MAX_TOOL_ROUNDS} 轮上限，改为直接作答`, 'OsService');
    const res = await this.providers.llm.chat(convo, {
      tier: 'generate',
      ...sampling('chat'),
    });
    return { res, cards, executed };
  }

  /**
   * 意图识别。
   *
   * 模型不可用 / 输出不是合法 JSON 时**直接抛出**，由客户端用离线规则兜底
   *（`pages/os/index.ts` 的 `localIntent`）—— 服务端不再维护第二套规则，
   * 免得两边不一致时"线上和离线答得不一样"。
   */
  async recognizeIntent(text: string): Promise<OsIntentResult> {
    const raw = await this.providers.llm.structured<unknown>(
      buildIntentMessages(text),
      INTENT_JSON_SCHEMA,
      // ⚠️ maxTokens 必须给足：GLM 是**推理型**模型，实测单次意图识别会先烧掉
      // 1100~1300 字符的推理过程（约 600+ token）才输出结论。
      // 给 600 会导致"推理吃光预算、content 为空"，实测 5 条里挂了 2 条。
      { tier: 'intent', ...sampling('classify') },
    );
    return normalizeIntent(raw);
  }

  /**
   * 任务规划（M2-05）—— **`plan` 档（深度思考）在本项目里的唯一调用点**。
   *
   * ## 为什么要有这个入口
   *
   * `.env` 里的 `LLM_MODEL_PLAN` 此前**没有任何调用方**：三档里 `intent` 归意图识别、
   * `generate` 归对话正文，而 `plan` 只被读进配置对象就再没人用。
   * 一个"配了但没人调"的档位不会报错，只会让"深度思考"这件事在产品上**根本不存在**。
   *
   * ## 与意图识别的分工
   *
   * 意图识别回答"这是哪一类事"（分类任务，`intent` 档，温度 0.1）；
   * 任务规划回答"这件事要分几步、谁先谁后"（推理任务，`plan` 档）。
   * 两者刻意分成两次调用：分类要快要稳，规划要准要全 —— 塞进一次调用时
   * 模型往往"先分类就顺手编了个清单"，依赖关系全是想当然的。
   *
   * ## 失败即降级，不编造
   *
   * 模型不可用 / 返回非法 JSON / 计划有环超限时，返回 `nodes: []` + `degraded: true`，
   * 由客户端退回 `buildPlanFromSubtasks(intent.subtasks)` —— 那份子任务同样是
   * 模型的真实输出（来自 `intent` 档），只是没有依赖关系。**绝不产出编造的计划图。**
   *
   * ## 规划成功后落库（M2-06）
   *
   * 传了 `owner`（= 请求带了 `sessionId`）时，这张 DAG 会被写成
   * `OsPlanRun` + 逐节点 `OsTaskNode`，响应里多出 `runId`，看板与节点操作
   * 三条路由都以它为锚点。**只有真规划成功才落库** ——
   * 降级结果没有节点，存进去就是一张空壳计划。
   */
  async plan(goal: string, owner?: { userId: string; sessionId: string }): Promise<OsPlanResult> {
    const raw = await this.tryStructuredPlan(goal);
    if (raw === null) {
      return degraded(goal, 'AI 规划服务暂时不可用，已退回子任务清单');
    }
    const result = normalizePlan(raw, goal);
    return owner ? this.runs.persistPlan(owner.userId, owner.sessionId, result) : result;
  }

  /**
   * 规划调用：**失败重试 1 次**，仍失败返回 `null`（由调用方降级）。
   *
   * 为什么单独重试一次：`structured()` 在 JSON 解析失败时抛 `AiOutputInvalid`，
   * 而实测这类失败**是抖动的**（同一提示词同一模型，时而带 ```json 围栏、时而干净）——
   * 重试一次能救回相当一部分，成本只是一次往返。
   * 重试仍失败就不再试第三次：`OpenAiCompatibleLlmProvider` 内部已有
   * `LLM_MAX_RETRY` 次网络级重试，再叠加会放大成"用户等半分钟才看到降级"。
   */
  private async tryStructuredPlan(goal: string): Promise<unknown | null> {
    let lastError = 'unknown';

    for (let attempt = 0; attempt < PLAN_ATTEMPTS; attempt++) {
      try {
        return await this.providers.llm.structured<unknown>(
          buildPlanMessages(goal),
          PLAN_JSON_SCHEMA,
          // 规划输出是 JSON 节点列表，比对话正文长；温度调低以稳定结构（而非文采）
          { tier: 'plan', ...sampling('plan', { maxTokens: PLAN_MAX_TOKENS }) },
        );
      } catch (e) {
        lastError = (e as Error)?.message ?? 'unknown';
      }
    }

    // 降级原因必须落在日志里：否则线上只看到"计划卡变成了清单"，不知道是模型挂了还是输出不合法
    this.logger.warn(
      `任务规划失败（已尝试 ${PLAN_ATTEMPTS} 次），降级为子任务清单：${lastError}`,
      'OsService',
    );
    return null;
  }

  /**
   * 助手当前**可调用**的 AI 能力清单（含被丢弃项与原因）。
   *
   * 为什么把它做成接口而不是只留给日志：这是唯一能让"提示词承诺的能力"被外部核对的入口。
   * 运维可以 `curl` 一眼看出某个工具为何没进助手（未上线 / 执行器没接 / 需要版权声明），
   * `verify-os.mjs` 也用它断言"目录里的能力真的端到端可用"。
   */
  listCapabilities(): Promise<{ available: unknown[]; dropped: unknown[] }> {
    return this.capabilities.resolve();
  }

  /** 取会话并校验归属（不暴露"存在但不属于你"这种信息） */
  private async requireSession(userId: string, sessionId: string): Promise<{ id: string }> {
    const session = await this.prisma.osSession.findFirst({
      where: { id: sessionId, userId },
      select: { id: true },
    });
    if (!session) {
      throw new BizException(ErrorCode.NotFound, undefined, '会话不存在或已结束');
    }
    return session;
  }

  /** 最近的对话历史（正序），用于给模型提供上下文 */
  private async recentHistory(sessionId: string): Promise<LlmMessage[]> {
    const rows = await this.prisma.osMessage.findMany({
      where: { sessionId, role: { in: ['user', 'assistant'] } },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
      select: { role: true, content: true },
    });
    return rows
      .reverse()
      .map((r) => ({ role: r.role === 'assistant' ? 'assistant' : 'user', content: r.content }));
  }
}

/**
 * 对话系统提示词已移到 `os-chat-prompt.ts`。
 *
 * 搬走的原因是它不再是常量：能力清单从 `OsCapabilityRegistry` 的对账结果生成，
 * 所以必须是一个函数（`buildChatPrompt`），不能再 `const` 一个写死的模板 ——
 * 写死的那份会随着工具箱增删而悄悄变成谎话。
 */

/** Prisma 行 → 客户端消息结构 */
function toMessageItem(
  row: {
    id: string;
    role: string;
    agentName: string | null;
    contentType: string;
    content: string;
    cards?: unknown;
    createdAt: Date;
  },
  /** 刚落库的那条卡是内存对象（刚生成），比从 JSON 读回来更可信 */
  cards?: OsToolCard[],
): OsMessageItem {
  return {
    id: row.id,
    role: row.role,
    agentName: row.agentName ?? undefined,
    kind: row.contentType,
    content: row.content,
    ...(resolveCards(cards ?? row.cards).length ? { cards: resolveCards(cards ?? row.cards) } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * 把 `os_message.cards`（Json 列）收敛成结果卡数组。
 *
 * 列里的内容是**历史写入的**，形状不保证：可能是 `null`、可能不是数组、
 * 元素可能有缺字段（早期版本或人工改库）。这里逐个校验，
 * 不合格的直接丢掉 —— 让小程序拿到的一定是能渲染的卡，
 * 而不是一个 `undefined.xxx` 崩掉整页的消息。
 *
 * ⚠️ 新增卡片形态时**必须同步这里**：漏了不会报错，
 * 只会表现为"卡明明生成了、客户端却收不到" —— 本轮加 `files` 时就踩到过一次
 *（服务端已落库、返回给客户端的却是空）。
 */
function resolveCards(raw: unknown): OsToolCard[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRenderableCard);
}

/** 三种形态都允许；`params` 必须是数组（WXML 会直接遍历它） */
const CARD_KINDS = new Set<OsToolCard['kind']>(['result', 'guide', 'files']);

function isRenderableCard(v: unknown): v is OsToolCard {
  const c = v as Partial<OsToolCard>;
  return (
    typeof c === 'object' &&
    c !== null &&
    CARD_KINDS.has(c.kind as OsToolCard['kind']) &&
    typeof c.toolName === 'string' &&
    typeof c.title === 'string' &&
    Array.isArray(c.params)
  );
}
