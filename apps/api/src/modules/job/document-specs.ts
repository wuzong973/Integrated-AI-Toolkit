/**
 * AI 文档生成的写作骨架（`generate_document` 的数据表）
 *
 * ## 为什么单独成文件
 *
 *   ① 这是**数据**不是逻辑 —— 与 `apps/mp/pkg-toolbox/run/field-presets.ts`、
 *      `apps/api/prisma/tool-input-schemas.ts` 同性质，都是"给执行链查表用"；
 *   ② 执行器 `llm-tool-runner.ts` 有 300 行红线，五份骨架塞进去会直接把文件顶穿。
 *
 * ## 为什么每类文档都要单独给骨架
 *
 * 这五类的差别主要在**结构**而不是措辞：活动策划少了"流程 / 物料 / 预算"就不是策划书，
 * 商业计划书少了"市场 / 竞品 / 财务"就只是一篇介绍文。
 * 只给一句"写一份活动策划"，模型十次里有八次会写成散文 ——
 * 把结构写死、把内容交给模型，才是"生成出来能直接用"的前提。
 *
 * ## 每个 system 里那句"不许编造"
 *
 * 不是套话。这类工具最大的坑是模型顺手写出"据艾瑞咨询 2024 年报告，市场规模达 XX 亿" ——
 * 数字看着专业、实则不存在，而用户会直接把它放进要交的材料里。
 * 所以要求**要么标注为示例、要么写成"需进一步核实"**，让"这个数字从哪来"始终可追。
 */

import {
  MIN_ITEMS_PER_SECTION,
  minCharsFor,
  requiredSectionsFor,
} from '@qz/core';

/** 支持的文档类型。取值必须与 `tool-input-schemas.ts` 里 `docType` 的 enum 一致 */
export const DOC_TYPES = [
  'business_plan',
  'event_plan',
  'resume',
  'report',
  'summary',
] as const;

export type DocType = (typeof DOC_TYPES)[number];

/**
 * 把质量标准拼成"模型当场能执行"的硬约束。
 *
 * 为什么下限要写进提示词：只写"内容丰富一些"等于没写。模型需要一个可自检的数字，
 * 而且这个数字必须与生成后质检、单测用的是**同一份**（`@qz/core` 的 standard.ts）——
 * 否则提示词要求 2000 字、质检卡 3000 字，模型永远"不达标"。
 */
function contentRules(docType: DocType): string {
  const minChars = minCharsFor(docType);
  const required = requiredSectionsFor(docType);
  return (
    `硬性要求：正文不少于 ${minChars} 字（中文字符计，不含 Markdown 符号）；` +
    `每个一级章节至少 ${MIN_ITEMS_PER_SECTION} 段实质性内容或要点，禁止只有标题没有正文；` +
    `必须覆盖以下要素：${required.join('、')}；` +
    '用二级标题、列表、表格形成清晰层级，避免全篇一个句式；' +
    '重复性套话会被质检判定为不合格，宁可写短句也要有具体信息。'
  );
}

/** 单个文档类型的写作规范 */
export interface DocumentSpec {
  /** 中文名：用于产物文件名，也用于让模型自述"我在写什么" */
  label: string;
  /** 系统提示：定角色与输出纪律 */
  system: string;
  /** 章节骨架，拼进用户提示 */
  outline: string;
  /** 生成上限。⚠️ 骨架越长越容易顶到上限（推理型模型还会先花在 reasoning 上） */
  maxTokens: number;
}

export const DOCUMENT_SPECS: Record<DocType, DocumentSpec> = {
  business_plan: {
    label: '商业计划书',
    system:
      '你是校园创业项目的商业计划书顾问。输出中文 Markdown，章节用 ##，条目化、不写空话套话；' +
      '市场规模、增长率这类数字必须标注「示例数据，请按实际替换」，不要冒充真实统计口径。' +
      contentRules('business_plan'),
    outline:
      '项目概述 / 用户痛点 / 产品与解决方案 / 市场规模 / 竞品分析 / 商业模式与定价 / ' +
      '团队与分工 / 里程碑 / 风险与对策',
    maxTokens: 6000,
  },
  event_plan: {
    label: '活动策划',
    system:
      '你是校园活动策划人。输出中文 Markdown，一切以「可执行」为准：' +
      '时间、地点、人、物料、钱都要能落地；预算用表格，单价不确定时标注「待询价」。' +
      contentRules('event_plan'),
    outline:
      '活动背景与目标 / 目标人群 / 时间与地点 / 活动流程（时间轴）/ 宣传方案 / ' +
      '物料清单与预算 / 人员分工 / 风险预案',
    maxTokens: 5200,
  },
  resume: {
    label: '简历',
    system:
      '你是校园就业指导老师。量化成果、动词开头、删掉空话；' +
      '用户没提供的经历不要编造，宁可留「待补充」或标注「示例，请替换」。' +
      contentRules('resume'),
    outline: '个人信息 / 求职意向 / 教育背景 / 专业技能 / 项目与实习经历 / 荣誉奖项 / 自我评价',
    maxTokens: 3600,
  },
  report: {
    label: '报告',
    system:
      '你是严谨的中文报告撰写者。结论先行、论据在后；' +
      '引用数据必须说明来源，没有来源的一律写成「需进一步核实」，不要凭印象给数字。' +
      contentRules('report'),
    outline: '摘要 / 背景与目的 / 现状与数据 / 问题分析 / 结论与建议 / 后续计划',
    maxTokens: 3500,
  },
  summary: {
    label: '总结',
    system:
      '你是中文写作助手。总结要条理清晰、有反思、有下一步，避免写成流水账；不要堆砌形容词。' +
      contentRules('summary'),
    outline: '整体回顾 / 主要成果 / 问题与不足 / 经验与反思 / 下一步计划',
    maxTokens: 2500,
  },
};
