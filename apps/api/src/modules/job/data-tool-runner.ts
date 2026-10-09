import { Inject, Injectable } from '@nestjs/common';
import { BizException, ErrorCode, countContentChars, sampling, type Providers } from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import { PROVIDERS } from '../../infra/providers/providers.module';
import { FileService } from '../file/file.service';

import { SAMPLE_ROWS, assembleReport, renderSample } from './data-report';
import {
  decodeTabular,
  parseTable,
  profileTable,
  type ColumnProfile,
  type ParsedTable,
  type TableProfile,
} from './table-stats';
import type { ToolRunContext, ToolRunResult } from './tool-executor.service';

/**
 * 数据分析工具执行器（M4 学习类）
 *
 * ## 职责边界（这个工具的"诚实"全在这条线上）
 *
 * 数字由 `table-stats.ts` 算，解读由模型写，两者在报告里分节展示。
 * 本类只做编排：取输入 → 解析 → 统计 → 请模型解读 → 存报告。
 *
 * ## 为什么模型失败不让整个作业失败
 *
 * "程序统计"本身就是可用产物（列概览、均值、缺失率、高频值），
 * 因为"解读"这一步挂了就把"数据"一起丢掉，是把可用结果换成了一个错误提示。
 * 所以这里降级为"报告少一节"，并在日志里留下原因 —— 降级是**可见**的，
 * 不是悄悄换了个结果（红线 9：不许让用户分不清拿到的是什么）。
 *
 * ## 为什么只吃 CSV / TSV
 *
 * `.xlsx` 是压缩包格式，解析它要么引依赖（需先过许可登记），
 * 要么在侧车里再挂一套引擎 —— 而"在 Excel 里另存为 CSV"只多一步操作。
 * 所以对 xlsx **明确报错并给出这一步**，而不是收下文件再报"格式不支持"。
 */
@Injectable()
export class DataToolRunner {
  constructor(
    @Inject(PROVIDERS) private readonly providers: Providers,
    private readonly files: FileService,
    private readonly logger: AppLogger,
  ) {}

  /** 数据分析主流程 */
  async analyze(ctx: ToolRunContext): Promise<ToolRunResult> {
    const { text, source } = await this.loadInput(ctx);
    await ctx.onProgress(20, '正在解析表格');

    const table = parseTable(text);
    assertUsableTable(table);
    const profile = profileTable(table);

    await ctx.onProgress(45, '正在生成分析结论');
    const conclusion = await this.conclude(ctx, table, profile);

    await ctx.onProgress(80, '正在保存报告');
    const markdown = assembleReport({
      source,
      profile,
      aiConclusion: conclusion,
      sample: renderSample(table, SAMPLE_ROWS),
    });

    const out = await this.files.saveGenerated(ctx.userId, {
      name: `${stripExt(source)}-数据分析.md`,
      buffer: Buffer.from(markdown, 'utf8'),
      contentType: 'text/markdown; charset=utf-8',
      source: 'analyze_data',
    });
    this.logger.log(
      `数据分析完成：${source}（${table.rows.length} 行 × ${table.header.length} 列）`,
      'DataTool',
    );
    return {
      outputFiles: [out.id],
      metrics: {
        kind: 'content',
        // 字符数用"去掉 Markdown 语法后的正文"口径，与其它文本工具同源，
        // 否则同一份产物在不同页面会显示两个字数
        chars: countContentChars(markdown),
      },
    };
  }

  /** 取输入：优先粘贴的文本，其次上传的文件（与「AI 翻译」同一套约定，避免两个工具两种习惯） */
  private async loadInput(ctx: ToolRunContext): Promise<{ text: string; source: string }> {
    const inline = toStr(ctx.params.text).trim();
    if (inline) return { text: inline, source: '粘贴的表格' };

    const id = ctx.inputFiles[0];
    if (!id) {
      throw new BizException(
        ErrorCode.ParamInvalid,
        undefined,
        '请上传 CSV / TSV 表格，或直接粘贴表格内容（从 Excel 直接复制也可以）',
      );
    }

    const file = await this.files.readObject(ctx.userId, id);
    const name = file.name || 'table.csv';
    if (!/\.(csv|tsv|txt|md)$/i.test(name)) {
      throw new BizException(
        ErrorCode.FileFormatUnsupported,
        undefined,
        `「${name}」不是表格文本。请在 Excel 里「另存为 → CSV UTF-8」后再上传（.xlsx 暂不支持）`,
      );
    }
    // 走 decodeTabular 而不是 toString('utf8')：Excel 导出的中文 CSV 默认是 GBK，
    // 直接按 UTF-8 解不会报错，只会把整张表变成乱码。
    return { text: decodeTabular(file.buffer), source: name };
  }

  /**
   * 请模型解读统计结果。
   *
   * 提示词里最要紧的是"数字已算好，直接引用，不要重算" ——
   * 少了这句，模型会顺手验算一遍并给出与程序统计**不一致**的均值，
   * 报告里于是出现两个互相矛盾的数字，而这正是本工具最想避免的事。
   */
  private async conclude(
    ctx: ToolRunContext,
    table: ParsedTable,
    profile: TableProfile,
  ): Promise<string> {
    const focus = toStr(ctx.params.focus).trim();
    try {
      const res = await this.providers.llm.chat(
        [
          {
            role: 'system',
            content:
              '你是数据分析助手。只依据给定材料下结论；数字必须原样引用，不要自行计算、' +
              '不要补充材料之外的数据。输出中文 Markdown，不要复述表格。',
          },
          { role: 'user', content: buildPrompt(table, profile, focus) },
        ],
        { tier: 'generate', ...sampling('grounded', { maxTokens: 2000 }) },
      );
      return res.content;
    } catch (e) {
      // 统计部分已经是有价值的产物，不能因为"解读"失败就整体失败
      this.logger.warn(
        `数据分析的结论生成失败，仅输出程序统计：${(e as Error).message}`,
        'DataTool',
      );
      return '';
    }
  }
}

/** 表格可用性检查：把"像表格但没数据"的情况拦在调模型之前 */
function assertUsableTable(table: ParsedTable): void {
  if (table.header.length < 2) {
    throw new BizException(
      ErrorCode.ParamInvalid,
      undefined,
      '没识别出表格结构（至少需要两列）。请确认内容是从 Excel 复制的表格或标准 CSV',
    );
  }
  if (table.rows.length === 0) {
    throw new BizException(ErrorCode.ParamInvalid, undefined, '表格只有表头，没有数据行');
  }
}

/** 拼给模型的材料：统计在前、样本在后，关注点放最后（模型对末尾指令最敏感） */
function buildPrompt(table: ParsedTable, profile: TableProfile, focus: string): string {
  const lines = [
    `表格共 ${profile.rowCount} 行 × ${profile.columnCount} 列。`,
    '',
    '【程序统计结果（数字已算好，请直接引用，不要重算）】',
    ...profile.columns.map(describeColumn),
    '',
    '【数据样本】',
    renderSample(table, SAMPLE_ROWS),
    focus ? `【用户关注点】${focus}` : '',
    '请写 300-600 字的分析结论：① 数据整体特征；② 值得注意的规律或异常；' +
      (focus ? '③ 针对用户关注点的回答。' : '③ 可行动的建议。'),
    '只引用上面出现过的数字；若数据不足以支持某个判断，直接写「数据不足以支持」，不要推测。',
  ];
  return lines.filter((l) => l !== '').join('\n');
}

/** 单列的文本描述（给模型看的版本，比 Markdown 表格更省 token 也更好读） */
function describeColumn(c: ColumnProfile): string {
  const base = `- ${c.name}：类型 ${c.type}，非空 ${c.nonEmpty}，缺失 ${c.missing}，唯一值 ${c.unique}`;
  if (c.stats) {
    const s = c.stats;
    return `${base}，最小 ${s.min}，最大 ${s.max}，均值 ${s.mean}，中位数 ${s.median}，合计 ${s.sum}`;
  }
  if (c.top?.length) {
    return `${base}，高频取值 ${c.top.map((t) => `${t.value}(${t.count}次)`).join('、')}`;
  }
  return base;
}

/** 去掉扩展名（用于给产物命名） */
function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}
