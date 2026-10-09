import { afterEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_API_BASE, RELEASE_API_BASE } from '../../apps/mp/config/endpoints';
import { isPlaceholderBase, isUsableOverrideBase } from '../../apps/mp/utils/env';

/**
 * 锁死占位域名判定（排查报告 P0-3）。
 *
 * 这条逻辑的两种 bug 形态都很贵：
 *  - **漏判**（占位域名当成正常地址）→ 真机/线上必然连不上，而现象是"网络开小差了"，
 *    排查方向完全跑偏；
 *  - **误判**（正常地址当成占位）→ 把所有可用环境一并拦死，比原 bug 更严重。
 * 因此这里两个方向都要覆盖。
 */
describe('isPlaceholderBase —— RFC 2606 占位域名必须被识别', () => {
  it('识别三种 example 保留域名', () => {
    expect(isPlaceholderBase('https://api.qingzhi.example.com')).toBe(true);
    expect(isPlaceholderBase('https://api.example.org')).toBe(true);
    expect(isPlaceholderBase('https://example.net')).toBe(true);
  });

  it('识别 .invalid / .test 保留后缀', () => {
    expect(isPlaceholderBase('http://api.invalid')).toBe(true);
    expect(isPlaceholderBase('http://api.test')).toBe(true);
  });

  it('识别带端口与路径的占位地址', () => {
    expect(isPlaceholderBase('https://api-staging.qingzhi.example.com:8443/api/v1')).toBe(true);
  });

  it('取不到 host 时按不可用处理（空串 / 无协议）', () => {
    expect(isPlaceholderBase('')).toBe(true);
    expect(isPlaceholderBase('api.qingzhi.cn')).toBe(true);
  });
});

describe('isPlaceholderBase —— 真实地址绝不能误判', () => {
  it('本机回环地址是合法地址（开发者工具下完全可用）', () => {
    expect(isPlaceholderBase('http://127.0.0.1:3000')).toBe(false);
    expect(isPlaceholderBase('http://localhost:3000')).toBe(false);
  });

  it('局域网 IP 是合法地址（真机调试用）', () => {
    expect(isPlaceholderBase('http://192.168.1.8:3000')).toBe(false);
    expect(isPlaceholderBase('http://10.0.0.5:3000')).toBe(false);
  });

  it('真实域名是合法地址', () => {
    expect(isPlaceholderBase('https://api.qingzhi.cn')).toBe(false);
    expect(isPlaceholderBase('https://api.payun01.cn')).toBe(false);
  });

  it('域名里含 example 但不以它结尾，不算占位', () => {
    // 这是最容易写错的一格：用 includes('example') 就会误判
    expect(isPlaceholderBase('https://example-cdn.qingzhi.cn')).toBe(false);
    expect(isPlaceholderBase('https://myexample.com.cn')).toBe(false);
  });
});

describe('isUsableOverrideBase —— 本地覆盖值必须是真能连的基址', () => {
  it('接受带端口的局域网 IP 与真实域名', () => {
    expect(isUsableOverrideBase('http://192.168.11.32:3000')).toBe(true);
    expect(isUsableOverrideBase('  http://10.0.0.5:3000  ')).toBe(true);
    expect(isUsableOverrideBase('https://api.qingzhi.cn')).toBe(true);
  });

  it('拒绝缺协议 / 带路径以外杂物 / 非字符串', () => {
    // 少了 http:// —— 小程序里会当成相对路径，报错信息完全指不到这里
    expect(isUsableOverrideBase('192.168.11.32:3000')).toBe(false);
    expect(isUsableOverrideBase('')).toBe(false);
    expect(isUsableOverrideBase('   ')).toBe(false);
    expect(isUsableOverrideBase(undefined)).toBe(false);
    expect(isUsableOverrideBase(3000)).toBe(false);
    expect(isUsableOverrideBase('http://192.168.11.32 :3000')).toBe(false);
  });

  it('拒绝占位域名（覆盖不成功能源）', () => {
    expect(isUsableOverrideBase('https://api.qingzhi.example.com')).toBe(false);
    expect(isUsableOverrideBase('http://api.invalid')).toBe(false);
  });
});

/**
 * 本地覆盖（`qz_api_base`）—— 真机调试换 Wi-Fi 后 IP 变了时，不改代码、不重新编译
 * 就能切地址。这几条用例锁死"它只在开发期、且只在值合法时生效"。
 */
describe('本地覆盖基址 —— 仅 develop 且值合法才生效', () => {
  /** 按给定 storage 与 envVersion 重新加载一次 env 模块（API_BASE 是模块级常量） */
  async function loadEnv(storage: Record<string, unknown> = {}, envVersion = 'develop') {
    vi.resetModules();
    vi.stubGlobal('wx', {
      getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
      getStorageSync: (k: string) => storage[k],
    });
    return import('../../apps/mp/utils/env');
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('没设覆盖时用 endpoints.ts 的常量', async () => {
    const env = await loadEnv();
    expect(env.API_BASE_IS_LOCAL_OVERRIDE).toBe(false);
    expect(env.API_BASE).toBe(LOCAL_API_BASE);
  });

  it('设了合法覆盖时以其为准，并给出警告', async () => {
    const env = await loadEnv({ qz_api_base: 'http://192.168.31.33:3000' });
    expect(env.API_BASE).toBe('http://192.168.31.33:3000');
    expect(env.API_BASE_IS_LOCAL_OVERRIDE).toBe(true);
    // 覆盖的是一个真能连的地址，所以不该被当成"占位域名"拦下
    expect(env.API_BASE_IS_PLACEHOLDER).toBe(false);
    expect(env.envConfigWarnings().join()).toContain('storage 覆盖');
  });

  it('脏值被忽略并回落常量，不会把开发环境弄成连不上', async () => {
    for (const bad of ['192.168.31.33:3000', '', 'https://api.qingzhi.example.com']) {
      const env = await loadEnv({ qz_api_base: bad });
      expect(env.API_BASE_IS_LOCAL_OVERRIDE).toBe(false);
      expect(env.API_BASE).toBe(LOCAL_API_BASE);
    }
  });

  it('体验版 / 正式版永不读取本地覆盖（防线上被劫持到内网地址）', async () => {
    const env = await loadEnv({ qz_api_base: 'http://192.168.31.33:3000' }, 'release');
    expect(env.API_BASE_IS_LOCAL_OVERRIDE).toBe(false);
    expect(env.API_BASE).toBe(RELEASE_API_BASE);
  });
});
