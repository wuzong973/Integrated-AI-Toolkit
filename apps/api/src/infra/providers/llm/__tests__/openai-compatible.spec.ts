import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAiCompatibleLlmProvider } from '../openai-compatible.provider';

/**
 * LLM Provider 的重试与降级
 *
 * 重点验证两类失败被正确区分：
 *   · **可重试**（429 / 5xx / 网络）→ 重试，重试耗尽后**换降级模型**
 *   · **确定性**（400，模型名错 / 参数不支持）→ 立刻抛出，**不换模型**（换了也一样失败）
 *
 * 分类错了后果很直接：把 429 当确定性 → 偶发过载变成必然失败；
 * 把 400 当可重试 → 每次配置错误都要白等 21 秒（1s+4s+16s）才报错。
 */
const CFG = {
  driver: 'openai-compatible' as const,
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'sk-test',
  models: { intent: 'glm-4.7-flash', generate: 'glm-4.7-flash', plan: 'glm-4.7-flash' },
  timeoutMs: 5000,
  // 总预算给足，避免这些用例被预算逻辑提前掐断（预算本身的用例见下方 describe）
  totalBudgetMs: 60000,
  // 1 = 只尝试一次、不退避等待，让用例跑得快
  maxRetry: 1,
  fallbackModels: [] as string[],
  reasoningEffort: '' as const,
  // 基线设 false：便于验证"双开关缺一不发"里的"部署方不允许"那一支
  disableThinking: false,
  enabled: true,
};

/** 每次都返回**新的** Response（Response body 只能消费一次，复用会把被测逻辑带偏） */
const respondJson = (status: number, body: unknown) =>
  vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );

const okBody = (content: string, model: string) => ({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  model,
});

/** 智谱过载：HTTP 429 + code 1305 */
const overload = { error: { code: '1305', message: '该模型当前访问量过大，请您稍后再试' } };
/** 参数不被支持：HTTP 400 + code 1210 */
const badParam = { error: { code: '1210', message: '该模型始终思考，不支持关闭思考' } };

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 取第 n 次调用实际发出的 model 名 */
const modelOfCall = (mock: ReturnType<typeof vi.fn>, n: number) =>
  JSON.parse(String(mock.mock.calls[n][1].body)).model as string;

describe('OpenAiCompatibleLlmProvider —— 模型降级', () => {
  it('⭐ 主模型过载（429/1305）时自动降级到备用模型', async () => {
    const calls = [];
    const fetchMock = vi.fn((_url: string, init: { body: string }) => {
      const model = JSON.parse(init.body).model as string;
      calls.push(model);
      return model === 'glm-4.7-flash'
        ? Promise.resolve(
            new Response(JSON.stringify(overload), { status: 429 }),
          )
        : Promise.resolve(
            new Response(JSON.stringify(okBody('可以', model)), { status: 200 }),
          );
    });
    vi.stubGlobal('fetch', fetchMock);

    const p = new OpenAiCompatibleLlmProvider({ ...CFG, fallbackModels: ['glm-5.3-flash'] });
    const res = await p.chat([{ role: 'user', content: 'hi' }]);

    expect(res.content).toBe('可以');
    expect(calls).toEqual(['glm-4.7-flash', 'glm-5.3-flash']);
  });

  // ---------- 降级请求必须关思考 ----------
  // 实测：glm-4.7-flash 作为降级模型时 21.2s 只吐 341 字符推理、content 为空
  // → 降级过去照样空 → 预算耗尽 → 降级链形同虚设。这条就是把"兜底真能兜住"钉死。

  it('⭐ 降级请求自动关闭思考（主模型不关）', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_u: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        return body.model === 'glm-4.7-flash'
          ? Promise.resolve(new Response(JSON.stringify(overload), { status: 429 }))
          : Promise.resolve(
              new Response(JSON.stringify(okBody('可以', body.model)), { status: 200 }),
            );
      }),
    );

    const p = new OpenAiCompatibleLlmProvider({
      ...CFG,
      disableThinking: true,
      fallbackModels: ['glm-5.3-flash'],
    });
    await p.chat([{ role: 'user', content: 'hi' }]);

    expect(bodies).toHaveLength(2);
    // 主模型不关：解题 / 论文摘要需要推理；降级才关："浅一点的答案"好过"没有答案"
    expect(bodies[0]).not.toHaveProperty('thinking');
    expect(bodies[1].thinking).toEqual({ type: 'disabled' });
  });

  it('部署方不允许发 thinking 时，降级请求同样不带（换端点只改配置）', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_u: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        return body.model === 'glm-4.7-flash'
          ? Promise.resolve(new Response(JSON.stringify(overload), { status: 429 }))
          : Promise.resolve(
              new Response(JSON.stringify(okBody('可以', body.model)), { status: 200 }),
            );
      }),
    );

    const p = new OpenAiCompatibleLlmProvider({ ...CFG, fallbackModels: ['glm-5.3-flash'] });
    await p.chat([{ role: 'user', content: 'hi' }]);

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty('thinking');
  });

  it('降级发生时通过 logger 留下可见记录（否则是静默降级）', async () => {
    const warn = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn((_u: string, init: { body: string }) => {
        const model = JSON.parse(init.body).model as string;
        return model === 'glm-4.7-flash'
          ? Promise.resolve(new Response(JSON.stringify(overload), { status: 429 }))
          : Promise.resolve(
              new Response(JSON.stringify(okBody('可以', model)), { status: 200 }),
            );
      }),
    );

    const p = new OpenAiCompatibleLlmProvider({ ...CFG, fallbackModels: ['glm-5.3-flash'] }, {
      warn,
    });
    await p.chat([{ role: 'user', content: 'hi' }]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('glm-4.7-flash');
    expect(String(warn.mock.calls[0][0])).toContain('glm-5.3-flash');
  });

  it('⭐ 确定性失败（400）不换模型 —— 换了也一样失败，白打一次往返', async () => {
    const fetchMock = respondJson(400, badParam);
    vi.stubGlobal('fetch', fetchMock);

    const p = new OpenAiCompatibleLlmProvider({ ...CFG, fallbackModels: ['glm-5.3-flash'] });
    await expect(p.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(modelOfCall(fetchMock, 0)).toBe('glm-4.7-flash');
  });

  it('未配置降级模型时，过载直接报错（保持"只用一个模型"的干净语义）', async () => {
    const fetchMock = respondJson(429, overload);
    vi.stubGlobal('fetch', fetchMock);

    const p = new OpenAiCompatibleLlmProvider({ ...CFG, fallbackModels: [] });
    await expect(p.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('降级列表里与主模型重名的会被剔除（不白试一次）', async () => {
    const fetchMock = respondJson(429, overload);
    vi.stubGlobal('fetch', fetchMock);

    const p = new OpenAiCompatibleLlmProvider({
      ...CFG,
      fallbackModels: ['glm-4.7-flash', 'glm-4.7-flash'],
    });
    await expect(p.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('多个降级模型按顺序尝试，直到有一个成功', async () => {
    const calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_u: string, init: { body: string }) => {
        const model = JSON.parse(init.body).model as string;
        calls.push(model);
        // 前两个（主模型 + 第一个降级）都过载，第三个才健康
        return model === 'glm-5.4-flash'
          ? Promise.resolve(
              new Response(JSON.stringify(okBody('可以', model)), { status: 200 }),
            )
          : Promise.resolve(new Response(JSON.stringify(overload), { status: 429 }));
      }),
    );

    const p = new OpenAiCompatibleLlmProvider({
      ...CFG,
      fallbackModels: ['glm-5.3-flash', 'glm-5.4-flash'],
    });
    const res = await p.chat([{ role: 'user', content: 'hi' }]);

    expect(res.content).toBe('可以');
    expect(calls).toEqual(['glm-4.7-flash', 'glm-5.3-flash', 'glm-5.4-flash']);
  });
});

describe('OpenAiCompatibleLlmProvider —— 请求构造', () => {
  it('reasoning_effort 非空才发送', async () => {
    const fetchMock = respondJson(200, okBody('可以', 'glm-4.7-flash'));
    vi.stubGlobal('fetch', fetchMock);
    await new OpenAiCompatibleLlmProvider(CFG).chat([{ role: 'user', content: 'hi' }]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).not.toHaveProperty(
      'reasoning_effort',
    );
  });

  it('配置了 reasoning_effort 时会带上（low 是实测最优值）', async () => {
    const fetchMock = respondJson(200, okBody('可以', 'glm-4.7-flash'));
    vi.stubGlobal('fetch', fetchMock);
    await new OpenAiCompatibleLlmProvider({ ...CFG, reasoningEffort: 'low' }).chat([
      { role: 'user', content: 'hi' },
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).reasoning_effort).toBe('low');
  });

  // ---------- 关闭思考（thinking）----------
  // 双开关语义：**调用方要求 + 部署方允许，缺一不发**。三支都要钉住 ——
  // 否则很容易退化成"只要调用方传了就发"，把不支持的端点打成 400。

  it('调用方要求 + 配置允许 → 带上 thinking:{type:disabled}', async () => {
    const fetchMock = respondJson(200, okBody('可以', 'glm-4.7-flash'));
    vi.stubGlobal('fetch', fetchMock);
    await new OpenAiCompatibleLlmProvider({ ...CFG, disableThinking: true }).chat(
      [{ role: 'user', content: 'hi' }],
      { disableThinking: true },
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).thinking).toEqual({
      type: 'disabled',
    });
  });

  it('调用方要求但配置不允许 → 不发（换端点时只改配置，不用改代码）', async () => {
    const fetchMock = respondJson(200, okBody('可以', 'glm-4.7-flash'));
    vi.stubGlobal('fetch', fetchMock);
    await new OpenAiCompatibleLlmProvider(CFG).chat([{ role: 'user', content: 'hi' }], {
      disableThinking: true,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).not.toHaveProperty('thinking');
  });

  it('配置允许但调用方没要求 → 不发（默认不打扰需要推理的工具）', async () => {
    const fetchMock = respondJson(200, okBody('可以', 'glm-4.7-flash'));
    vi.stubGlobal('fetch', fetchMock);
    await new OpenAiCompatibleLlmProvider({ ...CFG, disableThinking: true }).chat([
      { role: 'user', content: 'hi' },
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).not.toHaveProperty('thinking');
  });

  it('空内容视为失败，不把空串当成功往上抛', async () => {
    vi.stubGlobal('fetch', respondJson(200, { choices: [{ message: { content: '' } }] }));
    await expect(
      new OpenAiCompatibleLlmProvider(CFG).chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/空内容/);
  });

  it('只输出了推理没有结论时，错误信息点明"把 max_tokens 花完了"', async () => {
    vi.stubGlobal(
      'fetch',
      respondJson(200, {
        choices: [{ message: { content: '', reasoning_content: '思考'.repeat(50) } }],
      }),
    );
    await expect(
      new OpenAiCompatibleLlmProvider(CFG).chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/max_tokens/);
  });
});

/**
 * 时间预算（排查报告 P1-3）
 *
 * 这个 describe 存在的唯一理由：**超时是乘法放大的**。
 * 曾经 `模型数 × (重试次数 × 单次超时 + 退避)` 最坏能到 370 秒，
 * 而小程序请求超时只有 30 秒 —— 前端早断了，后端还在烧配额。
 *
 * 用假时钟而不是真的 sleep：否则"验证 370 秒不会发生"的用例本身要跑 370 秒。
 */
describe('LLM 调用受总预算约束（集成口径）', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('预算不足以发首次请求时，立刻失败并说明原因，不发出任何 HTTP 请求', async () => {
    const fetchMock = respondJson(200, okBody('hi', 'glm-4.7-flash'));
    vi.stubGlobal('fetch', fetchMock);

    // totalBudgetMs = 0 → 首轮 canAttempt() 即为 false
    const p = new OpenAiCompatibleLlmProvider({ ...CFG, totalBudgetMs: 0 });
    await expect(p.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/AI 服务/);

    // 关键断言：一个请求都没发出去。否则"快速失败"就只是文案上的
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('预算充足时行为不变（不会因为加了预算就误伤正常调用）', async () => {
    vi.stubGlobal('fetch', respondJson(200, okBody('正常回答', 'glm-4.7-flash')));
    const res = await new OpenAiCompatibleLlmProvider(CFG).chat([
      { role: 'user', content: 'hi' },
    ]);
    expect(res.content).toBe('正常回答');
  });
});
