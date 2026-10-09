import { describe, expect, it, vi } from 'vitest';

import { AI_CAPABILITY_CATALOG } from '../ai-capability.catalog';
import { OsCapabilityRegistry } from '../os-capability.registry';

/**
 * AI 能力注册表（对账层）
 *
 * 这一层是整条机制里**最容易被绕过、也最值得测**的地方：
 * 它决定了"助手以为自己能做什么"。曾经的失败形态是提示词里手写了一份能力清单，
 * 那份清单与真实可运行状态漂移后**没有任何东西会报错** ——
 * 助手会一本正经地把一个跑不通的功能推荐给用户。
 *
 * 所以这里的断言全部围绕"漂移会不会被拦下"：
 *   · 目录里有、但工具表没入库 / 没上线 / 执行器没接 → 必须被丢掉；
 *   · 丢失必须有原因（否则只能靠翻日志）；
 *   · 内部能力必须带上自己的 params（没有就算配置缺失）。
 */

/** 造一条工具表记录 */
function row(name: string, over: Record<string, unknown> = {}) {
  return {
    name,
    displayName: `工具 ${name}`,
    status: 'active',
    price: 1,
    sync: true,
    requiresCopyrightAck: false,
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', title: '主题' } },
      required: ['topic'],
    },
    ...over,
  };
}

/** 目录里所有 `source: 'tool'` 的能力名（用例据此造全量工具表记录） */
const TOOL_CAPS = AI_CAPABILITY_CATALOG.filter((c) => c.source === 'tool').map((c) => c.toolName);

/**
 * 目录里的**内部能力**（`source: 'internal'`）—— 不进工具箱、不查工具表状态，
 * 由助手的 tool calling 进程内直调（`os-campus-tool.ts` / `os-knowledge-tool.ts`）。
 *
 * ⚠️ 这里刻意用目录推导而不是写死名字：写死过一次（只写了 `search_knowledge`），
 * 后来 campus 组又接了 2 个内部能力，**没有任何东西会报错** —— 只有跑全量单测时
 * 以"expected 30, got 32"的形式暴露，而这条断言的本意只是"齐备时一个都不许丢"。
 */
const INTERNAL_CAPS = AI_CAPABILITY_CATALOG.filter((c) => c.source === 'internal').map((c) => c.toolName);

function makeRegistry(overrides: Record<string, Record<string, unknown>> = {}, unsupported: string[] = []) {
  const rows = TOOL_CAPS.filter((n) => overrides[n] !== null).map((n) => row(n, overrides[n] ?? {}));
  const prisma = { tool: { findMany: vi.fn(async () => rows) } };
  const executor = { supports: vi.fn((n: string) => !unsupported.includes(n)) };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    registry: new OsCapabilityRegistry(prisma as never, executor as never, logger as never),
    prisma,
    logger,
  };
}

describe('OsCapabilityRegistry — 与真实可运行状态对账', () => {
  it('全部齐备时：目录里的工具能力 + 内部能力都可用', async () => {
    const { registry } = makeRegistry();
    const { available, dropped } = await registry.resolve();

    // 防这条用例退化成"空对空"：内部能力分支必须真的有东西在测
    expect(INTERNAL_CAPS.length).toBeGreaterThan(0);
    expect(dropped).toEqual([]);
    expect(available.map((c) => c.toolName).sort()).toEqual([...TOOL_CAPS, ...INTERNAL_CAPS].sort());
  });

  it('⭐ 工具没入库 → 丢掉并给出原因（不能只是"静默少一个能力"）', async () => {
    const { registry } = makeRegistry({ generate_ppt: null });
    const { available, dropped } = await registry.resolve();

    expect(available.some((c) => c.toolName === 'generate_ppt')).toBe(false);
    expect(dropped).toContainEqual({
      toolName: 'generate_ppt',
      reason: '工具表里没有这条记录（可能尚未入库或名字写错）',
    });
  });

  it('⭐ 状态不是 active → 丢掉（界面上写"即将上线"，助手也不能调）', async () => {
    const { registry } = makeRegistry({ generate_ppt: { status: 'planned' } });
    const { available, dropped } = await registry.resolve();

    expect(available.some((c) => c.toolName === 'generate_ppt')).toBe(false);
    expect(dropped.find((d) => d.toolName === 'generate_ppt')?.reason).toContain('尚未上线');
  });

  it('⭐ 标了 active 但执行器没接 → 丢掉（这就是"18 个 active 里 9 个跑不通"那类漂移）', async () => {
    const { registry } = makeRegistry({}, ['generate_ppt']);
    const { available, dropped } = await registry.resolve();

    expect(available.some((c) => c.toolName === 'generate_ppt')).toBe(false);
    expect(dropped.find((d) => d.toolName === 'generate_ppt')?.reason).toContain('执行器未接入');
  });

  it('⭐ 需要版权声明的能力不暴露给助手（不能代用户勾选合规声明）', async () => {
    const { registry } = makeRegistry({ generate_ppt: { requiresCopyrightAck: true } });
    const { available, dropped } = await registry.resolve();

    expect(available.some((c) => c.toolName === 'generate_ppt')).toBe(false);
    expect(dropped.find((d) => d.toolName === 'generate_ppt')?.reason).toContain('版权声明');
  });

  it('有丢弃项时必须写日志（否则线上只是"AI 变笨了"）', async () => {
    const { registry, logger } = makeRegistry({ generate_ppt: { status: 'planned' } });
    await registry.resolve();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain('generate_ppt');
  });

  it('内部能力带上自己的 params 当 inputSchema；缺 params 视为配置缺失', async () => {
    const { registry } = makeRegistry();
    const { available } = await registry.resolve();
    const knowledge = available.find((c) => c.toolName === 'search_knowledge');

    expect(knowledge?.price).toBe(0);
    expect(knowledge?.sync).toBe(true);
    expect((knowledge?.inputSchema as { required: string[] }).required).toEqual(['query']);
  });

  it('60 秒内复用对账结果（不每条消息都查一次库）', async () => {
    const { registry, prisma } = makeRegistry();
    await registry.resolve();
    await registry.resolve();

    expect(prisma.tool.findMany).toHaveBeenCalledTimes(1);

    registry.invalidate();
    await registry.resolve();
    expect(prisma.tool.findMany).toHaveBeenCalledTimes(2);
  });

  it('require() 对不可用能力抛错（dispatch 的第二道门，防模型猜名字）', async () => {
    const { registry } = makeRegistry({ generate_ppt: { status: 'planned' } });

    await expect(registry.require('generate_ppt')).rejects.toThrow(/当前不可用/);
    await expect(registry.require('不存在的工具')).rejects.toThrow(/未在 AI 能力目录里注册/);
  });
});

describe('OsCapabilityRegistry — 给模型的 spec', () => {
  it('⭐ 工具能力的参数剥掉表单专用键（title/enumLabels/x-widget 不能进模型请求）', async () => {
    const { registry } = makeRegistry();
    const specs = await registry.specs();
    const ppt = specs.find((s) => s.name === 'generate_ppt');

    const topic = (ppt?.parameters as { properties: Record<string, unknown> }).properties.topic as
      | Record<string, unknown>
      | undefined;
    expect(topic).not.toHaveProperty('title');
    // title 降级成了 description，模型仍能看懂字段含义
    expect(topic?.description).toBe('主题');
  });

  it('描述里带场景与文件要求（模型据此判断该不该调）', async () => {
    const { registry } = makeRegistry();
    const specs = await registry.specs();

    expect(specs.find((s) => s.name === 'generate_ppt')?.description).toContain('PPT');
    // 需要文件的能力必须写明"没文件不要调用"
    expect(specs.find((s) => s.name === 'remove_background')?.description).toContain('不要调用');
    // 内部能力用自己声明的 params（不经过 DB schema 转换）
    expect(specs.find((s) => s.name === 'search_knowledge')?.parameters).toMatchObject({
      required: ['query'],
    });
  });

  it('promptLines 给出一行一个能力（提示词就这样拼出来，不再手写）', async () => {
    const { registry } = makeRegistry();
    const lines = await registry.promptLines();

    expect(lines).toHaveLength(TOOL_CAPS.length + INTERNAL_CAPS.length);
    expect(lines.every((l) => l.startsWith('- '))).toBe(true);
    expect(lines.some((l) => l.includes('需用户先上传图片'))).toBe(true);
  });
});
