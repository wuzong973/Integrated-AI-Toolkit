import { Inject, Injectable } from '@nestjs/common';
import {
  BizException,
  ErrorCode,
  PPT_CHART_GUIDE,
  analyzeDeck,
  type PptChartSpec,
  type PptSlideSpec,
  type Providers,
  sampling,
} from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import { PROVIDERS } from '../../infra/providers/providers.module';
import {
  slidesFromSections,
  type PptOutlineSectionHint,
} from '../../infra/providers/ppt/ppt-layouts';
import { FileService } from '../file/file.service';

import { DataToolRunner } from './data-tool-runner';
import { ImageToolRunner } from './image-tool-runner';
import { LlmToolRunner } from './llm-tool-runner';
import { MediaAiToolRunner } from './media-ai-tool-runner';
import { MediaToolRunner } from './media-tool-runner';
import type { JobResultMetrics } from './job-result';
import { PdfToolRunner } from './pdf-tool-runner';
import { loadPptDataSource, numericColumnNames, type PptDataSource } from './ppt-data-source';
import { RepoToolRunner } from './repo-tool-runner';

/** 执行上下文 */
export interface ToolRunContext {
  jobId: string;
  userId: string;
  params: Record<string, unknown>;
  /** 入参文件 id（来自 /files/confirm 产出的 FileAsset.id） */
  inputFiles: string[];
  /** 进度回调：由 JobService 落库 */
  onProgress: (progress: number, stage?: string) => Promise<void>;
}

/** 执行结果 */
export interface ToolRunResult {
  /** 产出文件 id */
  outputFiles: string[];
  /**
   * 产出指标（体积/分辨率/时长/页数…）。
   *
   * 不填也能成功，但结果页就只剩「共 N 个产物」——
   * 用户无法判断这次产出到底好不好。各执行器应尽量上报。
   */
  metrics?: JobResultMetrics;
  /** AI 类产出的质量分（0-100），非 AI 工具不填 */
  qualityScore?: number;
  /** 质量扣分项（人类可读） */
  qualityIssues?: string[];
  /**
   * 实际尝试次数（1 = 一次过；2 = 质检不达标后带反馈重写了一次）。
   *
   * 落库是为了回答"自修复到底有没有用、触发频率多高" ——
   * 没有这个数字，重写机制的效果就无法被评估（也就无法决定它值不值）。
   */
  attempts?: number;
}

type Handler = (ctx: ToolRunContext) => Promise<ToolRunResult>;

/**
 * 工具执行器（任务清单 M1-02 的执行侧）
 *
 * 职责：把 tool name 路由到具体 Provider，并把产出写回文件资产。
 *
 * 设计取舍 —— **只注册真正接入过的工具**：
 *   未注册的工具在执行阶段抛错并让作业落到 rejected，
 *   而不是"假装成功返回空结果"。宁可让用户看到"该工具尚未开放"，
 *   也不要产出一个看起来成功、实际没内容的作业（红线 9：Mock 必须显式可辨）。
 *
 * 各工具的 Provider 是否为 Mock 由 providers 层决定并已在 /health 暴露；
 * 走 Mock 的工具同样可以执行（返回演示数据），前端会显示"演示模式"角标。
 */
@Injectable()
export class ToolExecutorService {
  private readonly handlers: Record<string, Handler>;

  constructor(
    @Inject(PROVIDERS) private readonly providers: Providers,
    private readonly files: FileService,
    private readonly images: ImageToolRunner,
    private readonly llmTools: LlmToolRunner,
    private readonly mediaAi: MediaAiToolRunner,
    private readonly media: MediaToolRunner,
    private readonly pdf: PdfToolRunner,
    /**
     * ⚠️ 新加的执行器一律**追加在末尾**：构造器是位置参数，
     * 而单测与 `verify:tools` 都按位置传参 —— 插在中间会让它们静默错位
     * （本项目已踩过：多传的实参被运行时吞掉，只在调用到那个工具时才炸）。
     */
    private readonly data: DataToolRunner,
    /**
     * ⚠️ 仓库解读 runner（2026-10-08 追加在末尾）：构造器是位置参数，
     * 单测与 `verify:tools` 都按位置传参 —— 插在中间会让它们静默错位。
     */
    private readonly repoTools: RepoToolRunner,
    /**
     * 质量日志（可选，追加在末尾）。
     * 可选是为了不破坏单测与 verify-tools 的按位置传参；
     * 生产环境由 Nest 注入，缺失时跳过日志而不是报错。
     */
    private readonly qualityLogger?: AppLogger,
  ) {
    this.handlers = {
      // ---- 图片类（Sharp，本地真实实现）----
      compress_image: (c) => this.images.compress(c),
      convert_image: (c) => this.images.convert(c),
      remove_background: (c) => this.images.matting(c),
      enhance_image: (c) => this.images.enhance(c),
      // 二维码生成：与上面四个相反 —— **没有输入文件**，凭文本造图。
      // 走 node-qrcode 纯计算（本地、无需凭证），因此不经过 Provider。
      generate_qrcode: (c) => this.images.qrcode(c),

      // ---- 办公类 ----
      // generate_ppt：大纲走真 LLM（M1-07），渲染走 PptxGenJS
      generate_ppt: (c) => this.runGeneratePpt(c),

      // ---- 文本类（纯 LLM，M1-07 接入）----
      // 提示词与执行链在 LlmToolRunner（同类工具只差提示词，集中在那里维护）
      generate_outline: (c) => this.llmTools.outline(c),
      summarize_text: (c) => this.llmTools.summarize(c),
      generate_image_prompt: (c) => this.llmTools.imagePrompt(c),
      generate_resume: (c) => this.llmTools.resume(c),
      // 2026-09-19 接入：五类文档（计划书/策划/简历/报告/总结）共用一条 LLM 执行链，
      // 骨架表在 document-specs.ts
      generate_document: (c) => this.llmTools.document(c),
      generate_mindmap: (c) => this.llmTools.mindmap(c),
      translate_text: (c) => this.llmTools.translate(c),
      paper_summary: (c) => this.llmTools.paperSummary(c),
      solve_question: (c) => this.llmTools.solveQuestion(c),

      // ---- 数据分析 ----
      // 与文本类的区别：**数字先由代码算出来**（table-stats.ts），LLM 只负责解读，
      // 报告里两节分开标注来源 —— 避免模型顺口给出算错的均值（详见 data-tool-runner.ts）
      analyze_data: (c) => this.data.analyze(c),

      // ---- 音视频类（services/media 侧车，M4-01 / M4-03）----
      // 这五个在 2026-09-19 侧车落地后才注册：此前标 active 就是假功能（红线 9）
      compress_video: (c) => this.media.compressVideo(c),
      convert_video: (c) => this.media.convertVideo(c),
      cut_video: (c) => this.media.cutVideo(c),
      add_subtitle: (c) => this.media.addSubtitle(c),
      convert_audio: (c) => this.media.convertAudio(c),
      // 2026-09-19 起接入：侧车新增 /media/audio-cut（同容器流复制）与 /media/audio-denoise
      cut_audio: (c) => this.media.cutAudio(c),
      denoise_audio: (c) => this.media.denoiseAudio(c),
      // 2026-09-19 起接入：`services/ai` 的 /ai/separation（Demucs htdemucs）落地后才注册
      separate_vocals: (c) => this.media.separateVocals(c),

      // ---- PDF 类（services/pdf 侧车，PyMuPDF 以子进程调用）----
      // 2026-09-19 落地：引擎此前进不来（AGPL 不能进仓库），改为
      // "独立安装 + 子进程调 CLI" 之后这条链路才真正可用
      // 图片合成 PDF：走 Node 侧 pdf-lib（PyMuPDF CLI 没有这条能力，详见 runner 注释）
      images_to_pdf: (c) => this.pdf.imagesToPdf(c, 'images_to_pdf'),
      merge_pdf: (c) => this.pdf.merge(c, 'merge_pdf'),
      split_pdf: (c) => this.pdf.split(c, 'split_pdf'),
      compress_pdf: (c) => this.pdf.compress(c, 'compress_pdf'),

      // ---- 文档解析（同一个 PDF 侧车提供文本抽取）----
      // ⚠️ 目前只支持 PDF：Word/PPT 解析需要 LibreOffice（未部署），由侧车如实报错
      parse_document: (c) => this.pdf.parse(c, 'parse_document'),

      // ---- 媒体识别类（视觉 / 语音模型）----
      // 共同点：输入是媒体、输出是文字，走 providers.ocr 与 providers.audio.speechToText
      ocr_image: (c) => this.mediaAi.ocr(c),
      speech_to_text: (c) => this.mediaAi.speechToText(c),
      // 与上面互为逆操作（文本 → 音频）；唯一不需要输入文件的音频工具
      text_to_speech: (c) => this.mediaAi.textToSpeech(c),

      // ---- 仓库解读（deepwiki-open 自托管；未部署 DEEPWIKI_BASE_URL 时走 mock-repo，seed 保持 planned）----
      explain_repository: (c) => this.repoTools.explain(c),
    };
  }

  /** 该工具是否已接入执行器 */
  supports(toolName: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.handlers, toolName);
  }

  /** 已接入的工具清单（供文档与后台展示） */
  get supportedTools(): string[] {
    return Object.keys(this.handlers);
  }

  async run(toolName: string, ctx: ToolRunContext): Promise<ToolRunResult> {
    const handler = this.handlers[toolName];
    if (!handler) {
      throw new BizException(ErrorCode.NotFound, undefined, `工具「${toolName}」尚未接入执行器（M1-07~M1-12）`);
    }
    return handler(ctx);
  }

  // ---------- 图片类 ----------

  // ---------- 办公类 ----------

  /**
   * 生成 PPT。
   *
   * **大纲由 LLM 生成（M1-07）**，渲染仍走 PptxGenJS 出真实 .pptx。
   * 之前版本是"参数 → 模板骨架"（标题页 + "第 N 部分/要点一"），刻意不接 LLM ——
   * 为的是先把"参数 → 可打开的 .pptx → 落库"这条链路验证通，
   * 避免把 LLM 的不确定性混进来导致问题难定位。现在链路已稳，把 AI 接上。
   *
   * 失败处理：LLM 挂了**不回退到模板大纲**，而是让作业失败并给出原因。
   * 静默回退会让用户分不清"这是 AI 写的还是模板填的"，
   * 而模板内容（"要点一/要点二"）一旦被当成 AI 成果，比失败更糟。
   */
  private async runGeneratePpt(ctx: ToolRunContext): Promise<ToolRunResult> {
    const topic = toStr(ctx.params.topic) || '未命名演示文稿';
    const pages = toInt(ctx.params.pages, 16, 5, 40);
    const style = toEnum(
      ctx.params.style,
      ['business', 'tech', 'fresh', 'academic', 'chinese'] as const,
      'business',
    );
    const purpose = toStr(ctx.params.purpose);
    const extra = toStr(ctx.params.extra);

    const dataSource = await this.loadPptData(ctx);

    await ctx.onProgress(15, 'AI 正在规划结构');

    const sectionCount = Math.max(3, Math.min(pages - 2, 8));
    const outline = await this.providers.llm.structured<{
      subtitle?: string;
      sections: {
        title: string;
        points: string[];
        /** 强调版式：模型可选 stat/quote/chart（其余版式由映射规则推导，见 ppt-layouts.ts） */
        layout?: 'stat' | 'quote' | 'chart';
        stat?: { value?: string; label?: string };
        quote?: { text?: string; by?: string };
        chart?: PptOutlineSectionHint['chart'];
        notes?: string;
      }[];
    }>(
      [
        {
          role: 'system',
          content:
            '你是校园场景的 PPT 策划助手。只输出 JSON，不要解释、不要 markdown 代码块。' +
            '所有文案必须针对给定主题原创，禁止出现"要点一/要点二"这类占位词。' +
            '每节要点要写成完整、具体、可独立阅读的句子，避免空泛口号；' +
            '全文版式必须有变化，连续多节使用同一种 layout 会被质检判为不合格。',
        },
        {
          role: 'user',
          content:
            `为「${topic}」写一份 PPT 大纲，共 ${sectionCount} 节。` +
            (purpose ? `用途：${purposeLabel(purpose)}。` : '') +
            (extra ? `补充要求：${extra}。` : '') +
            `输出 JSON：{"subtitle":"一句话副标题","sections":[{"title":"节标题","points":["要点","要点"],` +
            `"layout":"stat|quote 可省","stat":{"value":"数字带单位","label":"一句话说明"},` +
            `"quote":{"text":"观点金句","by":"可选署名"},` +
            `"chart":{"type":"图表类型","categories":["类目"],"series":[{"name":"系列名","values":[1,2]}]},` +
            `"notes":"讲稿提示"}]}，` +
            `每节 3~4 条要点，每条 15~40 字，写成可独立阅读的完整句子。` +
            `版式编排：每 2~3 节安排一节强调页，在 stat / quote / chart 中轮换选择，` +
            `整份 deck 至少覆盖 2 种图表类型，不要所有数据页都用柱状图。` +
            chartGuideText() +
            realDataHint(dataSource) +
            `stat 的数字必须是**估算**（会被标注"AI 估算，请核实"）；` +
            `chart 的数据必须是**示例数据**（会被标注"示例数据"），categories 与每个 series 的 values 长度必须一致。`,
        },
      ],
      {
        type: 'object',
        properties: {
          subtitle: { type: 'string' },
          sections: {
            type: 'array',
            minItems: sectionCount,
            maxItems: sectionCount,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                points: { type: 'array', items: { type: 'string' } },
                layout: { type: 'string', enum: ['stat', 'quote', 'chart'] },
                stat: {
                  type: 'object',
                  properties: { value: { type: 'string' }, label: { type: 'string' } },
                },
                quote: {
                  type: 'object',
                  properties: { text: { type: 'string' }, by: { type: 'string' } },
                },
                notes: { type: 'string' },
              },
              required: ['title', 'points'],
            },
          },
        },
        required: ['subtitle', 'sections'],
      },
      { tier: 'generate', ...sampling('create', { maxTokens: 4200 }) },
    );

    // 模型偶尔会少给一节：补齐而不是报错（数量对了才能翻页）
    const sections = (outline.sections ?? []).slice(0, sectionCount);
    while (sections.length < sectionCount) {
      sections.push({ title: `第 ${sections.length + 1} 部分`, points: [] });
    }

    await ctx.onProgress(55, '正在渲染幻灯片');
    // 版式映射统一走 slidesFromSections：章节过渡页、双栏分片、相邻去重、
    // stat/quote/chart 强调页与"AI 估算"脚注判定都在那里，渲染器只负责画。
    const slides = slidesFromSections(sections);
    // 有真实数据时，在正文最前面插一页真实图表页（否则用户上传的表格白传了）
    const withData = dataSource
      ? [dataSlide(dataSource.chart, dataSource.caption), ...slides]
      : slides;
    const quality = analyzeDeck(withData);
    // 三个维度的扣分项汇总：落库之后"哪里没达标"在数据里可查，
    // 而不是只留一条会被日志轮转掉的 warn。
    const qualityIssues = [
      ...quality.content.issues,
      ...quality.visual.issues,
      ...quality.charts.issues,
    ];
    if (!quality.passed) {
      this.qualityLogger?.warn(
        `generate_ppt 质量未达标（${quality.overall} 分）：${qualityIssues.join('；')}`,
        'ToolExecutor',
      );
    }

    const { buffer, pageCount } = await this.providers.ppt.render({
      title: topic,
      subtitle: outline.subtitle?.trim() || (purpose ? purposeLabel(purpose) : undefined),
      style,
      slides: withData,
    });

    await ctx.onProgress(90, `已生成 ${pageCount} 页，正在保存`);
    const out = await this.files.saveGenerated(ctx.userId, {
      name: `${topic}.pptx`,
      buffer,
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      source: 'generate_ppt',
    });
    return {
      outputFiles: [out.id],
      metrics: {
        kind: 'content',
        pages: pageCount,
        layoutKinds: quality.visual.layoutKinds.length,
        chartKinds: quality.charts.chartKindCount,
      },
      qualityScore: quality.overall,
      qualityIssues,
    };
  }

  /**
   * 加载真实数据源并记日志。
   *
   * 抽成方法有两个理由：① runGeneratePpt 已接近复杂度上限，
   * ② 「有没有数据源」与「怎么生成 PPT」是两件事，混在一起会让主流程难读。
   */
  private async loadPptData(ctx: ToolRunContext): Promise<PptDataSource | undefined> {
    // 没有上传文件时直接 undefined，走纯 AI 生成（行为与改造前一致）
    const source = await loadPptDataSource(this.files, ctx.userId, ctx.inputFiles);
    if (source) {
      this.qualityLogger?.log(
        `generate_ppt 采用真实数据源：${source.fileName}（${source.profile.rowCount} 行）`,
        'ToolExecutor',
      );
    }
    return source;
  }

  // ---------- 内部 ----------
}

// ---------- 参数取值工具（params 来自客户端，必须做类型收敛） ----------
// requireStr / stripExt 已随文本类工具移到 llm-tool-runner.ts

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function toInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function toEnum<T extends readonly string[]>(
  v: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  const s = toStr(v);
  return (allowed as readonly string[]).includes(s) ? (s as T[number]) : fallback;
}

/** `photo.png` + `_compressed` + `jpg` → `photo_compressed.jpg` */
function purposeLabel(purpose: string): string {
  const map: Record<string, string> = {
    contest: '比赛路演',
    course: '课程汇报',
    defense: '答辩',
    other: '',
  };
  return map[purpose] ?? '';
}

/**
 * 把"图表选用逻辑"拼成给模型看的清单。
 *
 * 与 `PPT_CHART_GUIDE` 同源：文档、提示词、守卫三处不再各写一份，
 * 新增图表类型时只改 core 一处，这里自动生效。
 */
function chartGuideText(): string {
  const lines = PPT_CHART_GUIDE.map((g) => `${g.type}（${g.label}）：${g.when}`).join('；');
  return `图表选用逻辑：${lines}。饼/环形图类目不超过 5 个，散点/气泡图用 categories 承载 x 轴；`;
}

/**
 * 真实数据图表页。
 *
 * 为什么不走 `slidesFromSections`：那是"模型大纲 → 版式"的映射，
 * 而这一页的数据**不来自模型**（来自用户上传表格的统计），
 * 硬塞进大纲反而会让模型以为自己该生成这些数字。
 * 这里直接产出成品 slide，标注走 `caption`，与示例数据明确区分。
 */
function dataSlide(chart: PptChartSpec, caption: string): PptSlideSpec {
  return {
    title: '数据概览',
    layout: 'chart',
    chart: { ...chart, caption },
    bullets: ['以下图表来自你上传表格的真实统计，可直接用于汇报'],
    notes: caption,
  };
}

/**
 * 有真实数据时，提示模型「数字用上传的，不要自己编」。
 *
 * 重点是把**真实存在的列名**列给模型：只说"有真实数据"不够，
 * 模型仍可能顺手编一个"满意度"列；给出列名之后，它编造的数字就有据可查地偏离了输入。
 */
function realDataHint(source?: PptDataSource): string {
  if (!source) return '';
  const cols = numericColumnNames(source.profile);
  return (
    '本次用户上传了表格，已为其生成一页**真实数据图表**（共 ' +
    source.profile.rowCount +
    ' 行）。' +
    (cols.length ? '表格中真实可用的数值列：' + cols.join('、') + '。' : '') +
    '正文提到数字时必须与图表口径一致，**不要再编造其他统计数字**；' +
    '需要表格里没有的数字时，写成「需进一步核实」。'
  );
}
