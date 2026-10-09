/**
 * 图片类能力的目录数据（抠图 / 压缩 / 转格式 / 增强 / OCR / 二维码）。
 *
 * 从 `ai-capability.catalog.ts` 拆出来的原因：那个文件是**助手能调什么**的唯一真相源，
 * 每加一个能力就是十几行"什么时候该调 / 不该调"的描述 —— 写得越清楚它越长。
 *
 * ⚠️ 2026-09-20 的教训：ESLint `max-lines` 统计的是**有效代码行**（不含空行与注释），
 * 所以"文件 336 行"并不等于"336/300"。加二维码时主表才第一次真的越线 ——
 * 在此之前靠空行与注释一直没触发。**别用总行数判断有没有超红线。**
 *
 * ⚠️ 这些条目与主表条目**同一条对账链路**：
 * `npm run check:ai-capabilities` 会把本文件与主表合并后再做五方对账，
 * 漏登记 / 指向跑不通的工具照样会被拦下。
 */
import type { AiCapability } from './ai-capability.types';

export const IMAGE_CAPABILITIES: readonly AiCapability[] = [
  // ==================== 需要文件的图片能力（缺文件 → 引导上传；已传 → 直接执行） ====================
  {
    toolName: 'remove_background',
    source: 'tool',
    intent: 'file_process',
    title: 'AI 抠图',
    scene: '用户要**去掉图片背景 / 抠出主体 / 做透明底 PNG** 时调用。只能通过 guided 方式触发。',
    invocation: 'guided',
    needsFile: 'image',
    resultKind: 'file',
    resultHint: '抠图完成，输出透明背景 PNG',
    guideHint: '抠图需要先上传图片，点下面进入上传页',
  },
  {
    toolName: 'compress_image',
    source: 'tool',
    intent: 'file_process',
    title: '图片压缩',
    scene: '用户要**把图片体积压小**（如"压到 1MB 以内""太占空间了"）时调用。',
    invocation: 'guided',
    needsFile: 'image',
    resultKind: 'file',
    resultHint: '图片已压缩',
    guideHint: '压缩需要先上传图片，点下面进入上传页',
  },
  {
    toolName: 'convert_image',
    source: 'tool',
    intent: 'file_process',
    title: '图片格式转换',
    scene: '用户要**换图片格式**（如"png 转 jpg""转成 webp"）时调用。',
    invocation: 'guided',
    needsFile: 'image',
    resultKind: 'file',
    resultHint: '格式转换完成',
    guideHint: '格式转换需要先上传图片，点下面进入上传页',
  },
  {
    toolName: 'enhance_image',
    source: 'tool',
    intent: 'file_process',
    title: '图片增强',
    scene:
      '用户嫌**图片糊/暗/不够清晰**，要提升画质时调用。' +
      '注意这是**锐化与提亮**，不放大分辨率；用户明确要放大时如实说明暂不支持。',
    invocation: 'guided',
    needsFile: 'image',
    resultKind: 'file',
    resultHint: '图片增强完成',
    guideHint: '图片增强需要先上传图片，点下面进入上传页',
  },
  {
    toolName: 'ocr_image',
    source: 'tool',
    intent: 'file_process',
    title: 'OCR 文字识别',
    scene:
      '用户要**从图片里取文字**（截图转文字、拍笔记转文字、识别证件）时调用。' +
      '⚠️ 如果用户已经**直接把文字贴在了对话里**，那就不是 OCR 任务，不要调用。',
    invocation: 'guided',
    needsFile: 'image',
    resultKind: 'file',
    resultHint: '文字识别完成',
    guideHint: '识别文字需要先上传图片，点下面进入上传页',
  },

  // ==================== 不需要文件的图片能力 ====================
  {
    toolName: 'generate_qrcode',
    source: 'tool',
    intent: 'file_process',
    title: '二维码生成',
    scene:
      '用户要**把一段文字或链接做成二维码**（活动报名、加群、分享链接、签到码）时调用。' +
      '⚠️ 这类能力里**唯一不需要上传文件**的：内容就在用户说的话里，' +
      '直接把原文填进 `text`，不要反问"请上传文件"。',
    notFor: ['识别 / 扫描二维码（那是微信扫码能力，本平台没有）'],
    invocation: 'auto',
    needsFile: false,
    resultKind: 'file',
    resultHint: '二维码已生成',
  },
];
