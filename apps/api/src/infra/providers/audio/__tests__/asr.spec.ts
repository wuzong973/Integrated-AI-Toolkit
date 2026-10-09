import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SiliconflowAsrProvider,
  isRetryableAsrError,
  normalizeAsrLanguage,
  sniffAudioMime,
} from '../asr.provider';

const CFG = {
  baseUrl: 'https://api.siliconflow.cn/v1',
  apiKey: 'sk-test',
  model: 'Qwen/Qwen3-ASR-1.7B',
  timeoutMs: 5000,
  // 默认 0 = 不重试，让这些用例保持"一次请求"的简单语义；
  // 重试行为单独在下面的 describe 里测。
  maxRetry: 0,
  totalBudgetMs: 30000,
  enabled: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 捕获实际发出的 multipart 表单里某个字段的值 */
async function capturedLanguage(language?: string): Promise<string | null> {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ text: '识别结果' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);

  await new SiliconflowAsrProvider(CFG).speechToText(Buffer.from('RIFF0000WAVE'), { language });

  const form = fetchMock.mock.calls[0][1].body as FormData;
  const v = form.get('language');
  return v === null ? null : String(v);
}

describe('normalizeAsrLanguage —— 白名单归一化', () => {
  it('保留白名单内的语言码', () => {
    expect(normalizeAsrLanguage('zh')).toBe('zh');
    expect(normalizeAsrLanguage('en')).toBe('en');
    expect(normalizeAsrLanguage('ja')).toBe('ja');
    expect(normalizeAsrLanguage('yue')).toBe('yue');
  });

  it('"自动识别"（auto）映射为不发送参数 —— 这是小程序界面的一个真实选项', () => {
    // 实测把 auto 原样发给 /audio/transcriptions 会 400，必须在这里拦掉
    expect(normalizeAsrLanguage('auto')).toBeUndefined();
  });

  it('带地区后缀的 BCP-47 截到主语言（zh-CN 原样发会 400）', () => {
    expect(normalizeAsrLanguage('zh-CN')).toBe('zh');
    expect(normalizeAsrLanguage('en-US')).toBe('en');
    expect(normalizeAsrLanguage('zh_Hant')).toBe('zh');
  });

  it('大小写与空白不影响结果', () => {
    expect(normalizeAsrLanguage('  ZH  ')).toBe('zh');
  });

  it('自然语言名与白名单外的码一律退回自动识别，而不是让请求失败', () => {
    expect(normalizeAsrLanguage('中文')).toBeUndefined();
    expect(normalizeAsrLanguage('xx')).toBeUndefined();
    expect(normalizeAsrLanguage('')).toBeUndefined();
    expect(normalizeAsrLanguage(undefined)).toBeUndefined();
  });
});

describe('SiliconflowAsrProvider —— 请求构造', () => {
  it('language=zh 时表单里带上 language', async () => {
    expect(await capturedLanguage('zh')).toBe('zh');
  });

  it('language=auto 时表单里不带 language（避免 400）', async () => {
    expect(await capturedLanguage('auto')).toBeNull();
  });

  it('未指定语言时表单里不带 language', async () => {
    expect(await capturedLanguage(undefined)).toBeNull();
  });

  it('不属于本 Provider 的能力抛明确错误，并指明正确的调用入口', async () => {
    const p = new SiliconflowAsrProvider(CFG);
    // ⚠️ 断言的是"指向正确入口"，而不是"尚未接入" ——
    // 这三个能力其实都已上线，只是入口在 SidecarAudioProvider。
    // 文案若退回"尚未接入"，会让排障的人去翻任务清单，而真正原因是调用链走错了 Provider。
    await expect(p.convert()).rejects.toThrow(/SidecarAudioProvider/);
    await expect(p.denoise()).rejects.toThrow(/SidecarAudioProvider/);
    await expect(p.separateVocals()).rejects.toThrow(/SidecarAudioProvider/);
  });

  it('返回结构正确且不伪造时间轴（该端点不提供时间戳）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ text: '你好世界', usage: { seconds: 2 } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ),
    );
    const r = await new SiliconflowAsrProvider(CFG).speechToText(Buffer.from('RIFF0000WAVE'));
    expect(r.text).toBe('你好世界');
    expect(r.segments).toEqual([]);
  });

  it('无语音内容时报错，不返回空结果', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ text: '   ' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ),
    );
    await expect(
      new SiliconflowAsrProvider(CFG).speechToText(Buffer.from('RIFF0000WAVE')),
    ).rejects.toThrow(/未识别到语音内容/);
  });
});

describe('sniffAudioMime —— 不信任文件名，只认魔数', () => {
  it('识别常见音频格式', () => {
    expect(sniffAudioMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(8)]))).toBe('audio/wav');
    expect(sniffAudioMime(Buffer.from('ID3xxxx'))).toBe('audio/mpeg');
    expect(sniffAudioMime(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe('audio/mpeg');
    expect(sniffAudioMime(Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp')]))).toBe('audio/mp4');
    expect(sniffAudioMime(Buffer.from('OggSxxxx'))).toBe('audio/ogg');
    expect(sniffAudioMime(Buffer.from('fLaCxxxx'))).toBe('audio/flac');
  });

  it('无法识别时兜底为 wav', () => {
    expect(sniffAudioMime(Buffer.from('not-audio'))).toBe('audio/wav');
  });
});

/**
 * 重试与错误分类（排查报告 P1-4）
 *
 * 起因：`ASR_TIMEOUT_MS` 曾是 **120000（2 分钟）**，而实测成功耗时只有 78~97ms。
 * 供应商偶发挂起时（约 35% 的调用），用户要干等两分钟才看到失败。
 *
 * 修法有两半，这里都锁住：
 *  ① 超时压到 20s（配置层）；
 *  ② 超时**重试一次** —— 挂起是间歇性的，同一次音频第二次往往 78ms 就成功。
 * 关键风险是**分类写错**：把超时当确定性失败 → 丢掉 ~35% 可用性；
 * 把 400 当可重试 → 每次配置错误都白等两轮。
 */
describe('ASR 重试 —— 偶发挂起要重试，确定性失败不重试', () => {
  afterEach(() => vi.unstubAllGlobals());

  const okResponse = () =>
    new Response(JSON.stringify({ text: '识别结果' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  it('首次超时、第二次成功 → 整体成功（这正是线上最常见的形态）', async () => {
    let call = 0;
    const fetchMock = vi.fn(() => {
      call++;
      if (call === 1) return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return Promise.resolve(okResponse());
    });
    vi.stubGlobal('fetch', fetchMock);

    const p = new SiliconflowAsrProvider({ ...CFG, maxRetry: 1 });
    const r = await p.speechToText(Buffer.from('RIFF0000WAVE'));

    expect(r.text).toBe('识别结果');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('重试用尽仍失败 → 抛出原始错误，绝不冒充成功', async () => {
    const fetchMock = vi.fn(() =>
      Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const p = new SiliconflowAsrProvider({ ...CFG, maxRetry: 1 });
    await expect(p.speechToText(Buffer.from('RIFF0000WAVE'))).rejects.toThrow();
    // maxRetry=1 → 共 2 次尝试，不能变成无限重试
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('400（参数/凭证错）不重试 —— 再发一次结果一样，只多花一次额度', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 20012, message: 'Model does not exist' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const p = new SiliconflowAsrProvider({ ...CFG, maxRetry: 1 });
    await expect(p.speechToText(Buffer.from('RIFF0000WAVE'))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('空结果不重试（音频里真没人声，重试也是空的）', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ text: '   ' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const p = new SiliconflowAsrProvider({ ...CFG, maxRetry: 1 });
    await expect(p.speechToText(Buffer.from('RIFF0000WAVE'))).rejects.toThrow(/未识别到语音内容/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('预算不足以再尝试时不再发第二次请求（不"必然超时还花钱"）', async () => {
    const fetchMock = vi.fn(() =>
      Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    // 预算 1ms → 首次尝试前 canAttempt() 就为 false，一个请求都不该发
    const p = new SiliconflowAsrProvider({ ...CFG, maxRetry: 1, totalBudgetMs: 1 });
    await expect(p.speechToText(Buffer.from('RIFF0000WAVE'))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('isRetryableAsrError —— 分类是重试策略的开关', () => {
  it('超时 / 网络错误可重试', () => {
    expect(isRetryableAsrError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isRetryableAsrError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
    expect(isRetryableAsrError(Object.assign(new Error('x'), { name: 'TypeError' }))).toBe(true);
  });

  it('未知错误不重试（宁可少试一次，也不要无界重试）', () => {
    expect(isRetryableAsrError(new Error('boom'))).toBe(false);
    expect(isRetryableAsrError('字符串')).toBe(false);
    expect(isRetryableAsrError(null)).toBe(false);
    expect(isRetryableAsrError(undefined)).toBe(false);
  });
});
