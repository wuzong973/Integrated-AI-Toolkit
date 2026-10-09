import { Injectable } from '@nestjs/common';
import type { LlmToolSpec, OsIntentName } from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { ToolExecutorService } from '../job/tool-executor.service';

import { AI_CAPABILITY_CATALOG } from './ai-capability.catalog';
import { buildToolDescription, toModelParams } from './ai-capability.schema';
import { findCapability, type AiCapability } from './ai-capability.types';

/**
 * 一条**已对账**的能力：目录声明 ∧ 数据库 active ∧ 执行器已接入
 */
export interface ResolvedCapability extends AiCapability {
  /** 展示名（来自工具表，与工具箱里看到的一致） */
  displayName: string;
  /** 单次消耗积分（来自工具表；免费期由 `BillingService` 统一短路，这里只是如实展示） */
  price: number;
  /**
   * 工具表里的 `sync`：true = 秒级完成，false = 需要排队跑几十秒以上。
   *
   * 调度层直接用它决定"同步等结果"还是"提交后回一张进度卡"——
   * 不再另设一套配置，避免"工具表说是异步、助手却按同步等"这种不一致。
   */
  sync: boolean;
  /** 参数的 JSON Schema（来自工具表，与执行页表单**同源**） */
  inputSchema: unknown;
}

/** 对账时被丢掉的能力（供 `/os/capabilities` 与守卫脚本如实展示） */
export interface DroppedCapability {
  toolName: string;
  reason: string;
}

/** 对账结果 */
export interface CapabilitySnapshot {
  available: ResolvedCapability[];
  dropped: DroppedCapability[];
}

/**
 * 缓存时长（毫秒）。
 *
 * 每次对话都会问一次"助手能用哪些能力"，而工具表在运行期几乎不变 ——
 * 不缓存就是每条消息一次多余查询。60 秒是个折中：
 * 运维在后台把某个工具下线后，最多一分钟就会在助手里生效
 *（而不是等到下次重启，也不是每条消息都查库）。
 */
const CACHE_TTL_MS = 60_000;

/**
 * AI 能力注册表（任务清单 M2-08「Tool Registry 正式化」的对话侧实现）
 *
 * ## 它解决的问题
 *
 * 助手的能力清单此前是**手写散文**（`CHAT_SYSTEM_PROMPT` 里那句
 * "平台当前真正可用的能力只有这些"）。写的时候是对的，
 * 但没有任何机制保证它继续对 —— 2026-09-17 检查出"18 个 active 里 9 个跑不通"，
 * 而提示词当时还在向用户承诺它们。**助手会一本正经地告诉用户一个不存在的功能**。
 *
 * 本类把"清单"变成**算出来的**：目录声明能力，这里与 seed / 执行器对账，
 * 提示词与工具 spec 都由对账结果生成。漂移不再是"AI 变笨了"这种无声故障，
 * 而是被丢掉 + 记日志 + 被 `npm run check:ai-capabilities` 拦住。
 *
 * ## M2-08 的验收要求「未注册工具无法调用」
 *
 * 这里是对应实现：`specs()` 只返回对账通过的能力，
 * 所以模型**根本看不到**未注册工具的名称；即使它把名字猜出来
 *（`dispatch` 里另有一次白名单校验），调用也会被拒。
 * 两道门都必须有：只靠"模型看不到"是安全假设，不是校验。
 */
@Injectable()
export class OsCapabilityRegistry {
  private cache: { at: number; value: CapabilitySnapshot } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly executor: ToolExecutorService,
    private readonly logger: AppLogger,
  ) {}

  /**
   * 与真实可运行状态对账。
   *
   * 判定一条 `source: 'tool'` 的能力是否可用：
   *   ① 工具表里存在（否则用户点开工具箱也找不到它）
   *   ② `status === 'active'`（与界面上的"免费/即将上线"角标同一个判据）
   *   ③ `executor.supports()`（真的能跑，而不是只有一行登记）
   *
   * `source: 'internal'` 的能力不查工具表：它们本来就是 Agent 内部实现，
   * 由 `npm run check:ai-capabilities` 静态核对"目录里的内部能力名是否真在
   * `os-tools.ts` 里实现了"（运行期无从判断，只能静态守卫）。
   */
  async resolve(): Promise<CapabilitySnapshot> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.value;
    }

    const toolCaps = AI_CAPABILITY_CATALOG.filter((c) => c.source === 'tool');
    const internal = AI_CAPABILITY_CATALOG.filter((c) => c.source === 'internal');

    const rows = await this.prisma.tool.findMany({
      where: { name: { in: toolCaps.map((c) => c.toolName) } },
      select: {
        name: true,
        displayName: true,
        status: true,
        price: true,
        sync: true,
        requiresCopyrightAck: true,
        inputSchema: true,
      },
    });
    const byName = new Map(rows.map((r) => [r.name, r]));

    const available: ResolvedCapability[] = [];
    const dropped: DroppedCapability[] = [];

    for (const cap of toolCaps) {
      const row = byName.get(cap.toolName);
      const reason = rejectReason(row, this.executor.supports(cap.toolName));
      if (reason) {
        dropped.push({ toolName: cap.toolName, reason });
        continue;
      }
      available.push({
        ...cap,
        displayName: row!.displayName,
        price: row!.price,
        sync: row!.sync,
        inputSchema: row!.inputSchema,
      });
    }

    // 内部能力直接可用（其实现与参数规范由静态守卫核对）
    for (const cap of internal) {
      if (!cap.params) {
        dropped.push({ toolName: cap.toolName, reason: '内部能力未声明 params（输入规范缺失）' });
        continue;
      }
      available.push({
        ...cap,
        displayName: cap.title,
        price: 0,
        // 内部能力是本地一次检索/计算，一律按同步处理
        sync: true,
        inputSchema: cap.params,
      });
    }

    if (dropped.length) {
      // 必须记日志：否则"能力在目录里、却永远不进提示词"是一种无声的失效
      this.logger.warn(
        `AI 能力目录对账丢弃 ${dropped.length} 项：` +
          dropped.map((d) => `${d.toolName}(${d.reason})`).join('、'),
        'OsCapability',
      );
    }

    const value = { available, dropped };
    this.cache = { at: Date.now(), value };
    return value;
  }

  /** 断言某能力**此刻**可被助手调用（dispatch 的第二道门） */
  async require(toolName: string): Promise<ResolvedCapability> {
    const cap = findCapability(AI_CAPABILITY_CATALOG, toolName);
    if (!cap) {
      throw new Error(`未在 AI 能力目录里注册：${toolName}`);
    }
    const { available } = await this.resolve();
    const hit = available.find((c) => c.toolName === toolName);
    if (!hit) {
      throw new Error(`能力「${toolName}」当前不可用（未上线或执行器未接入）`);
    }
    return hit;
  }

  /**
   * 生成给模型的工具 spec。
   *
   * `guided`（需要用户先传文件）的能力**也会列出来**，只是描述里会明确写出
   * "没文件不要调用"。这个取舍是刻意的：
   * 完全隐藏会让助手面对"帮我把图压小"只能答"我做不到" ——
   * 能力明明存在、助手却不知道，这是最冤的一种失败。
   * 而"列出来 + 叮嘱别调 + 调度层强制兜底"（见 `AiDispatchService`）三件一起做，
   * 既让助手答得对，又不会伪造一个没执行的成功。
   */
  async specs(): Promise<LlmToolSpec[]> {
    const { available } = await this.resolve();
    return available.map((cap) => ({
      name: cap.toolName,
      description: buildToolDescription({
        title: cap.title,
        scene: cap.scene,
        notFor: cap.notFor,
        needsFile: cap.needsFile,
        guideHint: cap.guideHint,
      }),
      // 工具能力的 schema 来自 DB（含 title/enumLabels/x-widget 等**只给表单用**的键），
      // 必须先转成模型可用的 JSON Schema；内部能力的 params 本来就是模型格式
      parameters:
        cap.source === 'tool'
          ? toModelParams(cap.inputSchema)
          : (cap.inputSchema as Record<string, unknown>),
    }));
  }

  /**
   * 系统提示词里的能力清单。
   *
   * 由对账结果生成，**不再手写** —— 这是本次改动的核心：
   * 提示词里出现的每个能力都保证能跑，能跑的能力也一定会出现在提示词里。
   */
  async promptLines(): Promise<string[]> {
    const { available } = await this.resolve();
    return available.map((cap) => {
      const need = cap.needsFile ? `（需用户先上传${fileLabel(cap.needsFile)}）` : '';
      return `- ${cap.displayName}${need}：${cap.scene}`;
    });
  }

  /** 按意图分组（供 `/os/capabilities` 与前端路由使用） */
  async byIntent(): Promise<Record<OsIntentName, ResolvedCapability[]>> {
    const { available } = await this.resolve();
    const out = {} as Record<OsIntentName, ResolvedCapability[]>;
    for (const cap of available) {
      (out[cap.intent] ??= []).push(cap);
    }
    return out;
  }

  /** 测试与运维用：丢弃缓存，下次重新对账 */
  invalidate(): void {
    this.cache = null;
  }
}

/**
 * 判定一条工具能力为何不可用；返回 `null` 表示可用。
 *
 * 顺序按"越靠前越根本"排：先确认存在，再看上线状态，最后看执行器 ——
 * 这样报出来的原因才是根因（而不是"执行器没接入"这种下游症状）。
 */
function rejectReason(
  row: { status: string; requiresCopyrightAck: boolean } | undefined,
  supported: boolean,
): string | null {
  if (!row) return '工具表里没有这条记录（可能尚未入库或名字写错）';
  if (row.status !== 'active') return `状态是 ${row.status}，尚未上线`;
  if (!supported) return '执行器未接入（标了 active 却跑不通）';
  // 版权声明必须由用户本人在执行页勾选，助手不能代勾 —— 让模型调用等于绕过合规前置
  if (row.requiresCopyrightAck) return '需要用户本人勾选版权声明，助手不代为确认';
  return null;
}

function fileLabel(kind: string | false): string {
  const map: Record<string, string> = { image: '图片', audio: '音频', video: '视频', text: '文本' };
  return typeof kind === 'string' ? (map[kind] ?? '') : '';
}
