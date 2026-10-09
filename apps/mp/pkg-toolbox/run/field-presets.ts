/**
 * 工具执行页的动态表单字段定义（文档 5.3.5）
 *
 * 从 index.ts 拆出来：这里只是**数据表**，不含页面逻辑。
 * 工具的 inputSchema 若已声明字段，以后端为准；未声明时用这里的内置定义兜底。
 */
/** 动态表单字段（由 inputSchema 转换而来） */
export interface FormField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'select' | 'switch';
  required?: boolean;
  placeholder?: string;
  options?: { label: string; value: string }[];
  min?: number;
  max?: number;
  default?: string | number | boolean;
}

/** 已实现工具的字段定义（未在 schema 中声明时使用内置定义） */
export const FIELD_PRESETS: Record<string, FormField[]> = {
  generate_ppt: [
    {
      key: 'topic',
      label: '主题',
      type: 'text',
      required: true,
      placeholder: '如：第十三届创青春商业计划书',
    },
    {
      key: 'purpose',
      label: '用途',
      type: 'select',
      default: 'contest',
      options: [
        { label: '比赛路演', value: 'contest' },
        { label: '课程汇报', value: 'course' },
        { label: '答辩', value: 'defense' },
        { label: '其他', value: 'other' },
      ],
    },
    { key: 'pages', label: '页数', type: 'number', default: 16, min: 5, max: 40 },
    {
      key: 'style',
      label: '风格',
      type: 'select',
      default: 'business',
      options: [
        { label: '商务', value: 'business' },
        { label: '科技', value: 'tech' },
        { label: '清新', value: 'fresh' },
        { label: '学术', value: 'academic' },
        { label: '国潮', value: 'chinese' },
      ],
    },
    { key: 'extra', label: '补充要求', type: 'textarea', placeholder: '如：请突出可持续盈利模式' },
  ],
  compress_image: [
    {
      key: 'quality',
      label: '压缩质量',
      type: 'select',
      default: '80',
      options: [
        { label: '高质量（约 90）', value: '90' },
        { label: '中等（约 80）', value: '80' },
        { label: '小体积（约 60）', value: '60' },
      ],
    },
    {
      key: 'format',
      label: '输出格式',
      type: 'select',
      default: 'jpeg',
      options: [
        { label: 'JPG', value: 'jpeg' },
        { label: 'PNG', value: 'png' },
        { label: 'WebP', value: 'webp' },
      ],
    },
  ],
  convert_image: [
    {
      key: 'format',
      label: '目标格式',
      type: 'select',
      default: 'png',
      options: [
        { label: 'JPG', value: 'jpeg' },
        { label: 'PNG', value: 'png' },
        { label: 'WebP', value: 'webp' },
      ],
    },
  ],
  ocr_image: [
    {
      key: 'lang',
      label: '识别语言',
      type: 'select',
      default: 'chi_sim+eng',
      options: [
        { label: '中英混排', value: 'chi_sim+eng' },
        { label: '仅中文', value: 'chi_sim' },
        { label: '仅英文', value: 'eng' },
      ],
    },
  ],
  remove_background: [],
  compress_video: [
    {
      key: 'quality',
      label: '压缩档位',
      type: 'select',
      default: 'medium',
      options: [
        { label: '高画质', value: 'high' },
        { label: '均衡', value: 'medium' },
        { label: '小体积', value: 'low' },
      ],
    },
    {
      key: 'targetSizeMb',
      label: '目标体积（MB，可选）',
      type: 'number',
      min: 1,
      max: 500,
      placeholder: '留空则按画质档位压缩',
    },
  ],
  convert_video: [
    {
      key: 'format',
      label: '目标格式',
      type: 'select',
      default: 'mp4',
      options: [
        { label: 'MP4', value: 'mp4' },
        { label: 'WebM', value: 'webm' },
        { label: 'GIF', value: 'gif' },
      ],
    },
  ],
  separate_vocals: [
    {
      key: 'stems',
      label: '分离轨道数',
      type: 'select',
      default: '2',
      options: [
        { label: '2 轨（人声 + 伴奏）', value: '2' },
        { label: '4 轨（人声/鼓/贝斯/其他）', value: '4' },
      ],
    },
  ],
  speech_to_text: [
    {
      key: 'language',
      label: '语言',
      type: 'select',
      default: 'zh',
      options: [
        { label: '中文', value: 'zh' },
        { label: '英文', value: 'en' },
        { label: '自动识别', value: 'auto' },
      ],
    },
  ],
  generate_document: [
    {
      key: 'docType',
      label: '文档类型',
      type: 'select',
      // 兜底默认值必须落在 options 里：写 'plan'（不存在的取值）会让下拉框显示空白，
      // 用户以为"没得选"。与后端 tool-input-schemas.ts 的 default 保持一致。
      default: 'business_plan',
      options: [
        { label: '商业计划书', value: 'business_plan' },
        { label: '活动策划', value: 'event_plan' },
        { label: '简历', value: 'resume' },
        { label: '报告', value: 'report' },
        { label: '总结', value: 'summary' },
      ],
    },
    {
      key: 'topic',
      label: '主题',
      type: 'text',
      required: true,
      placeholder: '如：校园二手交易平台',
    },
    { key: 'extra', label: '补充要求', type: 'textarea', placeholder: '可选' },
  ],
  analyze_data: [
    {
      key: 'text',
      label: '表格内容',
      type: 'textarea',
      placeholder: '粘贴 CSV，或从 Excel 选中后直接复制粘贴；已上传文件时留空',
    },
    {
      key: 'focus',
      label: '关注点（可选）',
      type: 'text',
      placeholder: '如：哪一题的满意度最低？',
    },
  ],
};
