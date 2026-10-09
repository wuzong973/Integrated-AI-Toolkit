import { DOC_DATA_CAPABILITIES } from './ai-capability.catalog.docs';
import { CAMPUS_CAPABILITIES } from './ai-capability.catalog.campus';
import { FILE_MEDIA_CAPABILITIES } from './ai-capability.catalog.files';
import { IMAGE_CAPABILITIES } from './ai-capability.catalog.image';
import type { AiCapability } from './ai-capability.types';

/**
 * AI 能力目录 —— 助手「能调什么、什么时候调、调完给什么」的**唯一真相源**
 *
 * ## 这份目录与别处的对应关系
 *
 * | 目录字段 | 对应到 |
 * |---|---|
 * | `toolName` | `seed.ts` 的 TOOLS[].name ／ `tool-executor.service.ts` 的 handlers 键 ／ `prisma/tool-input-schemas.ts` |
 * | `intent` | `packages/core` 的 `OS_INTENTS` |
 * | `scene` | 模型的工具描述（`buildCapabilitySpec`）+ 文档 |
 * | 其余 | 调度与结果卡渲染 |
 *
 * ## 维护纪律
 *
 * 1. **只登记真的能跑的能力**。`status: 'planned'` 的工具写进来没有意义 ——
 *    注册表会把它丢掉，等于白写；但更糟的是有人误以为"写进目录就上线了"。
 * 2. 新增能力必须同时：`seed.ts` 改 status → 执行器注册 → 补 inputSchema → 补本目录 → 补 `verify:tools` 用例。
 * 3. `npm run check:ai-capabilities` 会做五方对账（目录 / seed / 执行器 / 意图表 / 参数 schema），
 *    漏任何一处都会红。
 *
 * ## 为什么 `invocation` 要区分 auto / guided
 *
 * 全部标 `auto` 会让模型对着"帮我抠个图"直接发起 `remove_background`，
 * 而用户没传图 → 执行器报错 → 用户看到一条失败消息，比不回答更糟。
 * 全部标 `guided` 又会让"帮我做个 PPT"也变成指路，把本该自动完成的事推给用户。
 *
 * ## 待登记
 *
 * `explain_repository`（仓库解读，deepwiki-open 自托管）已走完
 * seed(planned) / 执行器 / inputSchema / verify:tools 四步，**暂不进本目录**：
 * 目录只收 active 工具，等 deepwiki-open 部署并配置 `DEEPWIKI_BASE_URL`、
 * seed 转 active 之时，随同把声明补进来（invocation: 'auto'，needsFile: false）。
 */
export const AI_CAPABILITY_CATALOG: readonly AiCapability[] = [
  // ==================== AI 生成类（输入是文字 → 可直接执行） ====================
  {
    toolName: 'generate_ppt',
    source: 'tool',
    intent: 'ai_generate',
    title: 'AI PPT 生成',
    scene:
      '用户想要一份**演示文稿/PPT/幻灯片**时调用。用户给的主题即 `topic`；' +
      '若用户说了用途（路演/课程汇报/答辩）填 `purpose`，说了页数填 `pages`，说了风格填 `style`。' +
      '这是本项目最常用的能力，用户说"帮我做个 PPT"就直接调用，不要反问。' +
      '若用户已上传表格（CSV/TSV），生成时会自动把表格统计画成一页**真实数据图表**，' +
      '并在页面上标注数据来源；此时不要再说数字是示例。',
    notFor: ['用户只是问"PPT 怎么做"这类方法问题（他并不需要你生成文件）'],
    invocation: 'auto',
    needsFile: false,
    resultKind: 'file',
    resultHint: '演示文稿已生成，可预览或下载 .pptx',
  },
  {
    toolName: 'generate_outline',
    source: 'tool',
    intent: 'ai_generate',
    title: 'AI 生成大纲',
    scene:
      '用户要一份**文字大纲**（不是 PPT、不是成稿）时调用，如"帮我列个社团招新方案的大纲"。' +
      '主题填 `topic`，说了要几层填 `depth`。',
    notFor: ['用户要的是完整成稿或 PPT（那应该用 generate_ppt）'],
    invocation: 'auto',
    needsFile: false,
    resultKind: 'file',
    resultHint: '大纲已生成，可预览或下载 Markdown',
  },
  {
    toolName: 'generate_mindmap',
    source: 'tool',
    intent: 'ai_generate',
    title: 'AI 思维导图',
    scene:
      '用户要**思维导图/知识结构图**时调用，如"给数据结构期末复习做个思维导图"。' +
      '主题填 `topic`，说了层级填 `depth`。',
    invocation: 'auto',
    needsFile: false,
    resultKind: 'file',
    resultHint: '思维导图已生成（Markdown 层级结构）',
  },
  {
    toolName: 'generate_resume',
    source: 'tool',
    intent: 'ai_generate',
    title: 'AI 简历',
    scene:
      '用户要**做简历/求职材料**时调用。目标岗位填 `position`；' +
      '用户自报了姓名与经历就填 `name` / `highlights`，没提就不要编。',
    invocation: 'auto',
    needsFile: false,
    resultKind: 'file',
    resultHint: '简历已生成，可预览或下载',
  },
  {
    toolName: 'generate_image_prompt',
    source: 'tool',
    intent: 'ai_generate',
    title: 'AI 生图提示词',
    scene:
      '用户想要**一段用于 AI 绘画（如文生图）的提示词/咒语**时调用，而不是要一张图本身。' +
      '画面主体填 `subject`，风格填 `style`。',
    notFor: ['用户要的是图片成品 —— 平台当前不能直接生成图片，不要调用它冒充'],
    invocation: 'auto',
    needsFile: false,
    resultKind: 'file',
    resultHint: '提示词已生成，可直接粘贴到绘图工具',
  },
  {
    toolName: 'translate_text',
    source: 'tool',
    intent: 'ai_generate',
    title: 'AI 翻译',
    scene:
      '用户要**翻译一段文字**时调用。把原文放进 `text`（用户在对话里给的那段就是要翻译的内容），' +
      '目标语言填 `target`（默认英文）。',
    notFor: ['用户只是问某个单词是什么意思（直接回答即可）'],
    invocation: 'auto',
    needsFile: false,
    resultKind: 'file',
    resultHint: '译文已生成',
  },
  {
    toolName: 'solve_question',
    source: 'tool',
    intent: 'ai_generate',
    title: 'AI 解题',
    scene:
      '用户**贴了一道题目要解答**时调用（数学/物理/计算机等）。题目文字放进 `text`；' +
      '用户说了科目就填 `subject`；用户传了题目照片且没给文字时，`text` 可以留空（会先识别图片）。',
    invocation: 'auto',
    needsFile: false,
    resultKind: 'file',
    resultHint: '解题过程已生成',
  },

  // ==================== 需要文件的能力（缺文件 → 引导上传；已传 → 直接执行） ====================
  // 图片类（抠图 / 压缩 / 转格式 / 增强 / OCR / 二维码生成）已拆到 ai-capability.catalog.image.ts
  {
    toolName: 'compress_video',
    source: 'tool',
    intent: 'file_process',
    title: '视频压缩',
    scene: '用户要**把视频体积压小 / 压缩到某个大小**（如"压到 50MB"）时调用。',
    invocation: 'guided',
    needsFile: 'video',
    resultKind: 'file',
    resultHint: '视频已压缩',
    guideHint: '压缩视频需要先上传视频文件，点下面进入上传页',
  },
  {
    toolName: 'convert_video',
    source: 'tool',
    intent: 'file_process',
    title: '视频格式转换',
    scene: '用户要**换视频格式**（如"mov 转 mp4"）时调用。',
    invocation: 'guided',
    needsFile: 'video',
    resultKind: 'file',
    resultHint: '视频格式转换完成',
    guideHint: '转换视频需要先上传视频文件，点下面进入上传页',
  },
  {
    toolName: 'cut_video',
    source: 'tool',
    intent: 'file_process',
    title: '视频裁剪',
    scene:
      '用户要**截取视频的一段 / 剪掉片头片尾**时调用。用户说了起止时间就填 `startSec` / `endSec`。',
    invocation: 'guided',
    needsFile: 'video',
    resultKind: 'file',
    resultHint: '视频裁剪完成',
    guideHint: '裁剪视频需要先上传视频文件，点下面进入上传页',
  },
  {
    toolName: 'add_subtitle',
    source: 'tool',
    intent: 'media_ai',
    title: '视频加字幕',
    scene:
      '用户要**给视频烧录字幕**时调用。字幕内容需要用户提供（SRT 文本），用户没给就先向他要。',
    invocation: 'guided',
    needsFile: 'video',
    resultKind: 'file',
    resultHint: '字幕已烧录到视频',
    guideHint: '加字幕需要先上传视频文件，点下面进入上传页',
  },
  {
    toolName: 'convert_audio',
    source: 'tool',
    intent: 'media_ai',
    title: '音频格式转换',
    scene: '用户要**换音频格式**（如"微信语音转 mp3"）时调用。',
    invocation: 'guided',
    needsFile: 'audio',
    resultKind: 'file',
    resultHint: '音频格式转换完成',
    guideHint: '转换音频需要先上传音频文件，点下面进入上传页',
  },
  {
    toolName: 'speech_to_text',
    source: 'tool',
    intent: 'media_ai',
    title: '语音转文字',
    scene: '用户要**把录音/音频转成文字**（会议纪要、采访整理）时调用。',
    invocation: 'guided',
    needsFile: 'audio',
    resultKind: 'file',
    resultHint: '语音已转成文字',
    guideHint: '语音转文字需要先上传音频文件，点下面进入上传页',
  },
  {
    toolName: 'text_to_speech',
    source: 'tool',
    intent: 'media_ai',
    title: '文字转语音',
    scene:
      '用户要**把一段文字变成语音**（朗读笔记 / 文档、给英语材料配音、做听力音频）时调用。' +
      '⚠️ 与上面那条方向相反，且**不需要上传文件**：把用户给的文本直接填进 `text`。',
    notFor: ['语音转文字（那是 speech_to_text）', '要的是"真人配音"或特定音色克隆（本平台没有）'],
    invocation: 'auto',
    needsFile: false,
    resultKind: 'file',
    resultHint: '语音已生成',
  },
  {
    toolName: 'summarize_text',
    source: 'tool',
    intent: 'file_process',
    title: '长文总结',
    scene:
      '用户上传了**纯文本文件**（.txt/.md/.csv/.json/.log）并要**提炼要点 / 做摘要**时调用，' +
      '长度偏好填 `length`。',
    notFor: [
      '用户只是把一段文字贴在对话里要总结 —— 那不需要文件，直接回答即可（本工具读的是上传的文件）',
      '用户要总结的是 PDF / Word（文档解析能力尚未上线，如实说明）',
    ],
    invocation: 'guided',
    needsFile: 'text',
    resultKind: 'file',
    resultHint: '总结已生成',
    guideHint: '总结需要先上传文本文件（.txt/.md 等），点下面进入上传页',
  },
  {
    toolName: 'paper_summary',
    source: 'tool',
    intent: 'ai_generate',
    title: '论文解读',
    scene: '用户上传**论文/文献**并要**读懂它**（研究问题、方法、结论）时调用。唯一入参就是文件本身。',
    invocation: 'guided',
    needsFile: 'text',
    resultKind: 'file',
    resultHint: '论文解读已生成',
    guideHint: '论文解读需要先上传论文文本文件，点下面进入上传页',
  },

  // PDF 合并/拆分/压缩/解析 与 音频裁剪/降噪 拆到 ai-capability.catalog.files.ts（本文件贴着 300 行红线）
  ...FILE_MEDIA_CAPABILITIES,
  // 图片类（2026-09-20 从主表拆出，主表有效代码行贴 300 行红线）
  ...IMAGE_CAPABILITIES,
  // 文档生成 / 数据分析（2026-09-19 接入，条目在 ai-capability.catalog.docs.ts）
  ...DOC_DATA_CAPABILITIES,
  ...CAMPUS_CAPABILITIES,

  // ==================== 内部能力（只给 Agent 用，不进工具箱） ====================
  {
    toolName: 'search_knowledge',
    source: 'internal',
    intent: 'knowledge',
    title: '校园知识库检索',
    scene:
      '检索青智校园的官方知识库（校历、规章制度、办事流程、奖助学金政策等）。' +
      '当用户问到学校的具体规定、时间、地点、流程、材料清单时调用它。',
    notFor: ['闲聊、通用常识，以及知识库显然不会收录的问题（天气、编程、写作文）'],
    invocation: 'auto',
    needsFile: false,
    resultKind: 'text',
    resultHint: '已检索知识库',
    // 内部能力不在工具箱里，没有工具表那份 inputSchema，故在此就地声明参数规范
    params: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索关键词。用问题里的核心名词，不要带"请问""帮我查一下"这类口语和大段背景描述。',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];
