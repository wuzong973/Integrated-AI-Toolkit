/**
 * 演示数据（任务清单 M0-10 验收要求）
 *   ① 1 个管理员
 *   ② 3 个演示用户（普通学生 / 认证服务者 / 发布者）
 *   ③ 工具分类与工具目录（对应 M1-01）
 *   ④ 服务分类
 *
 * 用法：npm run db:seed
 * 幂等：全部使用 upsert，可重复执行。
 *
 * 工具口径（2026-09-17 对齐）：
 *   设计文档 6.4.2 的工具表列 35 行 / 36 个 tool name，原 seed 只有 32 个且缺 2 个分类。
 *   本次补齐后共 41 个（36 个设计内 + 5 个仅存在于 seed 的实现项），
 *   其中用户可见 33 个、Agent 内部 8 个（campus/system 类，visible=false）。
 *   ⚠️ 设计文档的 35 行表已滞后于实现，需反向修订（见 docs/dev/ERROR-TRIAGE.md 第 7.1 节）。
 */
import { PrismaClient } from '@prisma/client';

import { TOOL_INPUT_SCHEMAS } from './tool-input-schemas';

const prisma = new PrismaClient();

/**
 * 工具分类（文档 6.4.2）
 *
 * `visible=false` 的分类不进工具箱 UI —— 它们装的是 Agent 在编排中调用的内部能力
 * （建任务、解析需求、知识库检索、内容审核等），不是给用户点的工具。
 * 之所以仍然入库而不是省略，是因为 M2 的 Tool Registry 需要能注册它们；
 * 用"不录进数据库"来表达"不可见"会让 Registry 缺项。
 */
const TOOL_CATEGORIES = [
  { id: 'ai_office', name: 'AI办公', scene: 'ai_office', sort: 1, icon: '📊' },
  { id: 'image', name: '图片工具', scene: 'image', sort: 2, icon: '🖼' },
  { id: 'video', name: '视频工具', scene: 'video', sort: 3, icon: '🎬' },
  { id: 'audio', name: '音频工具', scene: 'audio', sort: 4, icon: '🎵' },
  { id: 'pdf', name: 'PDF', scene: 'pdf', sort: 5, icon: '📕' },
  { id: 'file', name: '文件处理', scene: 'file', sort: 6, icon: '📄' },
  { id: 'ai_learn', name: 'AI学习', scene: 'ai_learn', sort: 7, icon: '🎓' },
  // ---- Agent 内部能力域，用户不可见 ----
  { id: 'campus', name: '校园服务', scene: 'campus', sort: 90, icon: '🏫', visible: false },
  { id: 'system', name: '系统能力', scene: 'system', sort: 91, icon: '⚙️', visible: false },
];

/** 服务分类（文档 5.3.7） */
const SERVICE_CATEGORIES = [
  { id: 'photo', name: '摄影摄像', sort: 1, icon: '📷' },
  { id: 'design', name: 'PPT设计', sort: 2, icon: '🎨' },
  { id: 'copy', name: '文案', sort: 3, icon: '✍' },
  { id: 'code', name: '编程', sort: 4, icon: '' },
  { id: 'tutor', name: '家教', sort: 5, icon: '📚' },
  { id: 'host', name: '主持', sort: 6, icon: '🎤' },
  { id: 'video', name: '剪辑', sort: 7, icon: '✂' },
  { id: 'rent', name: '跑腿', sort: 8, icon: '🏃' },
  { id: 'other', name: '其他', sort: 9, icon: '➕' },
];

/**
 * 工具清单（文档 6.4.2 + 实现补齐）
 * status: active = 已上线；planned = 已规划未实现
 * visible: false = Agent 内部工具，不进工具箱 UI
 *
 * ⚠️ **`status: 'active'` 必须与"执行器是否真能跑"一致**：
 *   · active  —— 工具名已在 `apps/api/src/modules/job/tool-executor.service.ts` 注册，
 *                且对应 Provider 是真实实现。用户点了**真能出结果**。
 *   · planned —— 其余全部。界面显示"即将上线"，点击给明确提示，
 *                后端 `ToolInvokeService.assertAvailable` 也会拒绝（防绕过界面直接调接口）。
 *
 * 为什么必须一致：若 `active` 但执行器没注册，用户点了只会拿到
 * "该工具尚未接入执行器"这种面向开发者的报错 —— 属于"展示与行为不一致"。
 * 这条曾真实发生过：2026-09-17 核对时发现 18 个 active 里有 9 个跑不通。
 * 自查：`npm run check:tools`（比对 seed 与执行器，不依赖数据库）。
 */
const TOOLS = [
  // ---- AI 办公（P0）----
  {
    name: 'generate_outline',
    displayName: 'AI 生成大纲',
    categoryId: 'ai_office',
    description: '根据主题生成结构化大纲',
    price: 1,
    sync: true,
    status: 'active',
    sort: 1,
  },
  {
    name: 'generate_ppt',
    displayName: 'AI PPT 生成',
    categoryId: 'ai_office',
    description: '输入主题，输出可编辑 .pptx（上传 CSV/TSV 可把真实数据画成图表页）',
    price: 5,
    sync: false,
    status: 'active',
    sort: 2,
  },
  {
    name: 'generate_document',
    displayName: 'AI 文档生成',
    categoryId: 'ai_office',
    description: '商业计划书 / 活动策划 / 简历 / 报告 / 总结',
    price: 3,
    sync: false,
    // 2026-09-19 转 active：纯 LLM 工具，与简历/大纲同一条执行链（LlmToolRunner.document），
    // 五类文档的章节骨架在 apps/api/src/modules/job/document-specs.ts
    // 转正前已在 verify:tools 里补了端到端用例（先有验证、再改状态）。
    status: 'active',
    sort: 3,
  },
  {
    name: 'summarize_text',
    displayName: '长文总结',
    categoryId: 'ai_office',
    description: '长文提炼要点',
    price: 1,
    sync: true,
    status: 'active',
    sort: 4,
  },
  {
    name: 'generate_image_prompt',
    displayName: 'AI 生图提示词',
    categoryId: 'ai_office',
    description: '把设计需求转为结构化提示词',
    price: 1,
    sync: true,
    status: 'active',
    sort: 5,
  },
  {
    name: 'generate_resume',
    displayName: 'AI 简历',
    categoryId: 'ai_office',
    description: '生成排版好的简历',
    price: 2,
    sync: false,
    // 2026-09-19 转 active：纯 LLM 工具，LlmToolRunner 已接入（与大纲/总结同一条执行链）
    // 转正前已在 verify:tools 里补了端到端用例（先有验证、再改状态）。
    status: 'active',
    sort: 6,
  },

  // ---- 图片（P0）----
  {
    name: 'compress_image',
    displayName: '图片压缩',
    categoryId: 'image',
    description: '压缩体积，肉眼几乎无损',
    price: 0,
    sync: true,
    status: 'active',
    sort: 1,
  },
  {
    name: 'convert_image',
    displayName: '图片格式转换',
    categoryId: 'image',
    description: 'JPG / PNG / WebP 互转',
    price: 0,
    sync: true,
    status: 'active',
    sort: 2,
  },
  {
    name: 'remove_background',
    displayName: 'AI 抠图',
    categoryId: 'image',
    description: '一键去除背景，输出透明 PNG',
    price: 2,
    sync: false,
    // 2026-09-19 转 active：`services/ai` 的 /ai/matting 已真实实现（rembg + u2net 白名单），
    // 后端 `SidecarImageProvider` 也接上了。此前是 planned 是因为**侧车那边还是 501 占位**，
    // 而 Sharp 的 removeBackground 只会抛错 —— 标 active 就是假功能（红线 9）。
    // 转正前已实测：输入 JPEG → 输出 RGBA PNG，四角 alpha=0、中心 alpha=255。
    status: 'active',
    sort: 3,
  },
  {
    name: 'ocr_image',
    displayName: 'OCR 文字识别',
    categoryId: 'image',
    description: '图片转文字，支持中英混排',
    price: 1,
    sync: false,
    status: 'active',
    sort: 4,
  },
  {
    name: 'enhance_image',
    displayName: '图片增强',
    categoryId: 'image',
    description: '锐化提亮，改善画质',
    price: 2,
    sync: false,
    status: 'active',
    sort: 5,
  },
  {
    name: 'repair_image',
    displayName: '图片修复（授权内容）',
    categoryId: 'image',
    description: '修复瑕疵与遮挡，仅限自有版权内容',
    price: 3,
    sync: false,
    status: 'planned',
    sort: 6,
    requiresCopyrightAck: true,
  },
  {
    name: 'generate_qrcode',
    displayName: '二维码生成',
    categoryId: 'image',
    description: '文本 / 链接转二维码，支持 PNG / SVG',
    // 纯本地计算（node-qrcode），零边际成本 → 免费。
    // 与同分类其他工具不同：它**不需要上传文件**，输入就是一段文本。
    price: 0,
    sync: false,
    // 2026-09-20 接入：五步接入清单已走完（seed → 执行器 → inputSchema →
    // 能力目录 → verify:tools 用例）。node-qrcode 为 MIT，已登记合规清单。
    status: 'active',
    sort: 7,
  },

  // ---- 视频（P1）----
  {
    name: 'compress_video',
    displayName: '视频压缩',
    categoryId: 'video',
    description: '按目标体积压缩',
    price: 2,
    sync: false,
    // 2026-09-19 转 active：services/media 的 /media/compress 落地并实测通过
    // 转正前已在 verify:tools 里补了端到端用例（先有验证、再改状态）。
    status: 'active',
    sort: 1,
  },
  {
    name: 'convert_video',
    displayName: '视频格式转换',
    categoryId: 'video',
    description: 'MOV / AVI / MKV 转 MP4',
    price: 1,
    sync: false,
    // 2026-09-19 转 active：services/media 的 /media/transcode 落地并实测通过
    // 转正前已在 verify:tools 里补了端到端用例（先有验证、再改状态）。
    status: 'active',
    sort: 2,
  },
  {
    name: 'cut_video',
    displayName: '视频裁剪合并',
    categoryId: 'video',
    description: '截取或拼接片段',
    price: 1,
    sync: false,
    // 2026-09-19 转 active：services/media 的 /media/cut 落地并实测通过
    // 转正前已在 verify:tools 里补了端到端用例（先有验证、再改状态）。
    status: 'active',
    sort: 3,
  },
  {
    name: 'add_subtitle',
    displayName: '视频字幕',
    categoryId: 'video',
    description: '自动生成字幕并烧录',
    price: 3,
    sync: false,
    // 2026-09-19 转 active：services/media 的 /media/subtitle（libass 烧录）落地并实测通过
    // 转正前已在 verify:tools 里补了端到端用例（先有验证、再改状态）。
    status: 'active',
    sort: 4,
  },
  {
    name: 'repair_video',
    displayName: '视频修复（授权内容）',
    categoryId: 'video',
    description: '仅限自有版权内容',
    price: 5,
    sync: false,
    status: 'planned',
    sort: 5,
    requiresCopyrightAck: true,
  },

  // ---- 音频（P1）----
  {
    name: 'convert_audio',
    displayName: '音频格式转换',
    categoryId: 'audio',
    description: 'MP3 / WAV / AAC 互转',
    price: 0,
    sync: true,
    // 2026-09-19 转 active：services/media 的 /media/transcode 支持 mp3/wav/aac/flac
    // 转正前已在 verify:tools 里补了端到端用例（先有验证、再改状态）。
    status: 'active',
    sort: 1,
  },
  {
    name: 'separate_vocals',
    displayName: '人声/伴奏分离',
    categoryId: 'audio',
    description: '提取人声或伴奏',
    price: 4,
    sync: false,
    // 2026-09-19 转 active：`services/ai` 新增 /ai/separation（Demucs htdemucs，MIT，权重约 80MB），
    // 后端 SidecarAudioProvider.separateVocals 接通并落多条轨道。
    // ⚠️ 与「音频降噪」是两件事：降噪是一条音轨变干净，这里是拆成人声 + 伴奏两条。
    // 转正前已实测端到端（见 verify:tools 的分离用例）。
    status: 'active',
    sort: 2,
  },
  {
    name: 'speech_to_text',
    displayName: '语音转文字',
    categoryId: 'audio',
    // 不要写"带时间戳"：硅基流动 /audio/transcriptions 实测不返回任何时间戳
    // （verbose_json / srt / vtt 均 400），详见 asr.provider.ts 的说明
    description: '音频转文字，支持中英日韩等多语种',
    price: 2,
    sync: false,
    status: 'active',
    sort: 3,
  },
  {
    name: 'text_to_speech',
    displayName: '文字转语音',
    categoryId: 'audio',
    description: '文本转中文语音（朗读文档、做听力材料）',
    price: 0,
    sync: false,
    // 2026-09-20 接入：走 services/media 的 /media/tts，引擎为 edge-tts
    //（LGPLv3 —— 装在仓库之外的独立 venv + 子进程调用，不入库）。
    // 与 speech_to_text 互为逆操作，且**不需要上传文件**（文本来自参数）。
    status: 'active',
    sort: 6,
  },
  {
    name: 'denoise_audio',
    displayName: '音频降噪',
    categoryId: 'audio',
    description: '去除环境噪声（保留单条完整音轨）',
    price: 1,
    sync: false,
    // 2026-09-19 转 active：services/media 新增 /media/audio-denoise（ffmpeg afftdn）。
    // ⚠️ 刻意**不**把它包装成"人声分离"：降噪是一条音轨变干净，
    // 分离要 Demucs 模型（separate_vocals 同日接入），混着卖会得到错误的结果
    status: 'active',
    sort: 4,
  },
  {
    name: 'cut_audio',
    displayName: '音频裁剪',
    categoryId: 'audio',
    description: '截取音频片段',
    price: 1,
    sync: false,
    // 2026-09-19 转 active：services/media 新增 /media/audio-cut
    //（同容器流复制零损耗，跨容器才重编码），实测 6s 裁成 2s 正确
    status: 'active',
    sort: 5,
  },

  // ---- PDF / 文件（P1）----
  {
    name: 'convert_pdf',
    displayName: 'PDF 转 Word/PPT',
    categoryId: 'pdf',
    description: 'PDF 与 Office 互转',
    price: 1,
    sync: false,
    status: 'planned',
    sort: 1,
  },
  {
    name: 'images_to_pdf',
    displayName: '图片转 PDF',
    categoryId: 'pdf',
    description: '多张图片合成一份 PDF（作业 / 实验报告）',
    // 纯本地计算（sharp + pdf-lib），零边际成本 → 免费
    price: 0,
    sync: false,
    // 2026-09-20 接入。⚠️ 与同分类另外三个不同：它**不走 services/pdf 侧车** ——
    // PyMuPDF CLI 没有"图片转 PDF"子命令，且 AGPL 不允许 import fitz，
    // 因此改走 Node 侧 pdf-lib（MIT）。
    status: 'active',
    // sort 取 5：`convert_pdf` 已占 1（它仍是 planned），本条排在 PDF 类末尾
    sort: 5,
  },
  {
    name: 'merge_pdf',
    displayName: 'PDF 合并',
    categoryId: 'pdf',
    description: '多个 PDF 合并为一个',
    price: 0,
    sync: true,
    // 2026-09-19 转 active：services/pdf 侧车落地（PyMuPDF 以子进程调用，AGPL 引擎不入库），
    // merge / split / compress 三个工具同一条执行链，端到端实测通过后才转正。
    status: 'active',
    sort: 2,
  },
  {
    name: 'split_pdf',
    displayName: 'PDF 拆分',
    categoryId: 'pdf',
    description: '按页码拆分 PDF（可每页一份或按范围）',
    price: 0,
    sync: true,
    status: 'active',
    sort: 3,
  },
  {
    name: 'compress_pdf',
    displayName: 'PDF 压缩',
    categoryId: 'pdf',
    description: '无损优化，减小 PDF 体积',
    price: 1,
    // sync=false：大文档的垃圾回收要时间，走异步作业而不是让请求干等
    sync: false,
    status: 'active',
    sort: 4,
  },
  {
    name: 'convert_file',
    displayName: '文档格式转换',
    categoryId: 'file',
    description: 'docx / md / html 互转',
    price: 1,
    sync: false,
    status: 'planned',
    sort: 1,
  },
  {
    name: 'parse_document',
    displayName: '文档解析',
    categoryId: 'file',
    description: '提取 PDF 文本并按页还原（Word/PPT 解析待 LibreOffice）',
    price: 2,
    sync: false,
    // 2026-09-19 转 active：PDF 走 services/pdf（PyMuPDF）已实测；
    // ⚠️ 仅支持 PDF —— Word/PPT 需要重新排版（LibreOffice），侧车会如实报错
    status: 'active',
    sort: 2,
  },

  // ---- AI 学习（P1）----
  {
    name: 'solve_question',
    displayName: 'AI 解题讲解',
    categoryId: 'ai_learn',
    description: '分步骤讲解解题思路',
    price: 1,
    sync: false,
    // 2026-09-19 转 active：LLM + 已上线的视觉 OCR（支持拍题图片）
    // 转正前已在 verify:tools 里补了端到端用例（先有验证、再改状态）。
    status: 'active',
    sort: 1,
  },
  {
    name: 'paper_summary',
    displayName: '论文摘要翻译',
    categoryId: 'ai_learn',
    description: '长文档摘要与翻译',
    price: 2,
    sync: false,
    // 2026-09-19 转 active：纯 LLM 工具，按学术结构提炼
    // 转正前已在 verify:tools 里补了端到端用例（先有验证、再改状态）。
    status: 'active',
    sort: 2,
  },
  {
    name: 'generate_mindmap',
    displayName: '思维导图',
    categoryId: 'ai_learn',
    description: '主题转思维导图',
    price: 1,
    sync: true,
    // 2026-09-19 转 active：纯 LLM 工具，输出 Markdown + Mermaid
    // 转正前已在 verify:tools 里补了端到端用例（先有验证、再改状态）。
    status: 'active',
    sort: 3,
  },
  {
    name: 'translate_text',
    displayName: 'AI 翻译',
    categoryId: 'ai_learn',
    description: '多语种翻译',
    price: 1,
    sync: true,
    // 2026-09-19 转 active：纯 LLM 工具；输入支持粘贴文本或上传文本文件
    // 转正前已在 verify:tools 里补了端到端用例（先有验证、再改状态）。
    status: 'active',
    sort: 4,
  },
  {
    name: 'explain_repository',
    displayName: '仓库解读',
    categoryId: 'ai_learn',
    // 描述措辞与上线状态对齐：planned 阶段不承诺"现在就能用"
    description: '仓库解读：输入 GitHub 链接生成架构/功能 Wiki',
    price: 2,
    // deepwiki-open 的文档生成是分钟级（DEEPWIKI_TIMEOUT_MS 默认 120s），
    // 远超小程序 30s 请求超时 —— 必须走异步作业，与 generate_ppt 同类
    sync: false,
    // 2026-10-08 登记，保持 planned：执行链路（RepoToolRunner + DeepWikiProvider）
    // 与端到端用例（verify:tools，DEEPWIKI_BASE_URL 未配置时自动跳过）均已就绪，
    // 但 deepwiki-open 尚未部署 —— **部署并配置 DEEPWIKI_BASE_URL 后才改 active**
    //（红线 9：标 active 但服务不在，用户点了只会拿到连接错误）。
    status: 'planned',
    sort: 6,
  },

  // ============================================================
  // 以下为 Agent 内部工具（visible=false），不出现在工具箱 UI
  // 补齐原因：设计文档 6.4.2 的工具表列了这些，但原 seed 漏录，
  //          而 M2 的 Tool Registry / M3 的 AI 极速发布都依赖它们。
  // ============================================================

  // ---- 校园服务（campus）：编排与驿站闭环的内部能力 ----
  {
    name: 'create_task',
    displayName: '创建驿站需求',
    categoryId: 'campus',
    description: 'OS 人力节点一键发布为驿站任务（source=os_plan）',
    price: 0,
    sync: true,
    status: 'planned',
    sort: 1,
    visible: false,
  },
  {
    name: 'search_service_provider',
    displayName: '检索服务者',
    categoryId: 'campus',
    description: '按技能标签与匹配分检索候选服务者',
    price: 0,
    sync: true,
    // 2026-09-20 转 active：作为**内部能力**接进助手（不进工具箱 UI，visible 保持 false）。
    // 只读/解析类，调用无副作用；写操作（create_task / create_order / send_notification）
    // 仍保持 planned —— 它们需要"先确认再执行"，不能只接上就算完。
    // 实现在 modules/os/os-campus-tool.ts，目录见 ai-capability.catalog.campus.ts。
    status: 'active',
    sort: 2,
    visible: false,
  },
  {
    name: 'create_order',
    displayName: '创建订单',
    categoryId: 'campus',
    description: '由任务或服务商品生成担保交易订单',
    price: 0,
    sync: true,
    status: 'planned',
    sort: 3,
    visible: false,
  },
  {
    name: 'calculate_price',
    displayName: '价格计算',
    categoryId: 'campus',
    description: '平台服务费（5% 封顶 20 元）与服务者实收计算',
    price: 0,
    sync: true,
    status: 'planned',
    sort: 4,
    visible: false,
  },
  {
    name: 'parse_requirement',
    displayName: '解析需求',
    categoryId: 'campus',
    description: '一句话 → 结构化需求草稿（M3-07 AI 极速发布）',
    price: 0,
    sync: true,
    // 2026-09-20 转 active：作为**内部能力**接进助手（不进工具箱 UI，visible 保持 false）。
    // 只读/解析类，调用无副作用；写操作（create_task / create_order / send_notification）
    // 仍保持 planned —— 它们需要"先确认再执行"，不能只接上就算完。
    // 实现在 modules/os/os-campus-tool.ts，目录见 ai-capability.catalog.campus.ts。
    status: 'active',
    sort: 5,
    visible: false,
  },

  // ---- 系统能力（system）：跨模块的基础能力 ----
  {
    name: 'send_notification',
    displayName: '发送通知',
    categoryId: 'system',
    description: '站内信 / 订阅消息 / WebSocket 三通道分发',
    price: 0,
    sync: true,
    status: 'planned',
    sort: 1,
    visible: false,
  },
  {
    name: 'search_knowledge',
    displayName: '知识库检索',
    categoryId: 'system',
    description: '校园知识库 RAG 检索，回答带来源引用（M4-06）',
    price: 0,
    sync: true,
    // 2026-09-19 转 active：它是**内部能力**（不进工具箱、不进执行器），由助手的
    // tool calling 进程内直调（`os-tools.ts` 分流 → `os-knowledge-tool.ts`）。
    // 之前一直挂 planned 是"被守卫逼出来的"：`check-tool-status.mjs` 只认执行器注册，
    // 改成 active 会误报"标为 active 但跑不通"。守卫补上内部能力识别后，状态就此如实。
    // 依据：`os.service.ts` 的 chatWithTools 已传 tools 并消费 res.toolCalls；
    //       单测 os.spec.ts「模型发起 search_knowledge：工具被执行」；
    //       verify:os 断言它出现在可用能力清单里。
    // ⚠️ `visible: false` 保持不变 —— 它只给 Agent 用，不进用户工具箱。
    status: 'active',
    sort: 2,
    visible: false,
  },
  {
    name: 'moderate_content',
    displayName: '内容安全审核',
    categoryId: 'system',
    description: '文本与图片合规检测，所有 UGC 必经（M4-05，红线）',
    price: 0,
    sync: true,
    status: 'planned',
    sort: 3,
    visible: false,
  },
  {
    name: 'analyze_data',
    displayName: '数据分析',
    categoryId: 'ai_learn',
    description: '表格 / 问卷数据分析并生成结论',
    price: 2,
    sync: false,
    // 2026-09-19 转 active：统计由代码算（apps/api/src/modules/job/table-stats.ts），
    // LLM 只负责解读；报告里「程序统计」与「AI 分析」分节标注来源。
    // 转正前已在 verify:tools 里补了端到端用例（先有验证、再改状态）。
    status: 'active',
    sort: 5,
  },
];

/** 演示账号（1 管理员 + 3 学生，其中 1 个已认证服务者） */
const DEMO_USERS = [
  {
    openid: 'demo_admin',
    nickname: '平台管理员',
    role: 'admin',
    realName: '管理员',
    credit: 100,
    points: 999,
  },
  {
    openid: 'demo_user',
    nickname: '王同学',
    role: 'student',
    realName: '王小明',
    credit: 88,
    points: 30,
  },
  {
    openid: 'demo_provider',
    nickname: '李同学',
    role: 'provider',
    realName: '李小红',
    credit: 96,
    points: 120,
  },
  {
    openid: 'demo_user2',
    nickname: '张同学',
    role: 'student',
    realName: '张小刚',
    credit: 82,
    points: 20,
  },
];

async function seedSchool() {
  const school = await prisma.school.upsert({
    where: { code: 'QZ-DEMO' },
    update: {},
    create: { code: 'QZ-DEMO', name: '示例大学', city: '上海' },
  });
  console.log('  ✓ 学校：', school.name);
  return school;
}

async function seedCategories(): Promise<void> {
  for (const c of TOOL_CATEGORIES) {
    await prisma.toolCategory.upsert({ where: { id: c.id }, update: c, create: c });
  }
  const vis = TOOL_CATEGORIES.filter((c) => c.visible !== false).length;
  console.log(
    `  ✓ 工具分类：${TOOL_CATEGORIES.length} 个（用户可见 ${vis}，内部 ${TOOL_CATEGORIES.length - vis}）`,
  );

  for (const c of SERVICE_CATEGORIES) {
    await prisma.serviceCategory.upsert({ where: { id: c.id }, update: c, create: c });
  }
  console.log('  ✓ 服务分类：', SERVICE_CATEGORIES.length, '个');
}

async function seedTools(): Promise<void> {
  for (const t of TOOLS) {
    const inputSchema = TOOL_INPUT_SCHEMAS[t.name];
    const data = {
      ...t,
      requiresCopyrightAck: t.requiresCopyrightAck ?? false,
      // 有 schema 才写；没有则保持不动（Prisma 收到 undefined 不会更新该列）
      ...(inputSchema ? { inputSchema } : {}),
    };
    await prisma.tool.upsert({ where: { name: t.name }, update: data, create: data });
  }
  const active = TOOLS.filter((t) => t.status === 'active').length;
  const visible = TOOLS.filter((t) => t.visible !== false).length;
  const withSchema = TOOLS.filter((t) => TOOL_INPUT_SCHEMAS[t.name]).length;
  console.log(
    `  ✓ 工具：${TOOLS.length} 个（已上线 ${active}，规划中 ${TOOLS.length - active}；` +
      `用户可见 ${visible}，Agent 内部 ${TOOLS.length - visible}；含入参 schema ${withSchema}）`,
  );
}

async function seedUsers(schoolId: string): Promise<Record<string, string>> {
  /** openid → userId（种子任务需要发布者外键） */
  const userIds: Record<string, string> = {};

  for (const u of DEMO_USERS) {
    const user = await prisma.user.upsert({
      where: { openid: u.openid },
      update: {
        nickname: u.nickname,
        realName: u.realName,
        schoolId,
        college: '计算机学院',
        grade: '大三',
      },
      create: {
        openid: u.openid,
        nickname: u.nickname,
        realName: u.realName,
        schoolId,
        college: '计算机学院',
        grade: '大三',
      },
    });

    // 主角色 + 学生角色（一账号多身份）
    const roles = u.role === 'student' ? ['student'] : [u.role, 'student'];
    for (const role of roles) {
      await prisma.userRole.upsert({
        where: { userId_role: { userId: user.id, role } },
        update: {},
        create: { userId: user.id, role, scope: role === 'admin' ? 'global' : 'self' },
      });
    }

    const isProvider = u.role === 'provider';
    await prisma.userProfile.upsert({
      where: { userId: user.id },
      update: { creditScore: u.credit },
      create: {
        userId: user.id,
        creditScore: u.credit,
        points: u.points,
        completedOrders: isProvider ? 12 : 0,
        ratingSum: isProvider ? 58 : 0,
        ratingCount: isProvider ? 12 : 0,
        skills: isProvider ? ['摄影', '后期修图', '摄像'] : [],
        bio: isProvider ? '设计学院在读，专注校园摄影 3 年' : null,
      },
    });

    await prisma.wallet.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id, balance: 0, points: u.points },
    });

    userIds[u.openid] = user.id;
    console.log(`  ✓ 用户：${u.nickname}（${u.role}）`);
  }

  await seedAdminAccount(userIds['demo_admin']);
  return userIds;
}

/** 种子里给管理员的初始密码；生产必须用 `ADMIN_INITIAL_PASSWORD` 覆盖 */
const DEV_ADMIN_PASSWORD = 'wzl88888';

/**
 * 后台登录凭证（任务清单 M0-23）
 *
 * ## 为什么需要它
 *
 * 在此之前 `demo_admin` 这个用户**根本登录不上**：C 端登录走微信
 * `code2Session`，开发模式生成的 openid 是 `dev_<hash(code)>`，
 * 永远不可能等于字面量 `demo_admin`。也就是说"种子管理员"是一条死数据 ——
 * 有用户、有 admin 角色，但没有任何一条路径能变成它。
 *
 * 本函数给这个用户补上 `admin_account`：用户名 + 密码登录。
 *
 * ## 密码来源
 *
 * 优先 `ADMIN_INITIAL_PASSWORD`；未配置时用开发默认值，并**大声告警**。
 * 之所以允许有默认值：本地 `db:seed` 后要能立刻登录，否则每个人都得先读文档配环境变量。
 * 但生产环境绝不能带着默认值上线，所以这里把告警写得足够显眼。
 *
 * 幂等：按 `username` upsert。**已存在时不重置密码** ——
 * 否则每次 `db:seed` 都会把运维改过的密码打回默认值。
 */
async function seedAdminAccount(adminUserId: string | undefined): Promise<void> {
  if (!adminUserId) {
    console.log('  ⚠ 缺少管理员用户，跳过后台凭证');
    return;
  }

  const username = process.env.ADMIN_USERNAME || 'admin';
  const fromEnv = process.env.ADMIN_INITIAL_PASSWORD;
  const password = fromEnv || DEV_ADMIN_PASSWORD;

  const existing = await prisma.adminAccount.findUnique({ where: { username } });
  if (existing) {
    console.log(`  ✓ 管理员凭证已存在（${username}），未改动密码`);
    return;
  }

  // 复用运行时的哈希实现，不在这里另写一份 ——
  // 复制一份 scrypt 参数，将来调参就会让"种子密码"与"登录校验"对不上，
  // 而且报错是"密码错误"，排查方向完全被误导。
  const { PasswordService } = await import('../src/modules/admin/password.service');
  const passwordHash = await new PasswordService().hash(password);

  await prisma.adminAccount.create({
    data: {
      userId: adminUserId,
      username,
      passwordHash,
      displayName: '平台管理员',
      adminRole: 'super_admin',
      status: 'active',
    },
  });

  console.log(`  ✓ 后台管理员：${username} / ${password}`);
  if (!fromEnv) {
    console.log(
      '     ⚠ 使用的是开发默认密码。生产环境必须设置 ADMIN_INITIAL_PASSWORD，' +
        '并在首次登录后立即修改（后台右上角 → 修改密码）。',
    );
  }
}

/**
 * 演示任务（驿站）
 *
 * 为什么需要：`GET /station/tasks` 是首页「热门任务」与驿站 Tab 的数据来源。
 * 表里没有数据时页面只能显示空态 —— 空态是**正确**的实现，但没法验证
 * 列表渲染、筛选、分页与详情的真实效果。这里灌几条校园里真实会出现的需求，
 * 让链路可以被真正走一遍。
 *
 * 纪律：这是**开发演示数据**，不是"用假数据冒充功能" ——
 * 数据落在真实表里、走真实查询路径、与真实用户外键关联。
 * 生产环境不应执行本 seed（见 README 的部署说明）。
 *
 * 幂等：按 `taskNo` 唯一键 upsert，可反复执行。
 */
async function seedTasks(userIds: Record<string, string>): Promise<void> {
  const publisher = userIds['demo_user'];
  const second = userIds['demo_user2'];
  if (!publisher || !second) {
    console.log('  ⚠ 缺少演示用户，跳过任务');
    return;
  }

  const days = (n: number) => new Date(Date.now() + n * 86_400_000);

  const tasks = [
    {
      taskNo: 'QZ-DEMO-0001',
      publisherId: publisher,
      categoryId: 'design',
      title: '社团招新海报 + 展架设计',
      description:
        '需要一套招新物料：主视觉海报（A2）一张、易拉宝展架一张。有社团 logo 与往届素材，风格希望活泼一些。交付源文件。',
      budget: 20000,
      budgetType: 'fixed',
      deadline: days(7),
      location: '线上',
      skillTags: ['海报设计', 'PS', 'AI'],
      source: 'manual',
      status: 'published',
      publishedAt: new Date(),
      viewCount: 128,
    },
    {
      taskNo: 'QZ-DEMO-0002',
      publisherId: second,
      categoryId: 'video',
      title: '毕业纪念视频剪辑（约 5 分钟）',
      description:
        '已有约 90 分钟素材（手机 + 微单混拍），需要剪成 5 分钟左右的纪念视频，配乐用我提供的歌单。需要简单字幕与转场。',
      budget: 35000,
      budgetType: 'fixed',
      deadline: days(12),
      location: '线上',
      skillTags: ['剪辑', 'Pr', '调色'],
      source: 'manual',
      status: 'published',
      publishedAt: new Date(),
      viewCount: 96,
    },
    {
      taskNo: 'QZ-DEMO-0003',
      publisherId: publisher,
      categoryId: 'code',
      title: '课程设计：图书管理系统的数据库设计',
      description:
        '需要完成 E-R 图、建表 SQL、主要查询语句与一份 10 页左右的报告。技术栈 MySQL，希望有讲解，方便答辩。',
      budget: 15000,
      budgetType: 'negotiable',
      deadline: days(5),
      location: '图书馆',
      skillTags: ['MySQL', '数据库设计', '文档'],
      source: 'ai_generated',
      status: 'published',
      publishedAt: new Date(),
      viewCount: 210,
    },
    {
      taskNo: 'QZ-DEMO-0004',
      publisherId: second,
      categoryId: 'photo',
      title: '校园写真跟拍（半天，约 3 小时）',
      description:
        '想在老校区拍一组毕业写真，半天时间，室内外都有。需要摄影师自带设备，出片 30 张左右并做基础修图。',
      budget: 40000,
      budgetType: 'fixed',
      deadline: days(20),
      location: '老校区',
      skillTags: ['人像摄影', '修图'],
      source: 'manual',
      status: 'published',
      applyCount: 2,
      publishedAt: new Date(),
      viewCount: 302,
    },
  ];

  for (const t of tasks) {
    await prisma.task.upsert({ where: { taskNo: t.taskNo }, update: t, create: t });
  }
  console.log(`  ✓ 演示任务：${tasks.length} 条（驿站任务大厅）`);
}

/**
 * 练习中心 · 作文题目（M4-16）
 *
 * 为什么作文题目放在 seed 而不是脚本灌入：
 *   句子语料（21,039 条）是外部数据、体量大、要可重跑，所以走 `scripts/db/gen-sentences.mjs`；
 *   作文题是**人工编写的小体量题库**（十余道），改动频率与 seed 同频，放这里改起来最直接。
 *
 * ⚠️ `outline` 是**提纲**不是"写作模板"：给的是"该写哪几点"，
 *   不是"第一段背这句"。背模板会让学生交出一模一样的作文，批改维度里的"词汇/结构"就失效了。
 * ⚠️ `sample` 是**范文**，批改后展示用；`minWords` 是判"是否写够"的下限，
 *   低于下限直接判未完成（作文不设 60 分门槛，见 packages/core 的 WRITE_DIMENSIONS）。
 *
 * 幂等：按 `code` 唯一键 upsert，可反复执行。
 */
async function seedPracticeTopics(): Promise<void> {
  const topics = [
    {
      code: 'cet4-campus-appeal',
      kind: 'exam',
      level: 'cet4',
      title: '校园生活：一封倡议书',
      zhBrief:
        '假定你是校学生会主席，写一封倡议书，号召同学们减少使用一次性餐具。内容包括：一次性餐具的危害、你倡议的具体做法、呼吁大家参与。',
      outline: [
        '开头说明写信身份与目的（学生会 / 倡议减少一次性餐具）',
        '说明两点危害：白色污染难降解、食堂垃圾量增加',
        '给出三条可执行做法：自带餐具、食堂提供折扣、宿舍楼设回收点',
        '结尾呼吁，语气诚恳',
      ],
      sample:
        "Dear fellow students,\n\nI am writing on behalf of the Student Union to call on everyone to cut down on disposable tableware.\n\nDisposable chopsticks and plastic boxes are convenient, but they take hundreds of years to break down and have made the waste bins around our canteen overflow every day. The problem is closer to us than we usually think.\n\nSo here are three simple things we can do. First, bring your own bowl and chopsticks — it takes ten seconds to wash them in the dorm. Second, the canteen will offer a small discount for students who do so, starting next month. Third, we are setting up recycling boxes in every dormitory building so that the boxes we do use can be collected properly.\n\nNone of this is difficult, but it only works if enough of us join in. Let us start with tomorrow's lunch.\n\nYours sincerely,\nLi Hua",
      minWords: 100,
    },
    {
      code: 'cet4-online-study',
      kind: 'exam',
      level: 'cet4',
      title: '校园生活：线上学习的利与弊',
      zhBrief:
        '随着线上课程越来越普遍，有人觉得它灵活方便，也有人担心它缺少监督。请你就此写一篇短文，说明双方观点并给出你的看法。',
      outline: [
        '简述现象：线上课程在高校中越来越普遍',
        '支持方理由：时间灵活、可回看、省通勤',
        '反对方理由：容易走神、缺少面对面讨论、自律要求高',
        '你的看法：形式取决于用法，建议把两者结合',
      ],
      sample:
        'Online courses have become a normal part of university life, and students hold very different views on them.\n\nThose who like them point out that they can watch the lectures whenever they want. If a concept is difficult, they can pause and replay it, and they save the time they would have spent travelling across campus. For students who also work part-time, this flexibility makes a real difference.\n\nOthers are less convinced. Without a teacher in the room, it is easy to open a lecture and then quietly check messages instead. Discussion, which is often where understanding actually happens, becomes awkward on a screen, and the whole arrangement demands a level of self-discipline that not everyone has developed yet.\n\nIn my view, online learning is not good or bad by itself — it depends on how it is used. A sensible arrangement combines recorded lectures with regular face-to-face sessions, so that students keep the flexibility without losing the pressure that keeps them focused.',
      minWords: 120,
    },
    {
      code: 'cet4-volunteer',
      kind: 'exam',
      level: 'cet4',
      title: '社会话题：大学生做志愿者',
      zhBrief:
        '越来越多的在校大学生参与志愿服务。请写一篇短文，谈谈这一现象的原因以及它给学生带来的收获。',
      outline: [
        '阐述现象：志愿服务在大学生中越来越常见',
        '原因一：学校把志愿服务纳入综合评价',
        '原因二：学生希望在求职时展示实践经历',
        '收获：沟通能力、责任感、对社会的真实认识',
      ],
      sample:
        'More and more college students are spending their weekends and holidays on volunteer work, and the reasons behind this trend are worth looking at.\n\nPart of it is institutional. Many universities now include volunteer hours in their overall assessment, so taking part is no longer entirely a personal choice. Part of it is practical: with so many graduates competing for the same jobs, a record of community service is something that makes a resume stand out.\n\nYet the benefits go well beyond the paperwork. Students who teach children in rural areas or help out at a community clinic learn to explain things clearly to people who are not their classmates. They meet problems that no textbook describes, and they discover that responsibility usually means showing up on a day when they would rather not. That kind of experience is difficult to get inside a classroom, and it tends to stay with people long after graduation.',
      minWords: 120,
    },
    {
      code: 'cet6-digital-life',
      kind: 'exam',
      level: 'cet6',
      title: '科技与社会：算法推荐的两面性',
      zhBrief:
        '推荐算法已经成为我们获取信息的主要方式。请写一篇短文，讨论它带来的便利与潜在风险，并提出你的建议。',
      outline: [
        '指出算法推荐已无处不在',
        '便利：筛选信息、降低选择成本、匹配兴趣',
        '风险：信息茧房、注意力被争夺、观点趋于单一',
        '建议：主动接触不同信源、平台提高透明度、个人保留判断',
      ],
      sample:
        'Recommendation algorithms now decide, to a large extent, what we read, watch and listen to. The convenience is obvious and the cost is less so.\n\nOn the positive side, algorithms solve a genuine problem. The amount of available information is far beyond what any person can sort through, and a good recommendation system narrows that down to things we are likely to care about. It saves time, and it occasionally introduces us to work we would never have found on our own.\n\nThe risk lies in what gets filtered out. Because these systems are optimised for engagement, they tend to feed us more of what we already agree with, and over time our view of the world can narrow without our noticing. Our attention, meanwhile, becomes the product being sold, which is why so many platforms are designed to keep us scrolling.\n\nThe way out is not to abandon these tools but to use them less passively. Following sources we disagree with, checking where a claim comes from, and deliberately closing an app before it decides we are finished — none of this is dramatic, but it restores a measure of control that is easy to give away by default.',
      minWords: 150,
    },
    {
      code: 'cet6-ai-language',
      kind: 'exam',
      level: 'cet6',
      title: '科技与社会：AI 与外语学习',
      zhBrief:
        'AI 工具已经能实时翻译、纠正发音。有人认为学外语不再重要，也有人持相反意见。请写一篇短文表达你的立场并论证。',
      outline: [
        '摆出现象：AI 翻译与口语陪练已相当成熟',
        '反方观点：既然能翻译，学外语性价比下降',
        '你的立场（可以是"仍然重要"或"重心要转移"）',
        '两点理由 + 一句对未来的判断',
      ],
      sample:
        'With translation apps that handle whole conversations and AI tutors that correct pronunciation in real time, it is fair to ask whether learning a foreign language is still worth the effort.\n\nThose who say it is not have a reasonable case. If a machine can render meaning accurately enough for a business meeting or a hospital visit, the practical return on years of vocabulary drills looks smaller than it used to. Their argument is really about efficiency, not about the value of languages.\n\nI would argue the goal has simply shifted rather than disappeared. A language is not only a way of transferring information; it carries tone, humour and the assumptions a culture makes about politeness, and those are exactly the things machines still smooth over. Speaking to someone in their own language also signals something a translation app cannot — that you thought they were worth the effort.\n\nWhat will change is the emphasis. Memorising lists of words will matter less; understanding context, reading between the lines and holding a real conversation will matter more. That is a shift in how we learn, not a reason to stop.',
      minWords: 150,
    },
    {
      code: 'cet6-environment',
      kind: 'exam',
      level: 'cet6',
      title: '社会话题：个人行动与环境保护',
      zhBrief: '有人主张环保主要靠政策与企业，个人努力意义有限。请写一篇短文回应这一观点。',
      outline: [
        '复述对立观点：个人努力杯水车薪',
        '承认合理之处：排放与产业结构的量级差异',
        '反驳：个人选择的累积效应与对政策的影响',
        '结论：两者不是替代关系，而是互相推动',
      ],
      sample:
        "It is often said that individual efforts to protect the environment are largely symbolic, since the largest share of emissions comes from industry. There is something to this argument, and it deserves a serious answer rather than a slogan.\n\nThe scale objection is factually sound. A single household sorting its rubbish will not measurably change a national carbon figure, and treating personal habits as a substitute for regulation would let the biggest contributors off the hook. That is a real risk, and it is why environmental policy has to be aimed at industry first.\n\nBut the conclusion that individuals therefore do not matter does not follow. Habits and expectations are what make strict policies politically possible: a city that has already grown used to separating waste will accept stronger rules with far less resistance. Individual choices also add up in ways that are easy to underestimate — a few thousand households changing how they commute is a measurable change in a city's air.\n\nSo the two are not alternatives. Policy sets the framework, and everyday habits decide whether that framework survives contact with real life.",
      minWords: 150,
    },
    {
      code: 'cet4-mock-campus-canteen',
      kind: 'mock',
      level: 'cet4',
      title: '模拟题：食堂价格调整通知',
      zhBrief:
        '假定你是校后勤部负责人，就食堂部分菜品价格调整写一则通知，说明调整原因、调整范围与生效时间。',
      outline: [
        '标题与称呼（Notice / Dear students）',
        '调整原因：原材料成本上涨',
        '调整范围：仅主食与荤菜，素菜与汤免费',
        '生效时间与反馈渠道',
      ],
      sample:
        'Notice\n\nDear students,\n\nIn response to a sustained rise in the cost of raw materials over the past two semesters, the Logistics Office will adjust the prices of selected items in the campus canteen.\n\nThe adjustment covers staple foods and meat dishes, and it will raise their prices by roughly one yuan per portion. Vegetables and soup will remain free of charge, and the discount for students with financial difficulties will not be affected.\n\nThe new prices will take effect on 1 October. Please send any questions or suggestions to the student service desk on the ground floor of the canteen, or leave a message in the feedback box near the entrance.\n\nLogistics Office',
      minWords: 90,
    },
    {
      code: 'cet6-mock-data-privacy',
      kind: 'mock',
      level: 'cet6',
      title: '模拟题：数据隐私与便利的取舍',
      zhBrief: '许多服务以便利换取个人信息。请写一篇短文，分析这种交换是否划算，并给出你的建议。',
      outline: [
        '描述现象：用个人信息换取免费服务已成常态',
        '支持交换：确实换到了便利，且多数数据用途有限',
        '担忧：用途不透明、数据可被二次转售、泄露风险长期存在',
        '建议：最小化授权、定期清理权限、支持更透明的服务',
      ],
      sample:
        'We routinely hand over personal information in exchange for services that are free to use, and most of the time we do not think about the terms of the trade.\n\nSeen from one side, the exchange is reasonable. Location data makes maps usable, and a shopping app that remembers what we like saves genuine time. Much of what is collected is also fairly dull in isolation — a device model, a city, a rough age range.\n\nThe difficulty is that the deal is not really transparent. Users rarely know where their data ends up, and information gathered for one purpose is often passed on for another. Once it has been copied, a leak cannot be undone, and the harm may surface years later in a form nobody anticipated when they tapped "agree".\n\nA more balanced approach would be to grant access narrowly and review it regularly, rather than accepting whatever a default screen offers. It is also worth choosing services that explain plainly what they collect — not because convenience is not worth paying for, but because we should know the price.',
      minWords: 150,
    },
  ];

  for (const t of topics) {
    const data = { ...t, outline: t.outline, source: 'curated' };
    await prisma.practiceTopic.upsert({ where: { code: t.code }, update: data, create: data });
  }

  const exam = topics.filter((t) => t.kind === 'exam').length;
  const mock = topics.filter((t) => t.kind === 'mock').length;
  console.log(`  ✓ 作文题目：${topics.length} 道（真题 ${exam} / 模拟 ${mock}）`);
}

async function main(): Promise<void> {
  console.log('开始灌入演示数据…');
  const school = await seedSchool();
  await seedCategories();
  await seedTools();
  const users = await seedUsers(school.id);
  await seedTasks(users);
  await seedPracticeTopics();
  console.log('\n完成。演示账号 openid：' + DEMO_USERS.map((u) => u.openid).join(' / '));
}

main()
  .catch((e) => {
    console.error('灌入失败：', e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
