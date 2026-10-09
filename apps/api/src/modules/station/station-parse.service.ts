import { Inject, Injectable } from '@nestjs/common';
import { OrderStatus, type Providers, sampling } from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { PROVIDERS } from '../../infra/providers/providers.module';

import {
  PARSE_JSON_SCHEMA,
  buildParseMessages,
  normalizeParsed,
  type ParsedDraft,
} from './station-parse';

/** 估价提示所需的最小样本量 */
const PRICE_HINT_MIN_SAMPLES = 3;

/**
 * AI 极速发布（任务清单 M3-07）。
 *
 * ## 用 `intent` 档而不是 `generate` 档
 *
 * 这是**结构化抽取**，不是创作：输入一句话、输出固定字段，
 * 既不需要文采也不需要深度推理。`intent` 档在 `.env` 里配的是最快最便宜的模型，
 * 而这一档的预算（`LLM_TOTAL_BUDGET_MS` 里的同步档）本来就要求
 * **明显小于小程序 30s 请求超时** —— 用 `generate` 或 `plan` 档会让
 * "点了 AI 填表之后转圈十几秒"，而用户只是想要个表单预填。
 *
 * ## 估价提示：只用**真实成交数据**，没有就隐藏
 *
 * 设计文档 6.6.2 的冷启动策略明确写了"无历史价格 → AI 估价功能自动隐藏，不编造价格区间"。
 * 所以这里不是让模型估一个数，而是查同类需求**已成交订单的均价**，
 * 且样本量不足 `PRICE_HINT_MIN_SAMPLES` 时不展示 ——
 * 一单成交算出来的"平均价"没有参考价值，展示出来等于编造。
 */
@Injectable()
export class StationParseService {
  constructor(
    @Inject(PROVIDERS) private readonly providers: Providers,
    private readonly prisma: PrismaService,
    private readonly logger: AppLogger,
  ) {}

  /** 一句话 → 结构化草稿（前端据此预填表单，用户仍可逐项修改） */
  async parseRequirement(text: string): Promise<ParsedDraft & { priceHint?: string }> {
    const raw = await this.providers.llm.structured<unknown>(
      buildParseMessages(text),
      PARSE_JSON_SCHEMA,
      // 低温度：这是抽取任务，不需要"发挥"
      { tier: 'intent', ...sampling('extract') },
    );

    const draft = normalizeParsed(raw, text);
    const categoryId = await this.usableCategory(draft.categoryId);
    const priceHint = await this.priceHint(categoryId);

    return {
      ...draft,
      ...(categoryId ? { categoryId } : {}),
      ...(priceHint ? { priceHint } : {}),
    };
  }

  /**
   * 校验分类 id 真的存在。
   *
   * 提示词里给了白名单，但**不能只信提示词** —— 分类表是运维可改的，
   * 一旦某个分类被下架，模型仍会照旧输出它的 id，
   * 而用户提交时会撞上"服务分类不存在"（40001）。在这里挡掉，用户就只会看到"没预填分类"。
   */
  private async usableCategory(id: string | undefined): Promise<string | undefined> {
    if (!id) return undefined;
    const row = await this.prisma.serviceCategory.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!row) {
      this.logger.warn(`AI 解析出的分类「${id}」不存在，已忽略`, 'StationParse');
      return undefined;
    }
    return id;
  }

  /** 同类需求的历史成交均价（样本不足则返回 undefined → 前端隐藏该提示） */
  private async priceHint(categoryId: string | undefined): Promise<string | undefined> {
    if (!categoryId) return undefined;

    const agg = await this.prisma.order.aggregate({
      where: { status: OrderStatus.Completed, task: { categoryId } },
      _avg: { amount: true },
      _count: { _all: true },
    });

    const samples = agg._count._all;
    const avg = agg._avg.amount;
    if (samples < PRICE_HINT_MIN_SAMPLES || !avg) return undefined;

    return `同类需求已成交 ${samples} 单，平均 ¥${Math.round(avg / 100)}`;
  }
}
