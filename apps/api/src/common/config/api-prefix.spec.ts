import { describe, expect, it } from 'vitest';

import { splitApiPrefix } from './api-prefix';

describe('splitApiPrefix（文档 9.1：BaseURL = /api/v1）', () => {
  it('带版本号的常见写法拆成前缀 + 版本', () => {
    expect(splitApiPrefix('/api/v1')).toEqual({ prefix: 'api', version: '1' });
    expect(splitApiPrefix('/api/v2')).toEqual({ prefix: 'api', version: '2' });
  });

  it('多级前缀只把最后一段当版本号', () => {
    expect(splitApiPrefix('/qz/gateway/v3')).toEqual({ prefix: 'qz/gateway', version: '3' });
  });

  it('没有版本号时回退到 v1', () => {
    expect(splitApiPrefix('/api')).toEqual({ prefix: 'api', version: '1' });
    expect(splitApiPrefix('/api/')).toEqual({ prefix: 'api', version: '1' });
  });

  it('空前缀退化为 /v1', () => {
    expect(splitApiPrefix('/')).toEqual({ prefix: '', version: '1' });
    expect(splitApiPrefix('')).toEqual({ prefix: '', version: '1' });
  });

  it('非数字版本后缀不当成版本号', () => {
    expect(splitApiPrefix('/api/beta')).toEqual({ prefix: 'api/beta', version: '1' });
  });
});
