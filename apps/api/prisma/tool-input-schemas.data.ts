/**
 * 「数据分析」的入参 schema。
 *
 * 单独成文件的原因与 `tool-input-schemas.pdf-audio.ts` 相同：
 * 主表 `tool-input-schemas.ts` 已到 290 行（单文件 300 行红线只剩 10 行余量），
 * 再往里加一条必然超限。
 *
 * ⚠️ 同一条纪律不变：新增工具必须有 schema（执行页据此渲染表单）+ seed 登记，缺一不可。
 */
export const DATA_SCHEMAS: Record<string, unknown> = {
  analyze_data: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        title: '表格内容',
        'x-widget': 'textarea',
        placeholder: '粘贴 CSV，或从 Excel 选中后直接复制粘贴；已上传文件时留空',
      },
      focus: {
        type: 'string',
        title: '关注点（可选）',
        placeholder: '如：哪一题的满意度最低？',
      },
    },
  },
};
