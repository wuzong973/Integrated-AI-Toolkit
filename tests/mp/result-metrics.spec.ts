/**
 * 结果页产出指标展示的回归锚点（MQ-01）。
 *
 * 这组用例守住的是「用户能否看懂产出」：
 *   · 指标要转成人话（体积差带百分比、时长带单位）；
 *   · 未达目标体积必须标 warn —— 照常交付，但要说明"没做到"；
 *   · 质量档位阈值与 @qz/core 的 gradeOf 同源，前端不另立标准。
 */
import { describe, expect, it } from 'vitest';

import type { JobItem } from '../../apps/mp/utils/api';
import { metricRows, qualityLabel } from '../../apps/mp/pkg-toolbox/result/presenters';

/** 造一个最小 JobItem（只填被测字段） */
function jobWith(result: JobItem['result'], qualityScore?: number): JobItem {
  return {
    id: 'j1',
    toolName: 'compress_image',
    status: 'succeeded',
    progress: 100,
    cost: 0,
    outputFiles: ['f1'],
    createdAt: '2026-09-20T00:00:00.000Z',
    result,
    qualityScore,
  };
}

describe('产出指标展示', () => {
  it('体积转成"原→后（省 N%）"，与后端同口径', () => {
    const rows = metricRows(
      jobWith({ kind: 'image', inputBytes: 1024 * 1024, outputBytes: 256 * 1024 }),
    );
    expect(rows[0]).toEqual({ label: '体积', value: '1.0MB → 256KB（省 75%）' });
  });

  it('未达目标体积时标 warn，而不是静默当成功', () => {
    const rows = metricRows(
      jobWith({
        kind: 'image',
        inputBytes: 1000,
        outputBytes: 2000,
        targetMet: false,
      }),
    );
    const warn = rows.find((r) => r.warn);
    expect(warn?.label).toBe('目标体积');
    expect(warn?.value).toContain('未达成');
  });

  it('达成目标时不出现 warn 项', () => {
    const rows = metricRows(
      jobWith({ kind: 'image', inputBytes: 1000, outputBytes: 500, targetMet: true }),
    );
    expect(rows.some((r) => r.warn)).toBe(false);
  });

  it('图片展示尺寸与格式', () => {
    const rows = metricRows(
      jobWith({ kind: 'image', width: 1200, height: 900, format: 'jpeg' }),
    );
    expect(rows).toContainEqual({ label: '尺寸', value: '1200 × 900' });
    expect(rows).toContainEqual({ label: '格式', value: 'JPEG' });
  });

  it('媒体展示时长与编码器（兜底到低质量编码器时用户能看到）', () => {
    const rows = metricRows(
      jobWith({ kind: 'media', durationSec: 12.34, encoder: 'libx264' }),
    );
    expect(rows).toContainEqual({ label: '时长', value: '12.3 秒' });
    expect(rows).toContainEqual({ label: '编码器', value: 'libx264' });
  });

  it('内容类展示字数/页数/版式，而非体积', () => {
    const rows = metricRows(
      jobWith({ kind: 'content', chars: 3200, pages: 16, layoutKinds: 5, chartKinds: 2 }),
    );
    expect(rows).toContainEqual({ label: '字数', value: '3200 字' });
    expect(rows).toContainEqual({ label: '页数', value: '16 页' });
    expect(rows).toContainEqual({ label: '版式', value: '5 种' });
    expect(rows.some((r) => r.label === '体积')).toBe(false);
  });

  it('无指标时返回空数组（页面据此整块不渲染）', () => {
    expect(metricRows(jobWith(undefined))).toEqual([]);
  });
});

describe('质量档位', () => {
  it('阈值与 gradeOf 同源（≥90 优秀 / ≥85 良好 / ≥70 及格 / 其余待改进）', () => {
    expect(qualityLabel(95)?.text).toContain('优秀');
    expect(qualityLabel(86)?.text).toContain('良好');
    expect(qualityLabel(72)?.text).toContain('及格');
    expect(qualityLabel(40)?.text).toContain('待改进');
  });

  it('及格与待改进标 warn，优秀与良好不标', () => {
    expect(qualityLabel(95)?.warn).toBe(false);
    expect(qualityLabel(86)?.warn).toBe(false);
    expect(qualityLabel(72)?.warn).toBe(true);
  });

  it('无分数返回 null（非 AI 工具不显示空档位）', () => {
    expect(qualityLabel(undefined)).toBeNull();
  });
});