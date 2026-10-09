import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  VlmOcrProvider,
  isDegenerateOutput,
  parseOcrOutput,
  sniffImageMime,
} from '../vlm-ocr.provider';

const CFG = {
  baseUrl: 'https://api.siliconflow.cn/v1',
  apiKey: 'sk-test',
  model: 'deepseek-ai/DeepSeek-OCR',
  timeoutMs: 5000,
  maxRetry: 2,
  enableThinking: undefined,
  enabled: true,
};

/** 造一个硅基流动格式的成功响应 */
const okResponse = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

/**
 * 每次都返回**新的** Response 实例。
 * 注意别用 `mockResolvedValue(okResponse(...))` —— Response 的 body 只能消费一次，
 * 重试时会因 body 已读而抛 TypeError，把被测的重试逻辑带偏。
 */
const respondWith = (content: string) => vi.fn(() => Promise.resolve(okResponse(content)));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VlmOcrProvider —— 内容层校验与重试', () => {
  it('首次返回退化内容时重试，第二次正常即成功', async () => {
    let n = 0;
    const fetchMock = vi.fn(() =>
      Promise.resolve(okResponse(n++ === 0 ? '0'.repeat(90) : 'QINGZHI CAMPUS')),
    );
    vi.stubGlobal('fetch', fetchMock);

    const r = await new VlmOcrProvider(CFG).recognize(Buffer.from('fake'));
    expect(r.fullText).toBe('QINGZHI CAMPUS');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('持续返回退化内容 → 抛 AiOutputInvalid，绝不冒充成功', async () => {
    vi.stubGlobal('fetch', respondWith('。'.repeat(60)));

    await expect(new VlmOcrProvider(CFG).recognize(Buffer.from('fake'))).rejects.toThrow(
      /识别结果异常/,
    );
  });

  it('空输出同样走重试，耗尽后报"未返回任何文字"', async () => {
    const fetchMock = respondWith('');
    vi.stubGlobal('fetch', fetchMock);

    await expect(new VlmOcrProvider(CFG).recognize(Buffer.from('fake'))).rejects.toThrow(
      /未返回任何文字/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('4xx 是确定性失败，不重试（避免无谓拖长响应）', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 20015, message: 'does not support parameter' }), {
          status: 400,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(new VlmOcrProvider(CFG).recognize(Buffer.from('fake'))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('默认不发送 enable_thinking（发送了 DeepSeek-OCR 会 400）', async () => {
    const fetchMock = respondWith('文字');
    vi.stubGlobal('fetch', fetchMock);

    await new VlmOcrProvider(CFG).recognize(Buffer.from('fake'));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).not.toHaveProperty('enable_thinking');
  });

  it('显式配置时才带上 enable_thinking', async () => {
    const fetchMock = respondWith('文字');
    vi.stubGlobal('fetch', fetchMock);

    await new VlmOcrProvider({ ...CFG, enableThinking: false }).recognize(Buffer.from('fake'));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.enable_thinking).toBe(false);
  });
});

describe('parseOcrOutput', () => {
  it('按行切分成无坐标块', () => {
    const r = parseOcrOutput('第一行\n第二行\n\n第三行');
    expect(r.blocks).toEqual([{ text: '第一行' }, { text: '第二行' }, { text: '第三行' }]);
    expect(r.fullText).toBe('第一行\n第二行\n第三行');
  });

  it('还原 PaddleOCR-VL 的 <|LOC_x|> 归一化坐标为矩形框', () => {
    const r = parseOcrOutput('标题<|LOC_10|><|LOC_20|><|LOC_300|><|LOC_20|>');
    expect(r.blocks[0].text).toBe('标题');
    expect(r.blocks[0].box).toEqual([
      [10, 20],
      [300, 20],
      [300, 20],
      [10, 20],
    ]);
  });

  it('坐标不足 4 个时退化为无坐标块，不编造位置', () => {
    const r = parseOcrOutput('文字<|LOC_10|><|LOC_20|>');
    expect(r.blocks[0].box).toBeUndefined();
  });

  it('空输入返回空结果而非抛错（由调用方判定失败）', () => {
    expect(parseOcrOutput('').blocks).toEqual([]);
    expect(parseOcrOutput('').fullText).toBe('');
  });
});

describe('isDegenerateOutput —— 拦截"假成功"', () => {
  it('识别出实测遇到的长串重复字符', () => {
    expect(isDegenerateOutput('0'.repeat(90))).toBe(true);
    expect(isDegenerateOutput('。'.repeat(50))).toBe(true);
  });

  it('正常识别结果不误判', () => {
    expect(isDegenerateOutput('QINGZHI CAMPUS OCR TEST 2026')).toBe(false);
    expect(isDegenerateOutput('这是一段正常的中文识别结果，包含标点与英文 mixed content。')).toBe(
      false,
    );
  });

  it('短内容不判定（阈值要求 ≥16 字符，避免误伤）', () => {
    expect(isDegenerateOutput('000000000000000')).toBe(false);
    expect(isDegenerateOutput('无文字')).toBe(false);
  });

  it('图片里真的只有一串数字时不算退化（字符重复率未超阈值）', () => {
    expect(isDegenerateOutput('010101010101010101010101010101')).toBe(false);
  });
});

describe('sniffImageMime —— 不信任扩展名，只认魔数', () => {
  it('识别常见图片格式', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBe('image/png');
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(8)]))).toBe('image/webp');
    expect(sniffImageMime(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(sniffImageMime(Buffer.from([0x42, 0x4d, 0, 0]))).toBe('image/bmp');
  });

  it('无法识别时兜底为 png（多数 API 至少能解出报错，不会静默传空）', () => {
    expect(sniffImageMime(Buffer.from('not-an-image'))).toBe('image/png');
  });
});
