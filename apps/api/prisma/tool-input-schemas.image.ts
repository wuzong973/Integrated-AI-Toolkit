/**
 * 「图片类」的入参 schema（压缩 / 转格式 / OCR / 增强 / 二维码）。
 *
 * 单独成文件的原因与 `tool-input-schemas.data.ts` 相同：主表贴着单文件 300 行红线，
 * 再往里加一条必然超限。
 *
 * ⚠️ 2026-09-20 的教训：ESLint `max-lines` 数的是**有效代码行**（不含空行与注释），
 * 所以"总行数 341"不等于"341/300" —— 加二维码之前主表其实还有余量，加了才真的越线。
 * **别用总行数判断有没有超红线，要以 lint 为准。**
 *
 * ⚠️ 同一条纪律不变：新增工具必须有 schema（执行页据此渲染表单）+ seed 登记，缺一不可。
 */
export const IMAGE_SCHEMAS: Record<string, unknown> = {
  // 二维码：与其他图片类工具不同，**不需要上传文件** —— 输入就是一段文本。
  // 容错级别直接影响容量（L 能装最多、H 最抗遮挡），所以 enumLabels 里写清权衡，
  // 否则用户只会选"看起来最高级"的 H，然后抱怨装不下长链接。
  generate_qrcode: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        title: '内容',
        'x-widget': 'textarea',
        placeholder: '要编码的文字或链接，如 https://example.com',
      },
      size: { type: 'number', title: '尺寸（像素）', default: 512, minimum: 64, maximum: 2048 },
      level: {
        type: 'string',
        title: '容错级别',
        default: 'M',
        enum: ['L', 'M', 'Q', 'H'],
        enumLabels: ['L（约 7%，容量最大）', 'M（约 15%）', 'Q（约 25%）', 'H（约 30%，最抗遮挡）'],
      },
      format: {
        type: 'string',
        title: '输出格式',
        default: 'png',
        enum: ['png', 'svg'],
        enumLabels: ['PNG（通用）', 'SVG（放大不模糊）'],
      },
      margin: { type: 'number', title: '留白（模块数）', default: 2, minimum: 0, maximum: 16 },
      dark: { type: 'string', title: '前景色（可选）', placeholder: '如 #1a73e8，默认黑色' },
      light: { type: 'string', title: '背景色（可选）', placeholder: '如 #ffffff，默认白色' },
    },
    required: ['text'],
  },

  compress_image: {
    type: 'object',
    properties: {
      quality: {
        type: 'string',
        title: '压缩质量',
        default: '80',
        enum: ['90', '80', '60'],
        enumLabels: ['高质量（约 90）', '中等（约 80）', '小体积（约 60）'],
      },
      format: {
        type: 'string',
        title: '输出格式',
        default: 'jpeg',
        enum: ['jpeg', 'png', 'webp'],
        enumLabels: ['JPG', 'PNG', 'WebP'],
      },
      targetSizeKb: {
        type: 'number',
        title: '目标体积（KB，可选）',
        minimum: 10,
        maximum: 50000,
        placeholder: '如 200；填了会尽量压到该体积，压不到会如实告知',
      },
    },
  },

  convert_image: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        title: '目标格式',
        default: 'png',
        enum: ['jpeg', 'png', 'webp'],
        enumLabels: ['JPG', 'PNG', 'WebP'],
      },
    },
  },

  ocr_image: {
    type: 'object',
    properties: {
      lang: {
        type: 'string',
        title: '识别语言',
        default: 'chi_sim+eng',
        enum: ['chi_sim+eng', 'chi_sim', 'eng'],
        enumLabels: ['中英混排', '仅中文', '仅英文'],
      },
    },
  },

  enhance_image: {
    type: 'object',
    properties: {
      strength: { type: 'number', title: '增强强度', default: 50, minimum: 0, maximum: 100 },
    },
  },
};
