import { describe, expect, it, vi } from 'vitest';
import { BizException, ErrorCode } from '@qz/core';

import { AiDispatchService } from '../ai-dispatch.service';
import type { ResolvedCapability } from '../os-capability.registry';

/**
 * AI 能力统一调度
 *
 * 这一层的用例数量不多，但每一条都对应一个**真实踩过的失败形态**：
 *   · 模型没调用就说"做好了"        → 只有真执行过才允许有 result 卡；
 *   · 需要文件却硬调（用户没上传）  → 必须回引导卡，且**不能建作业**；
 *   · 必填项缺失就执行              → 产出"未命名演示文稿"这种用户没要过的东西；
 *   · 执行失败却报成功              → 提示词必须拿到**真实原因**，否则它会自己编一个；
 *   · 同一个调用被重复执行两次      → 幂等键必须按"调用位置"生成。
 */

const PPT: ResolvedCapability = {
  toolName: 'generate_ppt',
  source: 'tool',
  intent: 'ai_generate',
  title: 'AI PPT 生成',
  scene: '用户要 PPT 时调用',
  invocation: 'auto',
  needsFile: false,
  resultKind: 'file',
  resultHint: '演示文稿已生成',
  displayName: 'AI PPT 生成',
  price: 5,
  sync: false,
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', title: '主题' },
      pages: { type: 'number', title: '页数', default: 16 },
    },
    required: ['topic'],
  },
};

const MATTING: ResolvedCapability = {
  ...PPT,
  toolName: 'remove_background',
  title: 'AI 抠图',
  intent: 'file_process',
  needsFile: 'image',
  invocation: 'guided',
  guideHint: '抠图需要先上传图片，点下面进入上传页',
  inputSchema: { type: 'object', properties: {}, required: [] },
};

/** 能力注册表桩：`require` 只认传进来的那几条 */
function makeRegistry(caps: ResolvedCapability[]) {
  return {
    require: vi.fn(async (name: string) => {
      const hit = caps.find((c) => c.toolName === name);
      if (!hit) throw new Error(`未在 AI 能力目录里注册：${name}`);
      return hit;
    }),
  };
}

function makeService(caps: ResolvedCapability[], invoke = vi.fn()) {
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const svc = new AiDispatchService(makeRegistry(caps) as never, { invoke } as never, logger as never);
  return { svc, invoke, logger };
}

const input = {
  userId: 'u1',
  sessionId: 'sess-1',
  toolName: 'generate_ppt',
  rawArgs: '{"topic":"创青春路演"}',
  fileIds: [] as string[],
  callToken: '0-0',
};

describe('AiDispatchService —— 白名单与参数收敛', () => {
  it('⭐ 未注册的能力被拒绝，且**连 invoke 都不调用**（M2-08：未注册工具无法调用）', async () => {
    const { svc, invoke } = makeService([PPT]);
    await expect(svc.dispatch({ ...input, toolName: 'delete_everything' })).rejects.toThrow(
      /未在 AI 能力目录里注册/,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('⭐ 必填项缺失 → 追问，不执行（否则会产出用户没要过的"未命名演示文稿"）', async () => {
    const { svc, invoke } = makeService([PPT]);
    const r = await svc.dispatch({ ...input, rawArgs: '{"pages":20}' });

    expect(invoke).not.toHaveBeenCalled();
    expect(r.card).toBeUndefined();
    // 没执行就必须报 false：出口净化靠它识别"没做却说做完了"
    expect(r.executed).toBe(false);
    expect(r.forModel).toContain('未执行');
    expect(r.forModel).toContain('主题(topic)');
    expect(r.forModel).toContain('不要自己编一个值');
  });

  it('参数按工具 schema 收敛后再交给调用入口（模型给的字符串数字被转成数字）', async () => {
    const invoke = vi.fn(async () => ({ jobId: 'job-1', status: 'queued' }));
    const { svc } = makeService([PPT], invoke);
    await svc.dispatch({ ...input, rawArgs: '{"topic":"X","pages":"20","reason":"解释"}' });

    const dto = (invoke.mock.calls[0] as unknown as [string, string, { params: unknown }])[2];
    expect(dto.params).toEqual({ topic: 'X', pages: 20 });
  });
});

describe('AiDispatchService —— 需要文件的能力', () => {
  it('⭐ 对话里没有文件 → 回引导卡，**不建作业**（引导 ≠ 执行）', async () => {
    const { svc, invoke } = makeService([MATTING]);
    const r = await svc.dispatch({ ...input, toolName: 'remove_background', rawArgs: '{}' });

    expect(invoke).not.toHaveBeenCalled();
    expect(r.card?.kind).toBe('guide');
    expect(r.card?.route).toContain('/pkg-toolbox/run/index?toolName=remove_background');
    expect(r.card?.jobId).toBeUndefined();
    // ⚠️ 引导**不算执行** —— 否则模型可以借"我给了上传链接"说"已经处理好了"
    expect(r.executed).toBe(false);
    // 提示词要明确"别说他做不到、也别假装做完了"
    expect(r.forModel).toContain('不要说他做不到');
  });

  it('⭐ 对话里已有文件 → 真的执行（"引导"只是缺文件时的降级，不是永久限制）', async () => {
    const invoke = vi.fn(async () => ({ jobId: 'job-9', status: 'succeeded' }));
    const { svc } = makeService([MATTING], invoke);
    const r = await svc.dispatch({
      ...input,
      toolName: 'remove_background',
      rawArgs: '{}',
      fileIds: ['file-1'],
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(r.card?.kind).toBe('result');
    expect(r.card?.jobId).toBe('job-9');
    expect(r.executed).toBe(true);
  });

  it('引导卡会把已解析的参数带进路由（用户点进去表单已填好）', async () => {
    const compress = {
      ...MATTING,
      toolName: 'compress_image',
      title: '图片压缩',
      inputSchema: {
        type: 'object',
        properties: { quality: { type: 'string', default: '80' } },
        required: [],
      },
    };
    const { svc } = makeService([compress]);
    const r = await svc.dispatch({ ...input, toolName: 'compress_image', rawArgs: '{}' });

    expect(r.card?.route).toContain('quality=80');
    expect(r.card?.params).toEqual([{ label: 'quality', value: '80' }]);
  });
});

describe('AiDispatchService —— 结果整合', () => {
  it('⭐ 长任务（sync=false）提交后回进度卡，并如实说明要看进度', async () => {
    const invoke = vi.fn(async () => ({ jobId: 'job-2', status: 'queued' }));
    const { svc } = makeService([PPT], invoke);

    const r = await svc.dispatch(input);

    // 第二个参数是幂等键（按"调用位置"生成，见下一条用例）
    const [, , dto, key] = invoke.mock.calls[0] as unknown as [unknown, unknown, { async: boolean }, string];
    expect(dto.async).toBe(true);
    expect(key).toBe('os:sess-1:generate_ppt:0-0');

    expect(r.card?.kind).toBe('result');
    expect(r.card?.status).toBe('queued');
    expect(r.card?.note).toContain('进度');
    expect(r.forModel).toContain('不要再重复调用');
  });

  it('⭐ 秒级工具（sync=true）同步拿结果，卡片带产物数量', async () => {
    const fast = { ...PPT, toolName: 'generate_outline', sync: true };
    const invoke = vi.fn(async () => ({
      jobId: 'job-3',
      status: 'succeeded',
      result: { outputFiles: ['f1'] },
    }));
    const { svc } = makeService([fast], invoke);

    const r = await svc.dispatch({ ...input, toolName: 'generate_outline' });

    const dto = (invoke.mock.calls[0] as unknown as [unknown, unknown, { async: boolean }])[2];
    expect(dto.async).toBe(false);
    expect(r.card?.status).toBe('succeeded');
    expect(r.card?.outputCount).toBe(1);
    expect(r.forModel).toContain('点下面的卡片');
  });

  it('⭐ 失败时把**真实原因**交给模型（否则它会自己编一个更友好的理由）', async () => {
    const invoke = vi.fn(async () => {
      throw new BizException(ErrorCode.DailyQuotaExceeded, undefined, '「AI PPT 生成」今日可用次数已用完');
    });
    const { svc } = makeService([PPT], invoke);

    const r = await svc.dispatch(input);

    expect(r.card).toBeUndefined();
    // 执行失败也算"没有成功执行"：失败不能成为谎报完成的挡箭牌
    expect(r.executed).toBe(false);
    expect(r.forModel).toContain('今日可用次数已用完');
    expect(r.forModel).toContain('不要说成功');
  });

  it('被幂等复用时如实告知（否则用户会以为跑了两遍、被扣了两次）', async () => {
    const invoke = vi.fn(async () => ({ jobId: 'job-4', status: 'running', reused: true }));
    const { svc } = makeService([PPT], invoke);

    const r = await svc.dispatch(input);

    expect(r.forModel).toContain('没有重复消耗');
  });

  it('助手发起的调用留一条可追溯日志（区分"用户自己点的"与"助手代建的"）', async () => {
    const invoke = vi.fn(async () => ({ jobId: 'job-5', status: 'queued' }));
    const { svc, logger } = makeService([PPT], invoke);

    await svc.dispatch(input);

    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(String(logger.log.mock.calls[0][0])).toContain('generate_ppt');
  });

  it('参数包在 params 里或平铺在顶层都能解析（模型的两种写法都见过）', async () => {
    const invoke = vi.fn(async () => ({ jobId: 'job-6', status: 'queued' }));
    const { svc } = makeService([PPT], invoke);

    await svc.dispatch({ ...input, rawArgs: '{"params":{"topic":"包起来的"}}' });

    const dto = (invoke.mock.calls[0] as unknown as [unknown, unknown, { params: Record<string, unknown> }])[2];
    expect(dto.params.topic).toBe('包起来的');
  });
});
