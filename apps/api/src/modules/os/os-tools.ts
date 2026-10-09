import { Injectable } from '@nestjs/common';
import type { LlmToolSpec } from '@qz/core';

import { AiDispatchService } from './ai-dispatch.service';
import { CampusTool, PARSE_REQUIREMENT, SEARCH_SERVICE_PROVIDER } from './os-campus-tool';
import { KnowledgeTool, SEARCH_KNOWLEDGE } from './os-knowledge-tool';
import { OsCapabilityRegistry } from './os-capability.registry';
import type { OsToolCard } from './os-tool-card';

/**
 * 助手可以调用的工具集合（Agent 运行循环的"手"）
 *
 * ## 它此前只有一只手
 *
 * 本文件原来只接了一个 `search_knowledge`，于是在用户眼里，
 * "AI 助手"能做的全部事情就是查校规 —— 而平台的工具箱里明明躺着
 * 20 个真能跑的 AI 能力。**不是没实现，是没接线。**
 *
 * 现在它是**复合注册表**：
 *   · `source: 'internal'` → 本地实现（知识库检索）
 *   · `source: 'tool'`     → 交给 `AiDispatchService` 走工具箱那条统一链路
 * 而"有哪些能力"不再由本文件写死，改由 `OsCapabilityRegistry` 与
 * seed / 执行器对账得出（见 `ai-capability.catalog.ts`）。
 *
 * ## 工具结果的两条去向
 *
 * 一次执行会同时产出两样东西，它们的去向**不同**：
 *   · `forModel` —— 工具消息，进本轮对话上下文，让模型知道发生了什么；
 *   · `card`     —— 结果卡，落库到 `os_message.cards`，让**用户**拿到产物入口。
 * 只给模型不给卡片 = 用户被告知"做好了"却找不到东西；
 * 只给卡片不给模型 = 模型不知道自己做了什么，下一轮会重复调用。
 */
@Injectable()
export class OsToolRegistry {
  constructor(
    private readonly capabilities: OsCapabilityRegistry,
    private readonly dispatch: AiDispatchService,
    private readonly knowledge: KnowledgeTool,
    private readonly campus: CampusTool,
  ) {}

  /** 暴露给模型的工具清单（由对账结果生成，未上线能力不会出现在这里） */
  specs(): Promise<LlmToolSpec[]> {
    return this.capabilities.specs();
  }

  /**
   * 执行一次工具调用。
   *
   * @param callToken 本次调用在会话内的位置令牌（`轮次-序号`），用于生成幂等键
   */
  async execute(invocation: ToolInvocation, ctx: ToolRunContext): Promise<ToolExecution> {
    // 内部能力：本地实现，不建作业、不消耗配额
    if (invocation.name === SEARCH_KNOWLEDGE) {
      return this.knowledge.run(invocation.args);
    }

    // 校园能力（只读 / 解析类）。⚠️ 写操作（create_task / create_order /
    // send_notification）**刻意不在这里分流**：它们需要"先确认再执行"的两段式交互，
    // 而那套确认卡尚未落地 —— 接上等于让模型能直接拿用户账号下单。理由见 os-campus-tool.ts。
    if (invocation.name === PARSE_REQUIREMENT) {
      return this.campus.parseRequirement(invocation.args);
    }
    if (invocation.name === SEARCH_SERVICE_PROVIDER) {
      return this.campus.searchProviders(invocation.args);
    }

    return this.dispatch.dispatch({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      toolName: invocation.name,
      rawArgs: invocation.args,
      fileIds: ctx.fileIds,
      callToken: invocation.callToken,
      runId: ctx.runId,
    });
  }
}

/** 一次工具调用请求 */
export interface ToolInvocation {
  name: string;
  /** 模型给的参数 JSON 字符串（**不能假设它合法**） */
  args: string;
  /** 位置令牌，见 `AiDispatchService` 的幂等键说明 */
  callToken: string;
}

/** 执行上下文：这些东西不在模型手里，只能由会话层提供 */
export interface ToolRunContext {
  userId: string;
  sessionId: string;
  /** 当前对话里用户已上传的文件 id */
  fileIds: string[];
  /**
   * 本会话**最近一个未终态**的计划 Run（M2-06）。
   *
   * 只用于给作业打上 `run_id`，让看板能如实列出"这个计划期间跑了哪些 AI 作业"。
   * ⚠️ 它**不是** `nodeId`：模型选哪个工具与计划节点之间没有可靠映射，
   * 所以节点状态不会因为一次工具调用而被改动（见 `os-run.service.ts` 头部说明）。
   */
  runId?: string;
}

/** 执行产物 */
export interface ToolExecution {
  /** 给模型看的结果文本 */
  forModel: string;
  /**
   * 这一轮**是否真的执行过**（作业真的建了 / 检索真的跑了）。
   *
   * ⚠️ 缺文件回引导卡、白名单拒绝、执行失败都算**没有执行** ——
   * 出口净化用它来判断模型是不是在谎报完成（`guardFalseCompletion`）。
   * 这里放宽一格，就等于给"假成功"留了一个合法的挡箭牌。
   */
  executed: boolean;
  /** 给界面渲染的结果卡（内部能力与纯文本能力没有卡） */
  card?: OsToolCard;
}

