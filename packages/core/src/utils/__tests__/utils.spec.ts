import { describe, expect, it } from 'vitest';

import { checkFileSize, extOf, formatBytes, kindOf, safeFilename } from '../file';
import { maskName, maskObject, maskPhone, maskStudentNo } from '../mask';
import { addDays, isExpired } from '../time';

describe('文件工具', () => {
  it('识别扩展名与类别', () => {
    expect(extOf('a.PPTX')).toBe('pptx');
    expect(kindOf('a.pptx')).toBe('document');
    expect(kindOf('a.mp4')).toBe('video');
    expect(kindOf('a.unknown')).toBeNull();
  });

  it('大小上限校验（文档 6.4.4）', () => {
    expect(checkFileSize('a.jpg', 5 * 1024 * 1024)).toBeNull();
    expect(checkFileSize('a.jpg', 30 * 1024 * 1024)).toContain('20MB');
    expect(checkFileSize('a.mp4', 600 * 1024 * 1024)).toContain('500MB');
    expect(checkFileSize('a.exe', 1)).toContain('不支持');
  });

  it('体积格式化', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('文件名安全化', () => {
    expect(safeFilename('a/b:c*d?.png')).toBe('a_b_c_d_.png');
  });
});

describe('脱敏工具（文档 6.12.3）', () => {
  it('手机号', () => {
    expect(maskPhone('13812341234')).toBe('138****1234');
  });
  it('学号', () => {
    expect(maskStudentNo('2023010101')).toBe('2023****01');
  });
  it('姓名', () => {
    expect(maskName('张')).toBe('张');
    expect(maskName('张三')).toBe('张*');
    expect(maskName('张三丰')).toBe('张*丰');
  });
  it('对象递归脱敏', () => {
    const masked = maskObject({
      phone: '13812341234',
      token: 'abc',
      nested: { studentNo: '2023010101' },
    });
    expect(masked.phone).toBe('138****1234');
    expect(masked.token).toBe('***');
    expect(masked.nested.studentNo).toBe('2023****01');
  });
});

describe('时间工具', () => {
  it('超时判断（用于 30min 关单 / 7 天自动验收）', () => {
    const now = new Date('2026-09-17T10:00:00Z');
    expect(isExpired(addDays(now, 7), now)).toBe(false);
    expect(isExpired(addDays(now, -1), now)).toBe(true);
  });
});
