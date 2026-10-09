/**
 * 2026-09-19 起新增的入参 schema（PDF 能力 + 音频裁剪/降噪）。
 *
 * 拆出来的原因：`tool-input-schemas.ts` 已贴着单文件 300 行红线，
 * 而这里每加一个工具就是十几行 —— 再往里塞必然超限。
 * 与主表的关系是"合并"：`TOOL_INPUT_SCHEMAS = { ...主表, ...本表 }`。
 *
 * ⚠️ 同一条纪律不变：新增工具必须有 schema（执行页据此渲染表单）+ seed 登记。
 */
export const PDF_AUDIO_SCHEMAS: Record<string, unknown> = {
  // 图片转 PDF：与同分类另外三个不同，它**不走 services/pdf 侧车**
  // （PyMuPDF CLI 没有这条能力），而是 Node 侧 sharp + pdf-lib。
  // 入参都是可选项：**都有默认值**，所以不设 required。
  images_to_pdf: {
    type: 'object',
    properties: {
      pageSize: {
        type: 'string',
        title: '页面尺寸',
        default: 'auto',
        enum: ['auto', 'a4'],
        enumLabels: ['跟随图片（保持原比例）', '统一 A4（等比居中）'],
      },
      quality: { type: 'number', title: '图片质量', default: 85, minimum: 30, maximum: 100 },
      maxSide: {
        type: 'number',
        title: '长边上限（像素）',
        default: 1600,
        minimum: 400,
        maximum: 4000,
        placeholder: '手机直出照片动辄 4000px，压到 1600 仍能看清但体积小很多',
      },
    },
  },

  merge_pdf: {
    type: 'object',
    properties: {},
    // 唯一入参是"按顺序选择的多个文件"，表单只需显示"选择文件（可多选）"
  },

  split_pdf: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        title: '拆分方式',
        default: 'page',
        enum: ['page', 'ranges'],
        enumLabels: ['每页一份', '按页码范围'],
      },
      ranges: {
        type: 'string',
        title: '页码范围',
        placeholder: '如 1-3,5,8-N（N 表示最后一页）；"每页一份"时留空',
      },
    },
  },

  compress_pdf: {
    type: 'object',
    properties: {},
    // 无损优化没有可调参数：有损重排/降采样需要别的引擎，不能假装提供
  },

  parse_document: {
    type: 'object',
    properties: {},
    // 唯一入参是文件本身（当前仅支持 PDF）
  },

  cut_audio: {
    type: 'object',
    properties: {
      startSec: { type: 'number', title: '开始时间（秒）', default: 0, minimum: 0 },
      endSec: { type: 'number', title: '结束时间（秒）', minimum: 0, placeholder: '如：30' },
    },
    required: ['endSec'],
  },

  denoise_audio: {
    type: 'object',
    properties: {
      strength: {
        type: 'string',
        title: '降噪强度',
        default: 'medium',
        enum: ['light', 'medium', 'strong'],
        enumLabels: ['轻度（保留更多细节）', '均衡', '强力（人声更干净）'],
      },
    },
  },
};
