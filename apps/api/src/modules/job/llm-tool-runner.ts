import { Inject, Injectable } from '@nestjs/common';
import { BizException, ErrorCode, type Providers } from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import { PROVIDERS } from '../../infra/providers/providers.module';
import { FileService } from '../file/file.service';

import { DOC_TYPES, DOCUMENT_SPECS } from './document-specs';
import { runLlmChain } from './llm-run-chain';
import { attachRenderedDiagram } from './mindmap-render';
import type { ToolRunContext, ToolRunResult } from './tool-executor.service';

/** 单个文本类工具的提示词与产物定义 */
export interface LlmToolSpec {
  /** 系统提示：定角色与输出格式 */
  system: string;
  /** 用户提示（由各工具拼装自己的参数） */
  prompt: string;
  /** 产物文件名 */
  filename: string;
  /**
   * 质检维度：传了就在生成后按该文档类型的标准打分并记日志。
   * 不传则跳过（翻译这类要求忠实原文的产物不适用字数下限）。
   */
  qualityDocType?: string;
  /** 生成上限。⚠️ 推理型模型会先花 token 在 reasoning 上，不能给太小 */
  maxTokens?: number;
  /**
   * 显式关闭思考（见 `LlmCallOptions.disableThinking`）。
   *
   * 给"**输出结构固定、不需要推理**"的重生成工具用（思维导图 / 文档大纲这类）：
   * 实测同一 prompt 关掉思考后耗时 23.6s → 3.6s、`completion_tokens` 2016 → 314，
   * 且产物更精炼（去掉了冗余铺陈）。
   *
   * 反过来，**需要判断/权衡**的工具（解题、论文摘要）不要开这个 —— 会丢掉推理收益。
   */
  disableThinking?: boolean;
}

/**
 * 文本类工具执行器（M1-07）
 *
 * 覆盖"输入是文字、产出也是文字"的工具：AI 大纲、长文总结、生图提示词等。
 * 它们唯一的差别是提示词，因此共用一条执行链：LLM 生成 → 存成可下载的 Markdown。
 *
 * ## 为什么产物是文件而不是直接把文本返回给前端
 *
 * 执行记录 / 结果页的产物展示走 `outputFiles`（可下载、可转交他人），
 * 文本类工具保持同一条 UX，用户才可能把"AI 写的大纲"发给别人继续加工。
 *
 * ## 为什么不在这里做"LLM 失败就回退到模板"
 *
 * 回退会让用户分不清"这是 AI 写的还是模板填的"—— 而模板内容一旦被当成 AI 成果，
 * 比失败更糟（这批工具的价值恰恰在"真 AI"）。所以失败就让作业失败并给出原因。
 */
@Injectable()
export class LlmToolRunner {
  constructor(
    @Inject(PROVIDERS) private readonly providers: Providers,
    private readonly files: FileService,
    private readonly logger: AppLogger,
  ) {}

  /** AI 生成大纲 */
  async outline(ctx: ToolRunContext): Promise<ToolRunResult> {
    const topic = requireStr(ctx.params.topic, '主题');
    const depth = toInt(ctx.params.depth, 2, 1, 3);

    return this.run(ctx, 'generate_outline', {
      system:
        '你是校园场景的内容策划助手，输出层级清晰的中文大纲，使用 Markdown 标题与列表，不要解释。' +
        '每个要点必须是可独立阅读的完整句子，不要只写名词短语；全文不少于 800 字。',
      prompt:
        `为「${topic}」写一份 ${depth} 层级的大纲。` +
        `用 ## 表示一级、### 表示二级（depth=3 时再加 #### 三级），每个二级下给 3-4 条要点，` +
        `每条 15-40 字并说明「做什么、为什么、怎么落地」。`,
      filename: `${topic}-大纲.md`,
      // sync 工具：用户同步等结果，耗时直接等于他的等待时间，所以关思考。
      // 2026-09-20 实测（glm-4.5-air，接近生产输入上限）：开思考 4.9~7.1s，
      // 关思考 1.2~1.9s，产物长度基本一致（151 vs 165 字）。
      // 这类"输出结构固定"的任务拿不到推理收益，却要用户多等 3~5 秒。
      disableThinking: true,
      qualityDocType: 'outline',
    });
  }

  /** 长文总结：读入参文件 → 提取文本 → LLM 摘要 */
  async summarize(ctx: ToolRunContext): Promise<ToolRunResult> {
    const length = toEnum(ctx.params.length, ['short', 'medium', 'long'] as const, 'medium');
    const want = { short: 3, medium: 5, long: 8 }[length];

    const src = await this.files.readObject(ctx.userId, firstInput(ctx));
    const text = src.buffer.toString('utf8').trim();
    const name = src.name || 'input.txt';

    // 只接受纯文本类输入。PDF/Word 需要文档解析能力（doc-parse，M4 接入），
    // 硬解析二进制会把乱码喂给模型 —— 明确拒绝比假装总结更诚实。
    if (!/\.(txt|md|markdown|csv|json|log)$/i.test(name)) {
      throw new BizException(
        ErrorCode.FileFormatUnsupported,
        undefined,
        `「${name}」不是纯文本，暂只支持 .txt/.md 等文本文件（PDF/Word 解析能力接入中）`,
      );
    }
    if (text.length < 50) {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '文件内容太短，无需总结');
    }

    return this.run(ctx, 'summarize_text', {
      system: '你是专业的中文编辑，总结忠实于原文、不编造事实，输出 Markdown。',
      prompt:
        `请把下面的内容总结成 ${want} 条要点（每条不超过 40 字），最后给一段 100 字以内的整体结论。\n\n` +
        `【原文开始】\n${text.slice(0, 24000)}\n【原文结束】`,
      filename: `${stripExt(name)}-总结.md`,
      // 提示词要求「N 条要点 + 整体结论」，缺结论即结构不完整（Q2）
      qualityDocType: 'summarize',
      // sync 工具：用户同步等结果，耗时直接等于他的等待时间，所以关思考。
      // 2026-09-20 实测（glm-4.5-air，接近生产输入上限）：开思考 4.9~7.1s，
      // 关思考 1.2~1.9s，产物长度基本一致（151 vs 165 字）。
      // 这类"输出结构固定"的任务拿不到推理收益，却要用户多等 3~5 秒。
      disableThinking: true,
    });
  }

  /** AI 生图提示词 */
  async imagePrompt(ctx: ToolRunContext): Promise<ToolRunResult> {
    const subject = requireStr(ctx.params.subject, '画面主体');
    const style = toEnum(
      ctx.params.style,
      ['realistic', 'illustration', 'anime', '3d'] as const,
      'realistic',
    );
    const styleLabel = {
      realistic: '写实摄影',
      illustration: '插画',
      anime: '二次元',
      '3d': '3D 渲染',
    }[style];

    return this.run(ctx, 'generate_image_prompt', {
      system:
        '你是 AI 绘画提示词专家。输出：① 一段可直接使用的中文提示词；' +
        '② 一段对应的英文提示词（Stable Diffusion / Midjourney 风格）；' +
        '③ 3 个负面提示词。使用 Markdown 分节，不要解释你在做什么。',
      prompt: `画面主体：${subject}。风格：${styleLabel}。请给出完整、可直接使用的提示词。`,
      filename: `${subject}-提示词.md`,
      maxTokens: 1500,
      // sync 工具：用户同步等结果，耗时直接等于他的等待时间，所以关思考。
      // 2026-09-20 实测（glm-4.5-air，接近生产输入上限）：开思考 4.9~7.1s，
      // 关思考 1.2~1.9s，产物长度基本一致（151 vs 165 字）。
      // 这类"输出结构固定"的任务拿不到推理收益，却要用户多等 3~5 秒。
      disableThinking: true,
    });
  }

  /** 简历生成：按岗位定制，输出结构化 Markdown */
  async resume(ctx: ToolRunContext): Promise<ToolRunResult> {
    const position = requireStr(ctx.params.position, '目标岗位');
    const name = toStr(ctx.params.name).trim() || '同学';
    const highlights = toStr(ctx.params.highlights).trim();

    return this.run(ctx, 'generate_resume', {
      system:
        '你是校园就业指导老师，写中文简历。要求：量化成果、动词开头、去掉空话套话；' +
        '没有提供的信息**不要编造**（宁可留「待补充」）。输出 Markdown，不要额外解释。',
      prompt:
        `为「${name}」写一份应聘「${position}」的简历，包含：个人信息、求职意向、教育背景、` +
        `技能、项目/实习经历、自我评价。\n` +
        (highlights
          ? `\n【已有素材，优先使用】\n${highlights}`
          : '\n没有提供素材，经历部分请给出可直接替换的示例条目并标注「示例，请替换」。'),
      filename: `${name}-${position}-简历.md`,
      maxTokens: 2500,
      // 标准表里已有 resume 维度（章节骨架 + 900 字下限），但这条工具此前没接 ——
      // 于是「简历太短 / 缺章节」永远不会被发现（Q2）。
      qualityDocType: 'resume',
    });
  }

  /**
   * AI 文档生成：五类文档各给一套骨架（见 `document-specs.ts`），内容交给模型。
   *
   * 与 `generate_resume` 的分工：简历有独立入口（用户会反复按岗位改），
   * 这里保留 `docType=resume` 只是"顺手也要一份"的兜底 —— 两者共用同一条执行链、
   * 也共用同一条"没提供的信息不许编造"的纪律，所以不会出现两套行为。
   */
  async document(ctx: ToolRunContext): Promise<ToolRunResult> {
    const docType = toEnum(ctx.params.docType, DOC_TYPES, 'business_plan');
    const topic = requireStr(ctx.params.topic, '主题');
    const extra = toStr(ctx.params.extra).trim();
    const spec = DOCUMENT_SPECS[docType];

    return this.run(ctx, 'generate_document', {
      system: spec.system,
      prompt:
        `主题：${topic}\n请按以下章节组织（Markdown，## 为一级章节）：${spec.outline}\n` +
        (extra ? `补充要求：${extra}\n` : ''),
      filename: `${topic}-${spec.label}.md`,
      maxTokens: spec.maxTokens,
      qualityDocType: docType,
    });
  }

  /** 思维导图：输出 Mermaid mindmap，可直接贴进支持 Mermaid 的编辑器渲染 */
  async mindmap(ctx: ToolRunContext): Promise<ToolRunResult> {
    const topic = requireStr(ctx.params.topic, '主题');
    const depth = toInt(ctx.params.depth, 3, 2, 4);

    const result = await this.run(ctx, 'generate_mindmap', {
      system:
        '你是知识结构梳理专家。输出两部分：① 缩进的 Markdown 层级列表；' +
        '② 一段 Mermaid mindmap 代码块（缩进必须合法，节点文字用中文）。不要解释。',
      prompt:
        `围绕「${topic}」生成思维导图，深度 ${depth} 层，每层 3-6 个分支，覆盖主要维度；` +
        `每个节点用 4-12 字的具体表述，不要出现「其他」「等等」这类空节点。`,
      filename: `${topic}-思维导图.md`,
      // ⚠️ 这个工具曾是"唯一跑不通的 active 工具"。根因**不是输出太长**，而是
      // **思考 token 失控**：`reasoning_effort: low` 在复杂生成任务上压不住 ——
      // 实测 reasoning 占 token 的 60~75%、耗时 23.6~31.1s，**恰好在 30s 单次
      // 超时线上反复横跳**（这才是"时通时不通"的原因）；`max_tokens=2500` 时更会
      // 推理吃光、`content` 为 0 字。关掉思考后 reasoning 归零、耗时 **3.6s**，
      // 产物结构完整且更精炼（571 字：5 维度 × 3 子项 + 合法 Mermaid）。
      disableThinking: true,
      // 关思考后实测只需 ~314 个 completion token。给 4000 是留足余量
      //（用户把 `depth` 调到 4 时分支数会明显变多）。
      maxTokens: 4000,
      // 标准表里已有 mindmap 维度（核心 / 分支 / 应用 + 600 字下限）
      qualityDocType: 'mindmap',
    });
    // 增量产物：文本落库后尝试把 Mermaid 渲染成 PNG 分享图。
    // 渲染失败只 warn、不影响文本结果 —— 分享图挂了不能让作业作废（见 mindmap-render.ts）。
    return attachRenderedDiagram(ctx, result, {
      providers: this.providers,
      files: this.files,
      logger: this.logger,
    });
  }

  /**
   * 翻译。
   *
   * 输入优先取 `text` 参数（用户直接粘一段话），没有则回退到入参文件。
   * 之所以不强制走文件：翻译一句通知还要求先上传文件，是把简单事做复杂了。
   */
  async translate(ctx: ToolRunContext): Promise<ToolRunResult> {
    const target = toEnum(
      ctx.params.target,
      ['zh', 'en', 'ja', 'ko', 'fr', 'de'] as const,
      'en',
    );
    const inline = toStr(ctx.params.text).trim();

    let source = inline;
    let label = '粘贴文本';
    if (!source && ctx.inputFiles[0]) {
      const file = await this.files.readObject(ctx.userId, ctx.inputFiles[0]);
      source = file.buffer.toString('utf8').trim();
      label = file.name || 'input.txt';
      if (!/\.(txt|md|markdown|csv|json|log)$/i.test(label)) {
        throw new BizException(
          ErrorCode.FileFormatUnsupported,
          undefined,
          `「${label}」不是纯文本，请直接粘贴要翻译的内容`,
        );
      }
    }
    if (!source) {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '请粘贴要翻译的内容，或选择文本文件');
    }

    return this.run(ctx, 'translate_text', {
      system:
        `你是专业译者。把用户给的内容翻译成${LANGUAGE_LABEL[target]}，保持原文格式与段落；` +
        '专有名词首次出现时用括号附原文。只输出译文，不要解释、不要加译文说明。',
      prompt: source.slice(0, 12000),
      filename: `${stripExt(label)}-${target}.md`,
      maxTokens: 4000,
      // sync 工具：用户同步等结果，耗时直接等于他的等待时间，所以关思考。
      // 2026-09-20 实测（glm-4.5-air，接近生产输入上限）：开思考 4.9~7.1s，
      // 关思考 1.2~1.9s，产物长度基本一致（151 vs 165 字）。
      // 这类"输出结构固定"的任务拿不到推理收益，却要用户多等 3~5 秒。
      disableThinking: true,
    });
  }

  /** 论文摘要：按学术结构提炼，避免"鸡汤式总结" */
  async paperSummary(ctx: ToolRunContext): Promise<ToolRunResult> {
    const src = await this.files.readObject(ctx.userId, firstInput(ctx));
    const text = src.buffer.toString('utf8').trim();
    const name = src.name || 'paper.txt';

    if (!/\.(txt|md|markdown)$/i.test(name)) {
      throw new BizException(
        ErrorCode.FileFormatUnsupported,
        undefined,
        `「${name}」不是纯文本，暂只支持 .txt/.md（PDF 解析能力接入中）`,
      );
    }
    if (text.length < 200) {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '内容太短，不像论文正文');
    }

    return this.run(ctx, 'paper_summary', {
      system:
        '你是学术论文助手。按「研究问题 / 方法 / 主要发现 / 结论与局限」四段提炼，' +
        '忠实于原文、不加入原文没有的判断；无法判断的段落写「原文未明确说明」。',
      prompt: `请为下面这篇论文写结构化摘要（每段不超过 120 字）：\n\n【正文开始】\n${text.slice(0, 24000)}\n【正文结束】`,
      filename: `${stripExt(name)}-论文摘要.md`,
      // 标准表里已有 paper_summary 维度；产物是四段结构，缺段即不合格
      qualityDocType: 'paper_summary',
      maxTokens: 2500,
    });
  }

  /**
   * 解题。
   *
   * 输入可以是**题目图片**（走 OCR 识别，复用已上线的视觉模型）或**题目文字**。
   * 支持图片是必要的 —— 校园里最典型的用法就是拍一道题，
   * 要求用户先把题抄成文字等于这个功能没用。
   *
   * 提示词强调"先给思路再给步骤、不确定就说不确定"：
   * 直接甩一个答案对学习的价值很低，而解题场景下模型编造步骤的成本很高。
   */
  async solveQuestion(ctx: ToolRunContext): Promise<ToolRunResult> {
    let question = toStr(ctx.params.text).trim();
    let label = '题目';
    let source: 'text' | 'image' = 'text';

    if (!question && ctx.inputFiles[0]) {
      const file = await this.files.readObject(ctx.userId, ctx.inputFiles[0]);
      await ctx.onProgress(20, '正在识别题目');
      const ocr = await this.providers.ocr.recognize(file.buffer, { lang: 'zh' });
      question = ocr.fullText.trim();
      label = stripExt(file.name || '题目');
      source = 'image';
    }
    if (!question) {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '请上传题目图片，或粘贴题目文字');
    }

    const subject = toStr(ctx.params.subject).trim() || '不限';
    return this.run(ctx, 'solve_question', {
      system:
        '你是耐心的学科辅导老师。要求：① 先说明解题思路与用到的知识点；' +
        '② 再给分步解答（关键步骤写清依据）；③ 最后给一句易错点提醒。' +
        '题目信息不足或你无法确定时**必须直接说明**，不要编造条件。',
      prompt: `科目：${subject}\n题目（来源：${source === 'image' ? '图片识别' : '文字输入'}）：\n${question.slice(0, 4000)}`,
      filename: `${label}-解答.md`,
      // 提示词的三条硬要求：思路 / 步骤 / 易错点提醒；缺任一项即不合格（Q2）
      qualityDocType: 'solve_question',
      maxTokens: 3000,
    });
  }

  /**
   * 通用执行链：委托给 `llm-run-chain.ts`。
   *
   * 链路本体（生成 → 质检 → 自修复 → 落盘）抽出去有两个原因：
   * ① 本文件已贴 300 行红线；② 那段是"怎么把一次生成做好"，
   * 与本文件的职责（有哪些工具、各自提示词是什么）是两件事。
   */
  private run(
    ctx: ToolRunContext,
    toolName: string,
    spec: LlmToolSpec,
  ): Promise<ToolRunResult> {
    return runLlmChain(ctx, toolName, spec, {
      providers: this.providers,
      files: this.files,
      logger: this.logger,
    });
  }}

/** 目标语言的中文名。与 schema 的 enum 取值一一对应 */
const LANGUAGE_LABEL = {
  zh: '中文',
  en: '英文',
  ja: '日文',
  ko: '韩文',
  fr: '法文',
  de: '德文',
} as const;

// ---------- 参数取值工具 ----------

/** 必填字符串参数；缺失时给出人话（这是参数错误，不是系统错误） */
function requireStr(v: unknown, label: string): string {
  const s = toStr(v).trim();
  if (!s) throw new BizException(ErrorCode.ParamInvalid, undefined, `请填写「${label}」`);
  return s;
}

/** 去掉扩展名（用于给产物命名） */
function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

/** 取第一个入参文件 id；没有就报错（大多数工具都需要文件） */
function firstInput(ctx: ToolRunContext): string {
  const id = ctx.inputFiles[0];
  if (!id) throw new BizException(ErrorCode.ParamInvalid, undefined, '请先选择要处理的文件');
  return id;
}

function toEnum<T extends readonly string[]>(
  v: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v)
    ? (v as T[number])
    : fallback;
}

function toInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}
