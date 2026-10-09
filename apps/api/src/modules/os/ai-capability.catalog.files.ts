/**
 * 文件与音视频处理类能力的目录数据（PDF 四项 + 音频裁剪/降噪）。
 *
 * 从 `ai-capability.catalog.ts` 拆出来的原因：那个文件是**助手能调什么**的唯一真相源，
 * 每加一个能力就是十几行"什么时候该调 / 不该调"的描述 —— 写得越清楚它越长，
 * 所以按能力域拆文件、主表负责合并，否则写清楚与红线（300 行）直接冲突。
 *
 * ⚠️ 这些条目与主表条目**同一条对账链路**：
 * `npm run check:ai-capabilities` 会把本文件与主表合并后再做五方对账，
 * 漏登记 / 指向跑不通的工具照样会被拦下。
 */
import type { AiCapability } from './ai-capability.types';

export const FILE_MEDIA_CAPABILITIES: readonly AiCapability[] = [
  // ==================== PDF 类（services/pdf，PyMuPDF 子进程） ====================
  {
    toolName: 'images_to_pdf',
    source: 'tool',
    intent: 'file_process',
    title: '图片转 PDF',
    scene:
      '用户要**把多张图片合成一份 PDF**（作业 / 实验报告拍照后要交一份、' +
      '把一串截图整理成文档）时调用。产物页序 = 用户上传顺序。',
    notFor: ['把 PDF 转成图片（暂不支持）', '只要一张图转 PDF 时也要走它 —— 支持单张'],
    invocation: 'guided',
    needsFile: 'image',
    resultKind: 'file',
    resultHint: '已合成 PDF',
    guideHint: '合成 PDF 需要先上传图片，点下面进入上传页',
  },
  {
    toolName: 'merge_pdf',
    source: 'tool',
    intent: 'file_process',
    title: 'PDF 合并',
    scene:
      '用户要**把多个 PDF 合成一个**（如"这几份合成一个""交材料要一个文件"）时调用。' +
      '至少需要 2 个文件，合并顺序就是用户给出文件的顺序。',
    notFor: ['用户只是想把多个文件打包发给别人（那不需要合并，直接压缩即可）'],
    invocation: 'guided',
    needsFile: 'text',
    resultKind: 'file',
    resultHint: 'PDF 已合并',
    guideHint: '合并 PDF 需要先上传至少 2 个文件，点下面进入上传页',
  },
  {
    toolName: 'split_pdf',
    source: 'tool',
    intent: 'file_process',
    title: 'PDF 拆分',
    scene:
      '用户要**把一份 PDF 拆成几份**（如"把前 3 页拆出来""每一页单独存"）时调用。' +
      '默认每页一份；用户说了页码就按 `ranges`（如 1-3,5,8-N）分组。',
    invocation: 'guided',
    needsFile: 'text',
    resultKind: 'file',
    resultHint: 'PDF 已拆分（打包为 ZIP）',
    guideHint: '拆分 PDF 需要先上传文件，点下面进入上传页',
  },
  {
    toolName: 'compress_pdf',
    source: 'tool',
    intent: 'file_process',
    title: 'PDF 压缩',
    scene: '用户嫌 **PDF 太大**（如"超过 10MB 传不上去"）时调用。这是无损优化，不降画质。',
    notFor: ['用户要压的是图片或视频（那是另外两个工具）'],
    invocation: 'guided',
    needsFile: 'text',
    resultKind: 'file',
    resultHint: 'PDF 已优化',
    guideHint: '压缩 PDF 需要先上传文件，点下面进入上传页',
  },
  {
    toolName: 'parse_document',
    source: 'tool',
    intent: 'ai_generate',
    title: '文档解析',
    scene:
      '用户上传了 **PDF** 并要**取出里面的文字**（做摘要前先取文、引用原文、整理笔记）时调用。' +
      '⚠️ 目前只支持 PDF：Word/PPT 需要重新排版（LibreOffice），尚未部署，要如实说明。',
    notFor: ['用户要总结一篇 PDF —— 应该先解析再总结，别把它当成总结工具'],
    invocation: 'guided',
    needsFile: 'text',
    resultKind: 'file',
    resultHint: '已按页提取文本',
    guideHint: '解析需要先上传 PDF 文件，点下面进入上传页',
  },

  // ==================== 音频裁剪 / 降噪（services/media，ffmpeg） ====================
  {
    toolName: 'cut_audio',
    source: 'tool',
    intent: 'media_ai',
    title: '音频裁剪',
    scene:
      '用户要**截取音频的一段**（如"只要第 10 到 30 秒""去掉开头"）时调用。' +
      '用户给了时间就填 `startSec` / `endSec`；同容器输出走流复制，零音质损失。',
    invocation: 'guided',
    needsFile: 'audio',
    resultKind: 'file',
    resultHint: '音频已裁剪',
    guideHint: '裁剪音频需要先上传音频文件，点下面进入上传页',
  },
  {
    toolName: 'denoise_audio',
    source: 'tool',
    intent: 'media_ai',
    title: '音频降噪',
    scene:
      '用户嫌**录音有底噪/环境声**（如"录课的电流声""风声太大"）时调用，' +
      '强度偏好填 `strength`（默认均衡）。产出仍是**一条完整音轨**。',
    notFor: [
      '用户要的是**人声/伴奏分离**（要拆成两条轨）—— 用 separate_vocals，别拿降噪顶替',
      '用户要的是"去掉某一段"（那是裁剪，用 cut_audio）',
    ],
    invocation: 'guided',
    needsFile: 'audio',
    resultKind: 'file',
    resultHint: '音频已降噪',
    guideHint: '降噪需要先上传音频文件，点下面进入上传页',
  },

  // ==================== 人声/伴奏分离（services/ai，Demucs） ====================
  {
    toolName: 'separate_vocals',
    source: 'tool',
    intent: 'media_ai',
    title: '人声/伴奏分离',
    scene:
      '用户要**把一首歌拆成人声与伴奏**（如"提取伴奏唱 K""把歌声去掉"）时调用。' +
      '默认 2 轨（人声 + 伴奏）；用户要鼓/贝斯等单独轨道时填 `stems: "4"`。' +
      '⚠️ 它跑的是 Demucs 模型，**CPU 上要等几分钟**，调用前先跟用户说一句。',
    notFor: [
      '用户只是嫌**录音有底噪**（那用 denoise_audio，产出一条更干净的音轨）',
      '用户要的是**音频转文字**（那用 speech_to_text）',
    ],
    invocation: 'guided',
    needsFile: 'audio',
    resultKind: 'file',
    resultHint: '已分离出人声与伴奏两条轨道',
    guideHint: '人声/伴奏分离需要先上传音频文件，点下面进入上传页',
  },
];
