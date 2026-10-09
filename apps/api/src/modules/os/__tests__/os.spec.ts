import { describe, expect, it, vi } from 'vitest';

import { normalizeIntent } from '../os-intent';
import { OsService } from '../os.service';

/**
 * 青智 OS（AI 助手）
 *
 * 重点验证两件事：
 *   ① **不信任模型输出** —— 意图识别结果必须经过归一化，
 *      表外取值 / 漏字段 / 类型不对都不能穿到界面；
 *   ② 会话归属校验 —— 别人的会话 id 不能读到，也不能往里发消息。
 */
describe('normalizeIntent —— 不信任模型输出', () => {
  it('正常输出原样通过', () => {
    const r = normalizeIntent({
      intent: 'file_process',
      confidence: 0.9,
      isComposite: false,
      entities: { format: 'mp4' },
    });
    expect(r).toEqual({
      intent: 'file_process',
      confidence: 0.9,
      isComposite: false,
      entities: { format: 'mp4' },
      needsClarification: false,
      questions: undefined,
      subtasks: undefined,
    });
  });

  it('⭐ 表外意图归为 knowledge 并压低置信度（不让界面拿到 undefined）', () => {
    const r = normalizeIntent({ intent: 'launch_missile', confidence: 0.99, isComposite: false });
    expect(r.intent).toBe('knowledge');
    expect(r.confidence).toBeLessThanOrEqual(0.3);
  });

  it('confidence 缺失或不是数字时给保守值', () => {
    expect(normalizeIntent({ intent: 'ai_generate' }).confidence).toBe(0.5);
    expect(normalizeIntent({ intent: 'ai_generate', confidence: 'high' }).confidence).toBe(0.5);
  });

  it('confidence 超出 0~1 会被夹紧', () => {
    expect(normalizeIntent({ intent: 'knowledge', confidence: 9 }).confidence).toBe(1);
    expect(normalizeIntent({ intent: 'knowledge', confidence: -3 }).confidence).toBe(0);
  });

  it('isComposite 只有严格 true 才算（字符串 "true" 不算）', () => {
    expect(normalizeIntent({ intent: 'campus_service', isComposite: true }).isComposite).toBe(true);
    expect(normalizeIntent({ intent: 'campus_service', isComposite: 'true' }).isComposite).toBe(
      false,
    );
  });

  it('questions / subtasks 过滤掉非字符串与空串；全空则返回 undefined', () => {
    expect(normalizeIntent({ questions: ['要几个人？', '', 3, null] }).questions).toEqual([
      '要几个人？',
    ]);
    expect(normalizeIntent({ questions: [] }).questions).toBeUndefined();
    expect(normalizeIntent({ subtasks: 'not-array' }).subtasks).toBeUndefined();
  });

  it('entities 不是对象时丢弃（避免把数组/字符串塞给界面）', () => {
    expect(normalizeIntent({ entities: ['a'] }).entities).toBeUndefined();
    expect(normalizeIntent({ entities: 'x' }).entities).toBeUndefined();
  });

  it('subtasks 归一化为 {name,type}，供界面渲染计划卡', () => {
    const r = normalizeIntent({
      subtasks: [
        { name: '活动方案', type: 'ai' },
        { name: '摄影摄像', type: 'human' },
      ],
    });
    expect(r.subtasks).toEqual([
      { name: '活动方案', type: 'ai' },
      { name: '摄影摄像', type: 'human' },
    ]);
  });

  it('⭐ subtasks 的类型只认 "human"，其余一律当 "ai"（保守：不凭空多出"需真人"节点）', () => {
    const r = normalizeIntent({
      subtasks: [{ name: 'A', type: 'HUMAN' }, { name: 'B', type: 'robot' }, { name: 'C' }],
    });
    expect(r.subtasks?.map((s) => s.type)).toEqual(['ai', 'ai', 'ai']);
  });

  it('subtasks 里名字为空 / 非对象的项被丢掉', () => {
    const r = normalizeIntent({ subtasks: [{ name: '  ' }, '字符串', null, { name: '有效' }] });
    expect(r.subtasks).toEqual([{ name: '有效', type: 'ai' }]);
  });

  it('subtasks 不是数组时返回 undefined（不让界面拿到坏数据）', () => {
    expect(normalizeIntent({ subtasks: 'not-array' }).subtasks).toBeUndefined();
    expect(normalizeIntent({ subtasks: [] }).subtasks).toBeUndefined();
  });

  it('完全空的输入也不崩', () => {
    const r = normalizeIntent(undefined);
    expect(r.intent).toBe('knowledge');
    expect(r.isComposite).toBe(false);
  });
});

/** 造一个只实现用到方法的 Prisma 桩 */
function makePrisma() {
  const created = { messages: [] as Record<string, unknown>[] };
  return {
    created,
    osSession: {
      create: vi.fn(async () => ({ id: 'sess-1' })),
      findFirst: vi.fn(async () => ({ id: 'sess-1' })),
      // 带一个可选形参：会话列表的用例要断言**查询条件**（过滤空会话）
      findMany: vi.fn(async (_args?: unknown) => [] as unknown[]),
      update: vi.fn(async () => ({})),
    },
    osMessage: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const row = {
          id: `msg-${created.messages.length + 1}`,
          createdAt: new Date(),
          ...args.data,
        };
        created.messages.push(row);
        return row;
      }),
      findMany: vi.fn(async () => []),
    },
  };
}

const LLM_REPLY = {
  content: '可以用「AI PPT 生成」完成，点下面的按钮开始。',
  model: 'glm-4.7-flash',
  usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
};

/** 日志桩（OsService 的构造契约要求必须传，故统一在这里造） */
function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/**
 * 工具注册表桩。
 *
 * 默认**不注册任何工具**：绝大多数用例关心的是"对话与落库"，
 * 让模型凭空多出可调用的工具只会把用例的意图搅浑。
 * 需要验证工具循环的用例请显式传 `makeToolRegistry()`（见下方）。
 *
 * ⚠️ `specs()` 现在是异步的（能力清单要查库对账），桩必须跟着改成 async ——
 * 返回同步数组会让 `await` 拿到一个数组而不是 Promise，测试照样绿，
 * 但覆盖的是与线上不同的路径（本项目在"多余实参"上已经吃过一次这种亏）。
 */
function makeToolRegistry(specs: unknown[] = [], execute = vi.fn()): unknown {
  return { specs: async () => specs, execute };
}
/**
 * 能力注册表桩。
 *
 * `promptLines()` 是提示词的能力清单来源，给一句占位即可 ——
 * 用例关心的是"清单被拼进了 system 消息"，而不是清单内容本身
 *（清单内容由 `ai-capability.catalog.ts` 的守卫与 `verify-os.mjs` 负责）。
 */
function makeCapabilities(lines: string[] = ['- AI PPT 生成：用户要 PPT 时调用']): unknown {
  return { promptLines: async () => lines, resolve: async () => ({ available: [], dropped: [] }) };
}

/**
 * 内容安全桩（M4-05）。
 *
 * 默认**放行**：绝大多数用例关心的是对话与工具循环，让审核在这里拦一手
 * 会把用例的失败原因指向一个与被测行为无关的地方。
 * 审核自身的语义（fail-closed、reject/review 文案差异）由
 * `moderation/__tests__/moderation.service.spec.ts` 专门覆盖。
 */
function makeModeration(): unknown {
  return { assertText: vi.fn(async () => undefined), assertTexts: vi.fn(async () => undefined) };
}

/**
 * 计划 Run 服务桩（M2-06）。
 *
 * 默认"这个会话没有进行中的计划"、"持久化时原样退回计划"：
 * 对话用例关心的是模型往返与落库顺序，不该被 Run 的逻辑牵连。
 * Run 本身的语义（节点数、状态机、越权、发布关联）由
 * `os-run.service.spec.ts` 专门覆盖，这里只验**接线**：
 * `plan()` 是否把计划交给它、`sendMessage()` 是否把 runId 穿过工具上下文。
 */
function makeRunService(openRunId?: string): unknown {
  return {
    openRunId: vi.fn(async () => openRunId),
    persistPlan: vi.fn(async (_userId: string, _sessionId: string, plan: unknown) => plan),
  };
}

/** 统一构造入口：省得每处都写一串 `as never` */
function makeService(
  prisma: unknown,
  providers: unknown,
  logger = makeLogger(),
  tools: unknown = makeToolRegistry(),
  capabilities: unknown = makeCapabilities(),
  moderation: unknown = makeModeration(),
  runs: unknown = makeRunService(),
): OsService {
  return new OsService(
    prisma as never,
    providers as never,
    logger as never,
    tools as never,
    capabilities as never,
    moderation as never,
    runs as never,
  );
}

/**
 * 工具调用循环（M2-08/M2-09 的最小形态）。
 *
 * 这一组用例存在的意义：工具循环是**唯一一处"模型能触发真实副作用"的地方**，
 * 而它此前的缺失正是交付排查里单列的一条（"真正缺的不是知识库，
 * 而是 OsService 完全没有 tool calling"）。所以三条边界必须钉住：
 *   ① 工具真的被执行、结果真的回填；
 *   ② 回填的消息带上 toolCallId、assistant 消息带上 toolCalls
 *      —— 少任何一个，模型都会**重复发起同一个调用**（协议要求，不是可选）；
 *   ③ 轮次用尽时必须兜底再要一次答复，**绝不返回空消息**。
 */
const SEARCH_TOOL = {
  name: 'search_knowledge',
  description: '检索校园知识库',
  parameters: { type: 'object', properties: {} },
};

describe('OsService 工具调用循环', () => {
  it('⭐ 模型发起 search_knowledge：工具被执行，结果以 role:tool 回填后再问一次', async () => {
    const prisma = makePrisma();
    const execute = vi.fn(async () => ({
      forModel: '针对「补办学生证」检索到 1 段材料',
      executed: true,
    }));
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          { id: 'call-1', name: 'search_knowledge', arguments: '{"query":"补办学生证"}' },
        ],
      })
      .mockResolvedValueOnce({ content: '需要带 1 张照片和一卡通 [1]' });

    const svc = makeService(
      prisma,
      { llm: { chat } },
      makeLogger(),
      makeToolRegistry([SEARCH_TOOL], execute),
    );
    const r = await svc.sendMessage('u1', 'sess-1', { content: '补办学生证要带什么' });

    // 第一个实参是"模型请求了什么"，第二个是会话上下文（用户、会话、已上传文件、未终态的 Run）
    expect(execute).toHaveBeenCalledWith(
      { name: 'search_knowledge', args: '{"query":"补办学生证"}', callToken: '0-0' },
      { userId: 'u1', sessionId: 'sess-1', fileIds: [], runId: undefined },
    );
    expect(chat).toHaveBeenCalledTimes(2);

    // 第二次调用的上下文里必须能看到"模型请求过什么"与"工具回了什么"
    const second = chat.mock.calls[1][0] as {
      role: string;
      toolCallId?: string;
      toolCalls?: unknown[];
    }[];
    expect(second.find((m) => m.role === 'assistant')?.toolCalls).toHaveLength(1);
    expect(second.find((m) => m.role === 'tool')?.toolCallId).toBe('call-1');

    // 最终落到库里的仍是模型答复（工具原文不进数据库）
    expect(r.reply.content).toBe('需要带 1 张照片和一卡通 [1]');
    expect(prisma.created.messages).toHaveLength(2);
  });

  it('⭐ 轮次用尽：兜底再要一次**不带工具**的答复，不返回空消息', async () => {
    const prisma = makePrisma();
    const stuck = {
      content: '',
      toolCalls: [{ id: 'call-x', name: 'search_knowledge', arguments: '{}' }],
    };
    const chat = vi
      .fn()
      .mockResolvedValueOnce(stuck)
      .mockResolvedValueOnce(stuck)
      .mockResolvedValueOnce({ content: '我先按已有信息回答。' });

    const svc = makeService(
      prisma,
      { llm: { chat } },
      makeLogger(),
      makeToolRegistry(
        [SEARCH_TOOL],
        vi.fn(async () => ({ forModel: '结果', executed: true })),
      ),
    );
    const r = await svc.sendMessage('u1', 'sess-1', { content: '查一下' });

    // 2 轮（MAX_TOOL_ROUNDS）+ 1 次兜底
    expect(chat).toHaveBeenCalledTimes(3);
    // 兜底那一次不能再带工具，否则模型又会发起调用、又拿不到回答 → 空消息
    const lastOptions = chat.mock.calls[2][1] as { tools?: unknown[] };
    expect(lastOptions.tools).toBeUndefined();
    expect(r.reply.content).toBe('我先按已有信息回答。');
  });
});

/**
 * AI 能力调用与结果整合
 *
 * 这组用例盯的是"用户到底能不能拿到东西"：
 * 助手说"已经生成好了"之后，产物入口**必须**随之回到界面。
 * 只落库不返回 = 用户被告知完成了却找不到文件；
 * 只返回不落库 = 刷新/换设备后卡片消失，会话记录与当时看到的不一致。
 */
const PPT_TOOL = {
  name: 'generate_ppt',
  description: '生成 PPT',
  parameters: { type: 'object', properties: {} },
};

const RESULT_CARD = {
  kind: 'result' as const,
  toolName: 'generate_ppt',
  title: 'AI PPT 生成',
  summary: '演示文稿已生成',
  params: [{ label: '主题', value: '创青春路演' }],
  jobId: 'job-1',
  status: 'queued',
};

describe('OsService —— AI 能力调用与结果整合', () => {
  it('⭐ 工具产出结果卡：落库到 cards 并随回复返回（否则用户拿不到产物入口）', async () => {
    const prisma = makePrisma();
    const execute = vi.fn(async () => ({
      forModel: '已提交作业 job-1',
      executed: true,
      card: RESULT_CARD,
    }));
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'c1', name: 'generate_ppt', arguments: '{"topic":"创青春路演"}' }],
      })
      .mockResolvedValueOnce({ content: '已经做好了，点下面的卡片查看。' });

    const svc = makeService(
      prisma,
      { llm: { chat } },
      makeLogger(),
      makeToolRegistry([PPT_TOOL], execute),
    );
    const r = await svc.sendMessage('u1', 'sess-1', { content: '帮我做一份创青春路演 PPT' });

    // 返回给客户端
    expect(r.reply.cards).toEqual([RESULT_CARD]);
    // 有卡的消息用 `card` kind —— 小程序据此换组件渲染，与纯文本气泡不同
    expect(r.reply.kind).toBe('card');
    // 同时落库（刷新会话时还在）
    const stored = prisma.created.messages[prisma.created.messages.length - 1];
    expect(stored.cards).toEqual([RESULT_CARD]);
    expect(r.reply.content).toBe('已经做好了，点下面的卡片查看。');
  });

  it('没有调用能力时不产生卡片（不伪造产物入口）', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma, { llm: { chat: vi.fn(async () => LLM_REPLY) } });

    const r = await svc.sendMessage('u1', 'sess-1', { content: '今天天气怎么样' });

    expect(r.reply.cards).toBeUndefined();
    expect(r.reply.kind).toBe('text');
  });

  it('⭐ 系统提示词的能力清单来自对账结果（写死的清单会随工具箱增删变成谎话）', async () => {
    const prisma = makePrisma();
    const chat = vi.fn(async () => LLM_REPLY);
    const capabilities = makeCapabilities(['- AI PPT 生成：用户要 PPT 时调用它']);
    const svc = makeService(
      prisma,
      { llm: { chat } },
      makeLogger(),
      makeToolRegistry(),
      capabilities,
    );

    await svc.sendMessage('u1', 'sess-1', { content: 'hi' });

    const [messages] = chat.mock.calls[0] as unknown as [{ role: string; content: string }[]];
    const system = messages[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('AI PPT 生成：用户要 PPT 时调用它');
    // 旧提示词里那句"你没有直接操作工具的能力"必须已经删掉 ——
    // 留着会让助手有能力却不使用（用户说"做个 PPT"它却把他推去填表单）
    expect(system.content).not.toContain('你没有直接操作工具的能力');
    expect(system.content).toContain('能自己做的直接做');
  });

  it('⭐ 已在对话里上传的文件会传给工具（"帮我抠图"才能直接执行而不是只引导）', async () => {
    const prisma = makePrisma();
    const execute = vi.fn(async () => ({ forModel: 'ok', executed: true }));
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'c1', name: 'generate_ppt', arguments: '{}' }],
      })
      .mockResolvedValueOnce({ content: '好了' });

    const svc = makeService(
      prisma,
      { llm: { chat } },
      makeLogger(),
      makeToolRegistry([PPT_TOOL], execute),
    );
    await svc.sendMessage('u1', 'sess-1', {
      content: '帮我抠图',
      fileIds: ['file-1', 'file-2'],
    });

    const ctx = (execute.mock.calls[0] as unknown as [unknown, { fileIds: string[] }])[1];
    expect(ctx.fileIds).toEqual(['file-1', 'file-2']);
  });

  /**
   * 假成功时的补救：**补一句说明 + 补一张「我的文件」卡**。
   *
   * 只补说明是不够的：模型之所以说"已经为您生成…"，恰恰因为上一轮真的生成过，
   * 东西很可能就躺在用户名下。只告诉他"本轮没执行"，等于给了坏消息却不给出路。
   */
  describe('假成功的补救（没有执行却声称完成）', () => {
    const LIE = '已经为您生成了一份关于校园二手交易平台的PPT，共12页。点下面的卡片查看详情。';

    /** 带 `fileAsset.count` 的 Prisma 桩（只有这条路径会用到它） */
    function makePrismaWithFiles(fileCount: number) {
      const prisma = makePrisma() as Record<string, unknown>;
      prisma.fileAsset = { count: vi.fn(async () => fileCount) };
      return prisma as ReturnType<typeof makePrisma>;
    }

    it('⭐ 说了完成但没有任何执行 → 补说明，且附上「我的文件」卡', async () => {
      const prisma = makePrismaWithFiles(5);
      const svc = makeService(prisma, { llm: { chat: vi.fn(async () => ({ content: LIE })) } });

      const r = await svc.sendMessage('u1', 'sess-1', { content: '再帮我做一份' });

      expect(r.reply.content).toContain('没有实际执行');
      expect(r.reply.cards).toHaveLength(1);
      expect(r.reply.cards?.[0].kind).toBe('files');
      expect(r.reply.cards?.[0].route).toBe('/pkg-toolbox/files/index');
      expect(r.reply.kind).toBe('card');
      // 落库的卡与返回的一致
      const stored = prisma.created.messages[prisma.created.messages.length - 1];
      expect(stored.cards).toEqual(r.reply.cards);
    });

    it('正常执行过的那一轮：不查文件数、不加卡（净化不介入正常路径）', async () => {
      const prisma = makePrismaWithFiles(5);
      const execute = vi.fn(async () => ({
        forModel: '已提交',
        executed: true,
        card: RESULT_CARD,
      }));
      const chat = vi
        .fn()
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [{ id: 'c1', name: 'generate_ppt', arguments: '{"topic":"X"}' }],
        })
        .mockResolvedValueOnce({ content: '已经为您生成好了，点卡片查看。' });

      const svc = makeService(
        prisma,
        { llm: { chat } },
        makeLogger(),
        makeToolRegistry([PPT_TOOL], execute),
      );
      const r = await svc.sendMessage('u1', 'sess-1', { content: '帮我做个 PPT' });

      expect(r.reply.cards).toEqual([RESULT_CARD]);
      // 多查一次库也是成本，而且会把"本轮真的做了什么"和"往期产物"混在一起
      expect((prisma.fileAsset as { count: unknown }).count).not.toHaveBeenCalled();
    });

    it('⭐ 名下没有文件也照给卡 —— 最需要它的时刻往往正是"文件还没落盘"（异步长任务）', async () => {
      const prisma = makePrismaWithFiles(0);
      const svc = makeService(prisma, { llm: { chat: vi.fn(async () => ({ content: LIE })) } });

      const r = await svc.sendMessage('u1', 'sess-1', { content: '再帮我做一份' });

      expect(r.reply.content).toContain('没有实际执行');
      expect(r.reply.cards?.[0].kind).toBe('files');
      // 但不能谎报数量
      expect(r.reply.cards?.[0].summary).not.toMatch(/\d+ 个文件/);
    });

    it('查文件数失败时不让整轮对话失败（宁可文案保守，也要有回复和卡片）', async () => {
      const prisma = makePrismaWithFiles(0);
      (prisma.fileAsset as { count: unknown }).count = vi.fn(async () => {
        throw new Error('数据库不可用');
      });
      const svc = makeService(prisma, { llm: { chat: vi.fn(async () => ({ content: LIE })) } });

      const r = await svc.sendMessage('u1', 'sess-1', { content: '再帮我做一份' });

      expect(r.reply.content).toContain('没有实际执行');
      expect(r.reply.cards?.[0].kind).toBe('files');
    });
  });
});

describe('OsService', () => {
  it('新建会话返回 id', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma, { llm: {} });
    await expect(svc.createSession('u1', {})).resolves.toEqual({ id: 'sess-1' });
  });

  it('⭐ 发消息：先落用户消息，再调模型，最后落回复', async () => {
    const prisma = makePrisma();
    const chat = vi.fn(async () => LLM_REPLY);
    const svc = makeService(prisma, { llm: { chat } });

    const r = await svc.sendMessage('u1', 'sess-1', { content: '帮我做个 PPT' });

    expect(chat).toHaveBeenCalledTimes(1);
    const [messages, options] = chat.mock.calls[0] as unknown as [unknown[], { tier: string }];
    expect(options.tier).toBe('generate');
    expect((messages[0] as { role: string }).role).toBe('system');

    expect(prisma.created.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(r.reply.content).toBe(LLM_REPLY.content);
    expect(r.messageId).toBe(r.reply.id);
  });

  it('发消息后累加会话的 token 用量（便于后续做额度控制）', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma, { llm: { chat: vi.fn(async () => LLM_REPLY) } });

    await svc.sendMessage('u1', 'sess-1', { content: 'hi' });

    expect(prisma.osSession.update).toHaveBeenCalledWith({
      where: { id: 'sess-1' },
      data: { tokenUsed: { increment: 30 } },
    });
  });

  it('⭐ 会话不属于自己时抛错（读消息与发消息都要拦）', async () => {
    const prisma = makePrisma();
    prisma.osSession.findFirst = vi.fn(async () => null);
    const svc = makeService(prisma, { llm: {} });

    await expect(svc.listMessages('u1', 'others-session')).rejects.toThrow(/会话不存在/);
    await expect(svc.sendMessage('u1', 'others-session', { content: 'hi' })).rejects.toThrow(
      /会话不存在/,
    );
    expect(prisma.osMessage.create).not.toHaveBeenCalled();
  });

  it('⭐ 会话列表只出"聊过"的会话（空壳会话会把历史记录淹掉）', async () => {
    const prisma = makePrisma();
    prisma.osSession.findMany = vi.fn(async (_args?: unknown) => [
      {
        id: 'sess-1',
        title: null,
        status: 'active',
        updatedAt: new Date('2026-09-19T01:00:00.000Z'),
      },
    ]);
    const svc = makeService(prisma, { llm: {} });

    await expect(svc.listSessions('u1')).resolves.toEqual([
      { id: 'sess-1', title: '青智 OS', status: 'active', updatedAt: '2026-09-19T01:00:00.000Z' },
    ]);
    expect(prisma.osSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1', status: 'active', messages: { some: {} } },
        orderBy: { updatedAt: 'desc' },
      }),
    );
  });

  it('意图识别走 intent 档并返回归一化结果', async () => {
    const structured = vi.fn(async () => ({
      intent: 'ai_generate',
      confidence: 0.88,
      isComposite: false,
    }));
    const svc = makeService(makePrisma(), { llm: { structured } });

    const r = await svc.recognizeIntent('帮我做个 PPT');

    expect(r.intent).toBe('ai_generate');
    expect(r.confidence).toBe(0.88);
    const options = (
      structured.mock.calls[0] as unknown as [unknown, unknown, { tier: string }]
    )[2];
    expect(options.tier).toBe('intent');
  });

  it('意图识别返回表外取值时，同样归一化而不是原样抛出', async () => {
    const svc = makeService(makePrisma(), {
      llm: { structured: vi.fn(async () => ({ intent: '???', confidence: 2 })) },
    });

    const r = await svc.recognizeIntent('随便说点什么');
    expect(r.intent).toBe('knowledge');
    expect(r.confidence).toBeLessThanOrEqual(0.3);
  });

  /**
   * 任务规划 —— `.env` 里 `LLM_MODEL_PLAN` 的真实调用点。
   * 在它之前，plan 档配了却没有任何调用方（"配了但无调用点"）。
   */
  describe('plan（plan 档 / 深度思考）', () => {
    const OK_PLAN = {
      goal: '办活动',
      nodes: [
        { id: 'n1', name: '确认方案', type: 'hitl', dependsOn: [] },
        { id: 'n2', name: '找摄影', type: 'human', dependsOn: ['n1'] },
      ],
    };

    it('⭐ 走 plan 档，而不是 generate / intent 档', async () => {
      const structured = vi.fn(async () => OK_PLAN);
      const svc = makeService(makePrisma(), { llm: { structured } });

      const r = await svc.plan('帮我办一场活动');

      expect(r.degraded).toBe(false);
      expect(r.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
      const options = (
        structured.mock.calls[0] as unknown as [unknown, unknown, { tier: string }]
      )[2];
      expect(options.tier).toBe('plan');
    });

    it('⭐ 第一次返回非法 JSON、第二次成功 → 重试生效，拿到真实计划', async () => {
      const structured = vi
        .fn()
        .mockRejectedValueOnce(new Error('AI 输出格式异常'))
        .mockResolvedValueOnce(OK_PLAN);
      const svc = makeService(makePrisma(), { llm: { structured } });

      const r = await svc.plan('帮我办一场活动');

      expect(structured).toHaveBeenCalledTimes(2);
      expect(r.degraded).toBe(false);
      expect(r.nodes).toHaveLength(2);
    });

    it('⭐ 两次都失败 → 降级为空节点（不编造计划），并写下降级日志', async () => {
      const structured = vi.fn(async () => {
        throw new Error('LLM HTTP 429');
      });
      const logger = makeLogger();
      const svc = makeService(makePrisma(), { llm: { structured } }, logger);

      const r = await svc.plan('帮我办一场活动');

      expect(structured).toHaveBeenCalledTimes(2);
      expect(r.degraded).toBe(true);
      expect(r.nodes).toEqual([]);
      expect(r.degradedReason).toBeTruthy();
      // 降级必须留痕：否则线上只看到"计划卡变成了清单"，不知道是模型挂了还是输出不合法
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('模型返回了合法 JSON 但计划有环 → 降级（不重试，重试也改不了结构）', async () => {
      const structured = vi.fn(async () => ({
        nodes: [
          { id: 'n1', name: 'A', type: 'ai', dependsOn: ['n2'] },
          { id: 'n2', name: 'B', type: 'ai', dependsOn: ['n1'] },
        ],
      }));
      const svc = makeService(makePrisma(), { llm: { structured } });

      const r = await svc.plan('目标');

      expect(structured).toHaveBeenCalledTimes(1);
      expect(r.degraded).toBe(true);
      expect(r.nodes).toEqual([]);
    });
  });
});

/**
 * M2-06 的接线（计划落库 + 作业归属）
 *
 * 这里只验**两条线有没有接上**：
 *   ① `plan()` 拿到 owner 时把计划交给 `OsRunService.persistPlan`，
 *      并把回写的 `runId` 原样带回响应（客户端要用它打开看板）；
 *   ② `sendMessage()` 查到本会话未终态的 Run 时，把 runId 穿过工具上下文，
 *      一路进 `tool_job.run_id`。
 * Run 自身的规则（节点数、状态机、越权、发布关联）在 `os-run.service.spec.ts`。
 */
describe('M2-06 接线 —— 规划落库与作业归属', () => {
  const PLAN_RAW = {
    goal: '办活动',
    nodes: [{ id: 'n1', name: '确认方案', type: 'hitl', dependsOn: [] }],
  };

  it('⭐ 带 owner 的规划：计划交给 Run 服务持久化，响应里多出 runId', async () => {
    const persistPlan = vi.fn(async (_u: string, _s: string, plan: unknown) => ({
      ...(plan as Record<string, unknown>),
      runId: 'run-9',
    }));
    const svc = makeService(
      makePrisma(),
      { llm: { structured: vi.fn(async () => PLAN_RAW) } },
      makeLogger(),
      makeToolRegistry(),
      makeCapabilities(),
      makeModeration(),
      { openRunId: vi.fn(async () => undefined), persistPlan },
    );

    const r = await svc.plan('帮我办一场活动', { userId: 'u1', sessionId: 'sess-1' });

    expect(persistPlan).toHaveBeenCalledWith(
      'u1',
      'sess-1',
      expect.objectContaining({ degraded: false }),
    );
    expect(r.runId).toBe('run-9');
    // 计划的原有字段一个都没少（客户端老代码照常工作）
    expect(r.nodes.map((n) => n.id)).toEqual(['n1']);
  });

  it('⭐ 不带 owner（老客户端只发 goal）时一律不落库，响应形状与 M2-05 完全一致', async () => {
    const persistPlan = vi.fn();
    const svc = makeService(
      makePrisma(),
      { llm: { structured: vi.fn(async () => PLAN_RAW) } },
      makeLogger(),
      makeToolRegistry(),
      makeCapabilities(),
      makeModeration(),
      { openRunId: vi.fn(async () => undefined), persistPlan },
    );

    const r = await svc.plan('帮我办一场活动');

    expect(persistPlan).not.toHaveBeenCalled();
    expect(r.runId).toBeUndefined();
  });

  it('会话里有未终态的 Run 时，工具上下文带上 runId（作业才归属得到这个计划）', async () => {
    const prisma = makePrisma();
    const execute = vi.fn(async () => ({ forModel: '已提交作业 job-1', executed: true }));
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'c1', name: 'generate_ppt', arguments: '{"topic":"创青春路演"}' }],
      })
      .mockResolvedValueOnce({ content: '已经做好了，点卡片查看。' });

    const svc = makeService(
      prisma,
      { llm: { chat } },
      makeLogger(),
      makeToolRegistry([PPT_TOOL], execute),
      makeCapabilities(),
      makeModeration(),
      { openRunId: vi.fn(async () => 'run-9'), persistPlan: vi.fn() },
    );
    await svc.sendMessage('u1', 'sess-1', { content: '帮我做个 PPT' });

    const ctx = (execute.mock.calls[0] as unknown as [unknown, { runId?: string }])[1];
    expect(ctx.runId).toBe('run-9');
  });

  it('会话里没有进行中的计划时不污染上下文（runId 为 undefined，作业不带 run_id）', async () => {
    const prisma = makePrisma();
    const execute = vi.fn(async () => ({ forModel: 'ok', executed: true }));
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'c1', name: 'generate_ppt', arguments: '{}' }],
      })
      .mockResolvedValueOnce({ content: '好了' });

    const svc = makeService(
      prisma,
      { llm: { chat } },
      makeLogger(),
      makeToolRegistry([PPT_TOOL], execute),
    );
    await svc.sendMessage('u1', 'sess-1', { content: '帮我抠图' });

    const ctx = (execute.mock.calls[0] as unknown as [unknown, { runId?: string }])[1];
    expect(ctx.runId).toBeUndefined();
  });
});
