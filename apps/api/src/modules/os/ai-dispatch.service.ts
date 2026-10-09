import { Injectable } from '@nestjs/common';
import { BizException } from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import { ToolInvokeService } from '../tool/tool-invoke.service';

import { coerceParams, describeParams, fieldLabel, requiredFields } from './ai-capability.params';
import type { ResolvedCapability } from './os-capability.registry';
import { OsCapabilityRegistry } from './os-capability.registry';
import type { OsToolCard } from './os-tool-card';

/** 一次调度的入参 */
export interface DispatchInput {
  userId: string;
  /** 会话 id（用于生成幂等键，避免同一个模型调用重复执行） */
  sessionId: string;
  toolName: string;
  /** 模型给的原始参数 JSON 字符串（**不可信**） */
  rawArgs: string;
  /** 当前对话里用户已上传的文件 id（来自 `POST /files/confirm`） */
  fileIds: string[];
  /** 本次调用在本会话内的位置令牌（轮次-序号），与会话 id 一起构成幂等键 */
  callToken: string;
  /**
   * 本会话未终态的计划 Run（M2-06，可能没有）。
   * 一路传到 `ToolInvokeService` → `tool_job.run_id`，
   * 让"这个计划期间跑了哪些 AI 作业"在库里可查。
   * ⚠️ 只到 run 级，**不带 nodeId**：没有可靠依据把一次工具调用算到某个节点头上。
   */
  runId?: string;
}

/** 一次调度的产物 */
export interface DispatchOutcome {
  /** 给模型看的结果文本（工具消息的 content） */
  forModel: string;
  /**
   * 是否真的到达执行层。
   *
   * ⚠️ 下面的三条"没执行"分支（白名单拒绝抛错 / 缺必填项 / 缺文件）都必须报 false：
   * 出口净化靠它识别"模型没执行却说做完了"（`guardFalseCompletion`），
   * 这里放宽一格就等于给假成功留了挡箭牌。
   */
  executed: boolean;
  /** 给界面渲染的结果卡；内部能力与纯文本能力没有卡 */
  card?: OsToolCard;
}

/**
 * AI 能力统一调度（任务清单 M2-09 的对话侧实现）
 *
 * ## 它在整条链路里的位置
 *
 * ```
 * 用户说话
 *   └─ OsService.chatWithTools        一次模型往返，模型可能发起 N 个 tool_calls
 *        └─ OsToolRegistry.execute     按来源分流：内部能力 / AI 能力
 *             └─ AiDispatchService     ← 本类：参数收敛 → 调用 → 结果整合
 *                  └─ ToolInvokeService 配额 → 幂等 → 建作业 → 预扣 → 执行
 *                       └─ ToolExecutorService → Provider
 * ```
 *
 * ## 三条不可越过的纪律
 *
 * 1. **不信任模型参数**：一律过 `coerceParams()` 按工具自己的 schema 收敛。
 *    模型会把 `pages` 写成字符串、把枚举传成中文标签、偶尔发明新参数名。
 * 2. **不伪造执行**：缺文件就不执行（回引导卡）、必填项缺失就不执行（回追问）、
 *    执行失败就如实说失败。任何一条都不允许"看起来成功了"。
 * 3. **不绕过后台**：所有真正执行都走 `ToolInvokeService`，因此配额、幂等、
 *    预扣积分、计费开关、执行器白名单**全部照旧生效** ——
 *    助手不是特权通道，它只是多了一个入口。
 *    （若在这里直接 `new` 执行器调用，免费期开关就成了摆设。）
 */
@Injectable()
export class AiDispatchService {
  constructor(
    private readonly registry: OsCapabilityRegistry,
    private readonly invoke: ToolInvokeService,
    private readonly logger: AppLogger,
  ) {}

  /** 模型给的参数 JSON 解析失败时的替代值 */
  async dispatch(input: DispatchInput): Promise<DispatchOutcome> {
    // ---- 门①：白名单。未在目录注册 / 当前不可用的能力，连参数都不解析 ----
    const cap = await this.registry.require(input.toolName);

    const raw = parseArgs(input.rawArgs);
    const params = coerceParams(cap.inputSchema, raw.params);

    // ---- 门②：缺必填项 → 追问，不执行（执行器的兜底值会产出一份用户没要过的东西）----
    const missing = requiredFields(cap.inputSchema).filter((k) => params[k] === undefined);
    if (missing.length) {
      return {
        executed: false,
        forModel:
          `未执行：缺少必填参数 ${missing.map((k) => `${fieldLabel(cap.inputSchema, k)}(${k})`).join('、')}。` +
          `请向用户问清楚再回答，不要自己编一个值。`,
      };
    }

    // ---- 门③：需要文件但对话里没有 → 回引导卡（不是错误，是"还差一步"）----
    if (cap.needsFile && input.fileIds.length === 0) {
      return {
        executed: false,
        forModel:
          `未执行：这个能力需要用户先提供${cap.needsFile}文件，而当前对话里没有。` +
          `请告诉用户「${cap.guideHint ?? '需要先上传文件'}」，界面下方已经给出上传入口，不要说他做不到、也不要假装已经做完。`,
        card: guideCard(cap, params),
      };
    }

    return this.run(cap, input, params);
  }

  /** 真正执行：走统一调用入口，拿结果并整合成"文本 + 卡片" */
  private async run(
    cap: ResolvedCapability,
    input: DispatchInput,
    params: Record<string, unknown>,
  ): Promise<DispatchOutcome> {
    let result: Awaited<ReturnType<ToolInvokeService['invoke']>>;
    try {
      result = await this.invoke.invoke(
        input.userId,
        cap.toolName,
        {
          params,
          fileIds: input.fileIds,
          // 版权声明只能由用户本人在执行页勾选；助手不能代勾，故恒为 false
          //（真正需要声明的能力已在 `OsCapabilityRegistry` 里被剔除，不会走到这里）
          copyrightAck: false,
          // `sync` 来自工具表：秒级工具同步等结果，长任务提交后立刻回进度卡。
          // 不另设配置 —— 否则会出现"工具表说异步、助手却按同步死等"的不一致。
          async: !cap.sync,
          // M2-06：作业归属到本会话未终态的计划 Run（没有时为 undefined，行为不变）
          ...(input.runId ? { runId: input.runId } : {}),
        },
        idempotencyKey(input),
      );
    } catch (e) {
      return { forModel: failureText(cap, e), executed: false };
    }

    // 助手发起的调用必须在日志里可追溯：否则线上只有一条"作业由谁建的"，
    // 查不出它是用户自己在工具页点的、还是助手在对话里代建的（排查成本差很多）
    this.logger.log(
      `助手调度 ${cap.toolName} → 作业 ${result.jobId}（${result.status}${result.reused ? '，幂等复用' : ''}）`,
      'AiDispatch',
    );

    const done = result.status === 'succeeded';
    const card: OsToolCard = {
      kind: 'result',
      toolName: cap.toolName,
      title: cap.title,
      summary: done ? cap.resultHint : `已提交，正在处理（${result.status}）`,
      params: describeParams(cap.inputSchema, params),
      jobId: result.jobId,
      status: result.status,
      ...(result.result?.outputFiles.length
        ? { outputCount: result.result.outputFiles.length }
        : {}),
      ...(done ? {} : { note: '长任务需要排队一会儿，点卡片可以看实时进度' }),
    };

    return { forModel: successText(cap, result, done), executed: true, card };
  }
}

/**
 * 幂等键：`os:<会话>:<工具>:<轮次-序号>`。
 *
 * 为什么要它：模型**会**在同一个回复里发起两次完全一样的调用
 *（协议要求把 `tool_calls` 原样带回，回填错了它就会重复请求）。
 * 没有幂等键时那就是两次执行、两次扣费。
 *
 * ⚠️ 不能只用"工具名 + 参数"当键：用户完全可能在同一会话里
 * 真的有两次一样的请求（先做一版 PPT，看完不满意再按同样的参数做一版），
 * 那样第二次会被静默复用第一次的作业。所以键里必须带上**调用位置**。
 * 长度受 `idempotency_key VarChar(80)` 约束，故最终截断。
 */
function idempotencyKey(input: DispatchInput): string {
  return `os:${input.sessionId}:${input.toolName}:${input.callToken}`.slice(0, 80);
}

/** 解析模型给的参数；格式非法不是异常，是"没有参数" */
function parseArgs(rawArgs: string): { params: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(rawArgs || '{}') as { params?: unknown };
    // 兼容模型把参数直接平铺在顶层（`{"topic":"x"}`）而不是包在 `params` 里
    const bag =
      typeof parsed.params === 'object' && parsed.params !== null
        ? (parsed.params as Record<string, unknown>)
        : parsed;
    return { params: bag as Record<string, unknown> };
  } catch {
    return { params: {} };
  }
}

/**
 * 成功（或已提交）时给模型的文本。
 *
 * 刻意把 `jobId` 与状态写进去：模型据此才能说"已经做好了，点卡片查看"，
 * 而不是含糊地"我帮你处理了"。含糊的措辞在失败时会变成误导。
 */
function successText(
  cap: ResolvedCapability,
  result: { jobId: string; status: string; reused?: boolean },
  done: boolean,
): string {
  const reused = result.reused ? '（这是重复请求，已复用同一次执行，没有重复消耗）' : '';
  return done
    ? `已执行「${cap.title}」，作业 ${result.jobId} 状态 ${result.status}${reused}。` +
        `请告诉用户产物已生成、点下面的卡片即可查看或下载，不要再重复调用本能力。`
    : `已提交「${cap.title}」，作业 ${result.jobId} 正在后台处理${reused}。` +
        `请告诉用户正在生成、点下面的卡片可以看进度，不要再重复调用本能力。`;
}

/** 失败时给模型的文本：**必须包含真实原因**，否则模型会自己编一个 */
function failureText(cap: ResolvedCapability, e: unknown): string {
  const reason = e instanceof BizException ? e.message : ((e as Error)?.message ?? '未知错误');
  return (
    `「${cap.title}」执行失败：${reason}。` +
    `请如实把原因告诉用户（不要说成功，也不要编造一个更友好的理由）。`
  );
}

/**
 * 缺文件时的引导卡。
 *
 * 参数**带进路由**：用户点进执行页时表单已经填好，
 * 不必把刚才说过的话再说一遍 —— 这是"助手理解了你"和"助手只是甩了个链接"的区别。
 */
function guideCard(cap: ResolvedCapability, params: Record<string, unknown>): OsToolCard {
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

  return {
    kind: 'guide',
    toolName: cap.toolName,
    title: cap.title,
    summary: cap.guideHint ?? '需要先上传文件才能执行',
    params: describeParams(cap.inputSchema, params),
    route: `/pkg-toolbox/run/index?toolName=${cap.toolName}${query ? `&${query}` : ''}`,
  };
}
