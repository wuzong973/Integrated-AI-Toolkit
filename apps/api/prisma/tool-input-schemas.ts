/**
 * 工具入参 schema（文档 6.4.3）
 *
 * 用途：执行页 `pkg-toolbox/run` 用它**动态渲染表单**，不再为每个工具写死页面。
 *
 * 格式约定（JSON Schema 子集 + 两个扩展）：
 *   type / title / default / minimum / maximum / placeholder / required 为标准或约定俗成字段
 *   enum + enumLabels  → 渲染为下拉选择（enum 是值，enumLabels 是中文label，一一对应）
 *   x-widget: 'textarea' → 渲染为多行输入框
 *
 * 纪律：这里只描述**入参**。出参结构与 Provider 能力无关，不要往这里塞。
 *       新增工具时同步在 seed.ts 的 TOOLS 里登记，否则 schema 不会被写入。
 */
import { DATA_SCHEMAS } from './tool-input-schemas.data';
import { IMAGE_SCHEMAS } from './tool-input-schemas.image';
import { PDF_AUDIO_SCHEMAS } from './tool-input-schemas.pdf-audio';

export const TOOL_INPUT_SCHEMAS: Record<string, unknown> = {
  generate_ppt: {
    type: 'object',
    properties: {
      topic: { type: 'string', title: '主题', placeholder: '如：第十三届创青春商业计划书' },
      purpose: {
        type: 'string',
        title: '用途',
        default: 'contest',
        enum: ['contest', 'course', 'defense', 'other'],
        enumLabels: ['比赛路演', '课程汇报', '答辩', '其他'],
      },
      pages: { type: 'number', title: '页数', default: 16, minimum: 5, maximum: 40 },
      style: {
        type: 'string',
        title: '风格',
        default: 'business',
        enum: ['business', 'tech', 'fresh', 'academic', 'chinese'],
        enumLabels: ['商务', '科技', '清新', '学术', '国潮'],
      },
      extra: {
        type: 'string',
        title: '补充要求',
        'x-widget': 'textarea',
        placeholder: '如：请突出可持续盈利模式',
      },
    },
    required: ['topic'],
  },

  generate_document: {
    type: 'object',
    properties: {
      docType: {
        type: 'string',
        title: '文档类型',
        default: 'business_plan',
        enum: ['business_plan', 'event_plan', 'resume', 'report', 'summary'],
        enumLabels: ['商业计划书', '活动策划', '简历', '报告', '总结'],
      },
      topic: { type: 'string', title: '主题', placeholder: '如：校园二手交易平台' },
      extra: { type: 'string', title: '补充要求', 'x-widget': 'textarea', placeholder: '可选' },
    },
    required: ['topic'],
  },

  generate_outline: {
    type: 'object',
    properties: {
      topic: { type: 'string', title: '主题', placeholder: '如：社团招新方案' },
      depth: { type: 'number', title: '大纲层级', default: 2, minimum: 1, maximum: 3 },
    },
    required: ['topic'],
  },

  summarize_text: {
    type: 'object',
    properties: {
      length: {
        type: 'string',
        title: '摘要长度',
        default: 'medium',
        enum: ['short', 'medium', 'long'],
        enumLabels: ['精简（3 条）', '标准（5 条）', '详细（8 条）'],
      },
    },
  },

  generate_image_prompt: {
    type: 'object',
    properties: {
      subject: { type: 'string', title: '画面主体', placeholder: '如：校园秋景中的图书馆' },
      style: {
        type: 'string',
        title: '风格',
        default: 'realistic',
        enum: ['realistic', 'illustration', 'anime', '3d'],
        enumLabels: ['写实', '插画', '二次元', '3D'],
      },
    },
    required: ['subject'],
  },

  compress_video: {
    type: 'object',
    properties: {
      quality: {
        type: 'string',
        title: '压缩档位',
        default: 'medium',
        enum: ['high', 'medium', 'low'],
        enumLabels: ['高画质', '均衡', '小体积'],
      },
      targetSizeMb: {
        type: 'number',
        title: '目标体积（MB，可选）',
        minimum: 1,
        maximum: 500,
        placeholder: '留空则按画质档位压缩',
      },
    },
  },

  convert_video: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        title: '目标格式',
        default: 'mp4',
        enum: ['mp4', 'webm', 'gif'],
        enumLabels: ['MP4', 'WebM', 'GIF'],
      },
    },
  },

  separate_vocals: {
    type: 'object',
    properties: {
      stems: {
        type: 'string',
        title: '分离轨道数',
        default: '2',
        enum: ['2', '4'],
        enumLabels: ['2 轨（人声 + 伴奏）', '4 轨（人声/鼓/贝斯/其他）'],
      },
    },
  },

  // 文字转语音：与同分类其他工具不同，**不需要上传文件** —— 文本来自参数。
  text_to_speech: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        title: '要朗读的文本',
        'x-widget': 'textarea',
        placeholder: '粘贴或输入文本，最多 3000 字',
      },
      voice: {
        type: 'string',
        title: '音色',
        default: 'zh-CN-XiaoxiaoNeural',
        // ⚠️ 必须与侧车白名单（services/media/handlers.py 的 TTS_VOICES）逐字一致：
        // 这里放开而侧车拒绝 → 用户选了个音色却拿到 400；反过来则是有音色用不上。
        enum: [
          'zh-CN-XiaoxiaoNeural',
          'zh-CN-YunxiNeural',
          'zh-CN-YunyangNeural',
          'zh-CN-YunjianNeural',
          'en-US-AriaNeural',
          'en-US-GuyNeural',
          'en-GB-SoniaNeural',
          'en-GB-RyanNeural',
        ],
        enumLabels: [
          '晓晓（女声·温柔）',
          '云希（男声·活泼）',
          '云扬（男声·播报）',
          '云健（男声·沉稳）',
          'Aria（女声·美音）',
          'Guy（男声·美音）',
          'Sonia（女声·英音）',
          'Ryan（男声·英音）',
        ],
      },
    },
    required: ['text'],
  },

  speech_to_text: {
    type: 'object',
    properties: {
      language: {
        type: 'string',
        title: '语言',
        default: 'zh',
        enum: ['zh', 'en', 'auto'],
        enumLabels: ['中文', '英文', '自动识别'],
      },
    },
  },

  convert_audio: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        title: '目标格式',
        default: 'mp3',
        enum: ['mp3', 'wav', 'aac'],
        enumLabels: ['MP3', 'WAV', 'AAC'],
      },
    },
  },

  convert_pdf: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        title: '转换目标',
        default: 'docx',
        enum: ['docx', 'pptx'],
        enumLabels: ['Word（docx）', 'PPT（pptx）'],
      },
    },
  },
  // ---------- 2026-09-19 补登记：这批工具随侧车与 LLM 链路接线一同转 active ----------
  // 纪律：新增工具必须同时有 schema（否则执行页渲染不出表单）与 seed 登记。

  cut_video: {
    type: 'object',
    properties: {
      startSec: { type: 'number', title: '开始时间（秒）', default: 0, minimum: 0 },
      endSec: { type: 'number', title: '结束时间（秒）', minimum: 0, placeholder: '如：30' },
    },
    required: ['endSec'],
  },

  add_subtitle: {
    type: 'object',
    properties: {
      srt: {
        type: 'string',
        title: '字幕内容（SRT）',
        'x-widget': 'textarea',
        placeholder: '标准 SRT 格式：序号一行、时间轴一行、字幕文本一行',
      },
    },
    required: ['srt'],
  },

  generate_resume: {
    type: 'object',
    properties: {
      position: { type: 'string', title: '目标岗位', placeholder: '如：前端开发实习生' },
      name: { type: 'string', title: '姓名（可选）', placeholder: '留空则以「同学」代称' },
      highlights: {
        type: 'string',
        title: '已有素材',
        'x-widget': 'textarea',
        placeholder: '实习/项目/获奖经历，一行一条；留空则由 AI 给示例条目',
      },
    },
    required: ['position'],
  },

  generate_mindmap: {
    type: 'object',
    properties: {
      topic: { type: 'string', title: '主题', placeholder: '如：数据结构期末复习' },
      depth: { type: 'number', title: '层级深度', default: 3, minimum: 2, maximum: 4 },
    },
    required: ['topic'],
  },

  translate_text: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        title: '目标语言',
        default: 'en',
        enum: ['zh', 'en', 'ja', 'ko', 'fr', 'de'],
        enumLabels: ['中文', '英文', '日文', '韩文', '法文', '德文'],
      },
      text: {
        type: 'string',
        title: '要翻译的内容',
        'x-widget': 'textarea',
        placeholder: '直接粘贴；留空则读取所选文件',
      },
    },
  },

  // 仓库解读：唯一必填入参是仓库 URL（deepwiki-open 按 GitHub 仓库生成 Wiki）。
  // URL 格式在执行器里校验（schema 层没有 format 白名单键，写了也会被出方向丢弃）。
  explain_repository: {
    type: 'object',
    properties: {
      repo_url: {
        type: 'string',
        title: 'GitHub 仓库地址',
        placeholder: '如：https://github.com/owner/repo',
      },
      language: {
        type: 'string',
        title: '文档语言',
        default: 'zh',
        enum: ['zh', 'en'],
        enumLabels: ['中文', '英文'],
      },
    },
    required: ['repo_url'],
  },

  paper_summary: {
    type: 'object',
    properties: {},
    // 唯一入参是文件本身，表单只需显示"选择文件"
  },

  solve_question: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        title: '题目文字',
        'x-widget': 'textarea',
        placeholder: '可直接粘贴题目；上传了题目图片时留空即可（会先识别图片）',
      },
      subject: {
        type: 'string',
        title: '科目（可选）',
        default: '不限',
        enum: ['不限', '数学', '物理', '化学', '英语', '计算机', '其他'],
      },
    },
  },

  // 2026-09-19 起新增的 PDF / 音频条目拆到 tool-input-schemas.pdf-audio.ts（本文件贴着 300 行红线）
  ...PDF_AUDIO_SCHEMAS,
  // 图片类（2026-09-20 从主表拆出：主表有效代码行贴 300 行红线）
  ...IMAGE_SCHEMAS,

  // 数据分析（M4 学习类）同样另开一张表
  ...DATA_SCHEMAS,
};
