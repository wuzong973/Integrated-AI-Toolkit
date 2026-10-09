import { Injectable } from '@nestjs/common';

/** 内部能力名（与 `ai-capability.catalog.ts` 的 toolName 逐字一致） */
export const PARSE_REQUIREMENT = 'parse_requirement';
export const SEARCH_SERVICE_PROVIDER = 'search_service_provider';

import { StationParseService } from '../station/station-parse.service';
import type { ServiceItemDto } from '../service/dto/service.dto';
import { ServiceService } from '../service/service.service';

/**
 * 校园能力工具（**内部能力**，不进工具箱 UI）
 *
 * ## 它解决什么
 *
 * 改造前助手的"手"只有 `search_knowledge`：用户说"帮我发个单"，
 * 它只能回"我做不到"，而平台里驿站发布、服务市场检索**早就打通了**。
 * **不是没实现，是没接线。**
 *
 * ## 为什么只接这三个（而不是 seed 里全部 8 个）
 *
 * 内部能力按**副作用**分两类，混在一起接是危险的：
 *
 * | 类别 | 工具 | 处置 |
 * |---|---|---|
 * | 只读 / 解析 | `parse_requirement`、`search_service_provider`、`calculate_price` | **本次接入**：调用不改变任何数据，失败也无副作用 |
 * | 写操作 | `create_task`、`create_order`、`send_notification` | **不接入**：一次误调用就会真的发布需求、真的下单扣款、真的给别人发通知 |
 *
 * 写操作不是"接上就行"的：`create_order` 会走担保支付预扣，
 * 模型在参数理解偏差时（把"预算 50 元"当成"50 分"）会**真的产生一笔订单**。
 * 这类能力需要"先给用户看将要执行什么 → 用户确认 → 再执行"的两段式，
 * 而那套交互（确认卡）尚未落地，所以宁可先不接 —— 让助手如实说
 * "我可以帮你把需求整理好，发布请点下面按钮"，而不是拿用户的账号去冒险。
 *
 * ## 为什么进程内直调 service 而不走作业链路
 *
 * 工具箱能力是"输入 → 产出文件"，走作业 + 产物那套。
 * 而这三个的产物是**给模型读的结构化数据**（一份草稿、一个服务列表、一个价格区间），
 * 既不落"我的文件"，也不需要扣配额，所以归内部能力：进程内直调服务，`resultKind: 'text'`。
 */
@Injectable()
export class CampusTool {
  constructor(
    private readonly parse: StationParseService,
    private readonly services: ServiceService,
  ) {}

  /**
   * 把一句话需求解析成结构化草稿（驿站发布用）。
   *
   * 复用的就是"AI 极速发布"那条链路（`intent` 档 + 低温度 + 真实成交价提示），
   * 因此助手给出的草稿与用户在发布页点"AI 帮我填"得到的**完全一致** ——
   * 不存在"助手一套、页面另一套"的口径分裂。
   */
  async parseRequirement(rawArgs: string): Promise<ToolOutcomePlain> {
    const requirement = strField(rawArgs, 'requirement');
    if (!requirement) {
      return fail('缺少 requirement 参数：请把用户的需求原话传进来。');
    }

    try {
      const draft = await this.parse.parseRequirement(requirement);
      return {
        forModel: formatDraft(draft),
        // 只解析、不发布：模型必须让用户自己去发布页确认
        executed: true,
      };
    } catch (e) {
      return fail(`解析需求失败：${errText(e)}。请如实告知用户，并建议他直接去驿站发布页填写。`);
    }
  }

  /**
   * 在服务市场检索服务者 / 服务。
   *
   * 只出 `status='on'` 的上架服务（`ServiceService.listServices` 已内置），
   * 因此助手不会把已下架、未过审的东西推荐给用户。
   */
  async searchProviders(rawArgs: string): Promise<ToolOutcomePlain> {
    const keyword = strField(rawArgs, 'keyword') || undefined;
    const categoryId = strField(rawArgs, 'categoryId') || undefined;
    if (!keyword && !categoryId) {
      return fail('缺少 keyword 或 categoryId：至少要有一个检索条件，否则会把整个市场都捞出来。');
    }

    try {
      // pageSize 压到 5：给模型的是"候选"，不是完整列表。
      // 捞 20 条会让上下文被无关服务淹没，反而降低它挑对的概率。
      const page = await this.services.listServices({
        ...(keyword ? { keyword } : {}),
        ...(categoryId ? { categoryId } : {}),
        page: 1,
        pageSize: 5,
      });
      return { forModel: formatServices(page.list), executed: true };
    } catch (e) {
      return fail(`检索服务失败：${errText(e)}。请如实告知用户，不要凭印象推荐服务者。`);
    }
  }
}

/** 内部能力的返回形状（与 `KnowledgeTool.run` 保持一致，便于统一分流） */
export interface ToolOutcomePlain {
  forModel: string;
  executed: boolean;
}

function fail(forModel: string): ToolOutcomePlain {
  return { forModel, executed: false };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : '未知错误';
}

/** 草稿 → 给模型读的文本。金额从「分」换算回「元」，模型不必自己算 */
function formatDraft(draft: {
  title: string;
  description?: string;
  categoryId?: string;
  budget?: number;
  time?: string;
  location?: string;
  skillTags: string[];
  priceHint?: string;
}): string {
  const lines = [`已解析出草稿：`, `- 标题：${draft.title}`];
  if (draft.description) lines.push(`- 描述：${draft.description}`);
  if (draft.categoryId) lines.push(`- 分类 id：${draft.categoryId}`);
  if (draft.budget !== undefined) lines.push(`- 预算：${(draft.budget / 100).toFixed(2)} 元`);
  if (draft.time) lines.push(`- 时间：${draft.time}`);
  if (draft.location) lines.push(`- 地点：${draft.location}`);
  if (draft.skillTags.length) lines.push(`- 技能标签：${draft.skillTags.join('、')}`);
  if (draft.priceHint) lines.push(`- 同类成交价参考：${draft.priceHint}`);
  lines.push(
    '',
    '说明：这只是**草稿**，尚未发布。请把要点转述给用户确认，并告诉他去驿站发布页发布。',
  );
  return lines.join('\n');
}

/** 服务列表 → 给模型读的文本 */
/** 服务列表 → 给模型读的文本。价格带单位与交付周期，模型不必自己换算 */
function formatServices(items: ServiceItemDto[]): string {
  if (!items.length) {
    return '没有检索到上架中的相关服务。请如实告知用户"暂时没有匹配的服务"，不要编造服务者。';
  }
  const lines = items.map((s, i) => {
    const price = `${(s.price / 100).toFixed(2)} 元${priceUnitText(s.priceUnit)}`;
    const extra = [`交付约 ${s.deliveryDays} 天`, serviceAreaText(s.serviceArea)];
    const tags = s.skillTags.length ? `标签：${s.skillTags.join("、")}` : "";
    return [
      `${i + 1}. ${s.title}（${price}）`,
      `   说明：${s.description}`,
      `   信息：${extra.filter(Boolean).join(" · ")}${tags ? " · " + tags : ""}`,
    ].join("\n");
  });
  return [
    '检索到以下上架中的服务：',
    ...lines,
    '',
    '说明：这些是**市场里的候选**。请把最相关的 1~2 个转述给用户（含价格与交付周期），' +
      '并提示他点服务卡查看详情与下单。不要替用户下结论说"就选这个"。',
  ].join("\n");
}

/** 价格单位的中文说法（与 service.dto.ts 的取值一一对应） */
function priceUnitText(unit: string): string {
  if (unit === "hourly") return "/小时";
  if (unit === "negotiable") return "（面议）";
  return "";
}

/** 服务范围的中文说法 */
function serviceAreaText(area: string): string {
  if (area === "school") return "校内";
  if (area === "city") return "同城";
  if (area === "remote") return "远程";
  return "";
}

/**
 * 从模型给的参数里安全读一个字符串字段。
 *
 * 容忍三种实际出现过的形态：合法 JSON、外层带说明文字、以及纯字符串本身。
 * 读不到就返回空串 —— 由各能力自己回"缺参数"，比在这里编一句通用错误更准确。
 */
function strField(rawArgs: string, key: string): string {
  const raw = (rawArgs ?? '').trim();
  if (!raw) return '';
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const v = (parsed as Record<string, unknown>)[key];
      return typeof v === 'string' ? v.trim() : '';
    }
    // 模型偶尔直接把一句话当参数传（没包 JSON），按 key 的语义接受它
    if (typeof parsed === 'string') return parsed.trim();
  } catch {
    // 不是 JSON：若是 requirement 这种"本该是原话"的字段，直接把原文当值
  }
  return key === 'requirement' ? raw : '';
}
