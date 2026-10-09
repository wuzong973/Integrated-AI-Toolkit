/**
 * 文档生成与数据分析类能力的目录数据（2026-09-19 新增）。
 *
 * 拆出来的原因与 `ai-capability.catalog.files.ts` 相同：
 * 主表 `ai-capability.catalog.ts` 已到 292 行（单文件 300 行红线只剩 8 行），
 * 而每加一条能力就是十几行"什么时候该调 / 不该调"的描述 —— 再往里塞必然超限。
 *
 * ⚠️ 这些条目与主表**走同一条对账链路**：`npm run check:ai-capabilities`
 * 会把几张表合并后再做五方对账，漏登记或指向跑不通的工具照样会被拦下。
 */
import type { AiCapability } from './ai-capability.types';

export const DOC_DATA_CAPABILITIES: readonly AiCapability[] = [
  {
    toolName: 'generate_document',
    source: 'tool',
    intent: 'ai_generate',
    title: 'AI 文档生成',
    scene:
      '用户要**一份完整成稿**（商业计划书 / 活动策划 / 简历 / 报告 / 总结）时调用，' +
      '如"帮我写一份社团招新策划"。文档类型填 `docType`，主题填 `topic`，另有要求填 `extra`。',
    notFor: [
      '用户只要**大纲或结构**（那用 generate_outline，更快也更省）',
      '用户要的是 PPT（那用 generate_ppt）',
      '用户要的是**简历**且给了目标岗位（那用 generate_resume，它会按岗位定制）',
    ],
    invocation: 'auto',
    needsFile: false,
    resultKind: 'file',
    resultHint: '文档已生成，可预览或下载 Markdown',
  },
  {
    toolName: 'analyze_data',
    source: 'tool',
    intent: 'ai_generate',
    title: '数据分析',
    scene:
      '用户要**分析一份表格或问卷数据**（如"看看这份问卷哪一题满意度最低""这批数据有什么规律"）时调用。' +
      '表格内容可以直接粘进对话（`text`），也可以在对话里传 CSV 文件；' +
      '用户说了关注点就填 `focus`。产出的报告里**数字由程序算出、结论由模型写**，两节分开标注来源。',
    notFor: [
      '用户要的是**总结一篇文字**（那用 summarize_text）',
      '用户上传的是 .xlsx —— 目前只吃 CSV/TSV，要如实告诉他"在 Excel 里另存为 CSV 再传"',
    ],
    invocation: 'auto',
    needsFile: false,
    resultKind: 'file',
    resultHint: '分析报告已生成（含程序统计与 AI 结论）',
  },
];
