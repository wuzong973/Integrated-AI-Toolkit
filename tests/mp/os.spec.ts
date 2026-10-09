import { describe, expect, it } from 'vitest';

import {
  INTENT_TOOL_MAP,
  buildHelloMessage,
  buildPlanFromNodes,
  buildPlanFromSubtasks,
  cardActionable,
  cardStatusText,
  cardTarget,
  intentFallbackText,
  localIntent,
  toCardView,
} from '../../apps/mp/utils/os';
/**
 * 青智 OS 的共享纯逻辑（小程序侧）
 *
 * 重点：
 *   ① 计划卡**不伪造"已完成"** —— 这是曾经的真实问题（写死的演示节点标着
 *      `succeeded` / "AI 已完成 · 2min"，还带编造的预算）；
 *   ② 意图路由表**只能指向真能跑的工具** —— 曾经指向 `compress_video`
 *      等后来被标为 `planned` 的工具，用户点了只拿到"即将上线"弹窗。
 */
describe('localIntent —— 离线兜底规则', () => {
  it('活动策划 → 复合意图', () => {
    const r = localIntent('我要办一场 200 人的创新创业活动，帮我全部安排');
    expect(r.intent).toBe('campus_service');
    expect(r.isComposite).toBe(true);
  });

  it('文件处理类关键词', () => {
    expect(localIntent('把视频压缩到 50MB').intent).toBe('file_process');
    expect(localIntent('把 .mov 转成 mp4').intent).toBe('file_process');
  });

  it('音视频 AI 处理', () => {
    expect(localIntent('把这首歌的人声和伴奏分开').intent).toBe('media_ai');
  });

  it('PPT → ai_generate', () => {
    expect(localIntent('帮我做一份路演 ppt').intent).toBe('ai_generate');
  });

  it('找人帮忙 → campus_service（非复合）', () => {
    const r = localIntent('我要找一个同学拍毕业照');
    expect(r.intent).toBe('campus_service');
    expect(r.isComposite).toBe(false);
  });

  it('无法归类时落到 knowledge，且置信度低', () => {
    const r = localIntent('今天天气怎么样');
    expect(r.intent).toBe('knowledge');
    expect(r.confidence).toBeLessThan(0.8);
  });
});

describe('buildPlanFromSubtasks —— 不伪造"已完成"', () => {
  const subtasks = [
    { name: '活动方案', type: 'ai' as const },
    { name: '预算表', type: 'ai' as const },
    { name: '摄影摄像', type: 'human' as const },
  ];

  it('⭐ 所有节点都是待执行，done 恒为 0（以前写死"succeeded"是假成功）', () => {
    const plan = buildPlanFromSubtasks(subtasks);
    expect(plan.done).toBe(0);
    expect(plan.percent).toBe(0);
    expect(plan.nodes.every((n) => n.status === 'pending')).toBe(true);
    expect(plan.nodes.some((n) => n.state === 'done' || n.state === 'run')).toBe(false);
  });

  it('节点名来自模型输出，不夹带任何编造内容', () => {
    const plan = buildPlanFromSubtasks(subtasks);
    expect(plan.nodes.map((n) => n.name)).toEqual(['活动方案', '预算表', '摄影摄像']);
    // 预算以前是写死的（30000/50000），现在完全不该出现
    expect(plan.nodes.every((n) => n.budget === undefined)).toBe(true);
  });

  it('统计需真人的节点数，供 HITL 提示使用', () => {
    const plan = buildPlanFromSubtasks(subtasks);
    expect(plan.total).toBe(3);
    expect(plan.needHumanCount).toBe(1);
    expect(plan.nodes[2].type).toBe('human');
    expect(plan.nodes[2].state).toBe('human');
  });

  it('未持久化时 runId 为空串（不编造一个假 id 让"看板"链接跳空页）', () => {
    expect(buildPlanFromSubtasks(subtasks).runId).toBe('');
  });

  it('空输入返回空计划而不是崩溃', () => {
    const plan = buildPlanFromSubtasks([]);
    expect(plan.total).toBe(0);
    expect(plan.nodes).toEqual([]);
  });

  it('⭐ 标记为 degraded（它是 planner 失败后的退路，界面要如实说明"未含依赖"）', () => {
    expect(buildPlanFromSubtasks(subtasks).degraded).toBe(true);
  });
});

/**
 * 服务端 planner（`POST /os/plan`，`plan` 档）产出的计划卡。
 *
 * 与 `buildPlanFromSubtasks` 的差别只有一个但很关键：**它有依赖关系**。
 * 界面要能把这个差别如实呈现出来（节点说明里带"依赖 N 项"），
 * 否则用户看不出"这次是 AI 真拆解过"还是"只是排了个顺序"。
 */
describe('buildPlanFromNodes —— 带依赖的 DAG', () => {
  const nodes = [
    { id: 'n1', name: '确认方案', type: 'hitl' as const, dependsOn: [] },
    { id: 'n2', name: '写策划书', type: 'ai' as const, dependsOn: ['n1'] },
    { id: 'n3', name: '找摄影', type: 'human' as const, dependsOn: ['n1', 'n2'] },
    { id: 'n4', name: '场地报备', type: 'external' as const, dependsOn: [] },
  ];

  it('⭐ 依赖数量写进节点说明（这是它和子任务清单唯一的区别）', () => {
    const plan = buildPlanFromNodes(nodes);
    expect(plan.nodes[0].detail).toBe('需你确认后继续');
    expect(plan.nodes[1].detail).toBe('待执行 · 依赖 1 项');
    expect(plan.nodes[2].detail).toBe('需真人完成 · 待发布 · 依赖 2 项');
    expect(plan.nodes[3].detail).toBe('需第三方办理');
  });

  it('⭐ 四种节点类型都有中文说明与图标，不会出现"没文字没图标"的空壳', () => {
    const plan = buildPlanFromNodes(nodes);
    expect(plan.nodes.map((n) => n.type)).toEqual(['hitl', 'ai', 'human', 'external']);
    expect(plan.nodes.every((n) => n.detail.length > 0 && n.icon.startsWith('qz-i-'))).toBe(true);
  });

  it('只有 human 节点走 human 视觉态（其余都还是待执行）', () => {
    const plan = buildPlanFromNodes(nodes);
    expect(plan.nodes.map((n) => n.state)).toEqual(['wait', 'wait', 'human', 'wait']);
  });

  it('⭐ 仍然不伪造"已完成"：done / percent 恒为 0', () => {
    const plan = buildPlanFromNodes(nodes);
    expect(plan.done).toBe(0);
    expect(plan.percent).toBe(0);
    expect(plan.nodes.every((n) => n.status === 'pending')).toBe(true);
  });

  it('需真人节点数只算 human（hitl / external 不算，它们不是"去驿站发布"）', () => {
    expect(buildPlanFromNodes(nodes).needHumanCount).toBe(1);
  });

  it('⭐ degraded 为 false（这条路径就是"规划成功"）', () => {
    expect(buildPlanFromNodes(nodes).degraded).toBe(false);
  });

  it('空节点数组返回空计划', () => {
    const plan = buildPlanFromNodes([]);
    expect(plan.total).toBe(0);
    expect(plan.nodes).toEqual([]);
  });
});

describe('intentFallbackText —— 兜底文案要诚实', () => {
  /**
   * ⚠️ 这条用例的内容被改过，因为它原来钉的是一个**已经过期的说法**。
   *
   * 原文案是"这类文件 / 音视频处理能力还在开发中"——在写它的当时是对的
   *（视频压缩、人声分离都还是 `planned`）。但 2026-09-19 那批工具转 active 之后，
   * 这句话就变成了谎话：明明能用，助手却告诉用户在开发中。
   * 这正是本项目反复强调的"展示与行为不一致"，而且它**不会报错**。
   *
   * 现在钉的是新的事实：这些工具都上线了，只是**需要先上传文件**。
   */
  it('⭐ 文件/音视频类必须如实说是"需要先上传文件"，而不是"还在开发中"', () => {
    const text = intentFallbackText({
      intent: 'file_process',
      confidence: 0.9,
      isComposite: false,
    });
    expect(text).not.toContain('开发中');
    expect(text).toContain('上传文件');
  });

  it('信息不足时优先追问，而不是硬猜', () => {
    const text = intentFallbackText({
      intent: 'knowledge',
      confidence: 0.4,
      isComposite: false,
      needsClarification: true,
      questions: ['要办几个人？', '预算多少？', '第三个不该出现'],
    });
    expect(text).toContain('要办几个人？');
    expect(text).toContain('预算多少？');
    expect(text).not.toContain('第三个不该出现');
  });

  it('已上线能力给出正向引导', () => {
    const text = intentFallbackText({ intent: 'ai_generate', confidence: 0.9, isComposite: false });
    expect(text).toContain('生成');
  });
});

describe('buildHelloMessage —— 开场白不能假装后端在回答', () => {
  it('后端就绪：介绍能做什么，不提"演示模式"', () => {
    const msg = buildHelloMessage(true);
    expect(msg.role).toBe('assistant');
    expect(msg.kind).toBe('text');
    expect(msg.content).toContain('拆解任务');
    expect(msg.content).not.toContain('演示模式');
  });

  it('⭐ 后端不可用：必须如实说是"演示模式"（红线 9）', () => {
    const msg = buildHelloMessage(false);
    expect(msg.content).toContain('演示模式');
    expect(msg.content).toContain('后端未连接');
  });
});

describe('INTENT_TOOL_MAP —— 只能指向真能跑的工具', () => {
  /** 与 scripts/dev/check-tool-status.mjs 的判定保持一致（执行器已注册且 Provider 已实现） */
  const RUNNABLE = new Set([
    'generate_outline',
    'generate_ppt',
    'summarize_text',
    'generate_image_prompt',
    'compress_image',
    'convert_image',
    'enhance_image',
    'ocr_image',
    'speech_to_text',
  ]);
  /** 不走工具执行页、由页面 onActionTap 另行处理的特例 */
  const SPECIAL = new Set(['create_task', 'toolbox']);

  it('⭐ 每个 toolName 要么能跑，要么是登记过的特例', () => {
    for (const [intent, action] of Object.entries(INTENT_TOOL_MAP)) {
      const ok = RUNNABLE.has(action.toolName) || SPECIAL.has(action.toolName);
      expect(ok, `意图 ${intent} 指向了跑不通的 ${action.toolName}`).toBe(true);
    }
  });

  it('已上线的 AI 生成类意图挂着按钮', () => {
    expect(INTENT_TOOL_MAP.ai_generate?.toolName).toBe('generate_ppt');
  });

  /**
   * 文件处理 / 音视频意图 → 工具箱（而不是某一个具体工具）。
   *
   * 这两类意图下有多个已上线工具（图片压缩、抠图、视频压缩、语音转文字…），
   * 静态表挑不出"唯一正确的那一个"；硬挑一个反而会把用户引到他不想要的那个。
   * 曾经这里**故意不配按钮**，理由是"当时的工具都还没上线"——
   * 那些工具转 active 之后这条注释就成了过期的借口，所以改成给工具箱入口。
   */
  it('多工具意图指向工具箱（让用户自己选，而不是替他猜一个）', () => {
    expect(INTENT_TOOL_MAP.file_process?.toolName).toBe('toolbox');
    expect(INTENT_TOOL_MAP.media_ai?.toolName).toBe('toolbox');
  });
});

/**
 * AI 能力结果卡（纯逻辑）
 *
 * 这几条全部围绕**不许把"还没做"说成"已完成"**：
 * 结果卡的两种形态一旦渲染错，用户会以为文件已经在了 ——
 * 这是本项目反复强调的"假成功"（红线 9），而且它**不会报错**。
 */
describe('OsToolCard —— 结果卡渲染', () => {
  const base = {
    toolName: 'generate_ppt',
    title: 'AI PPT 生成',
    summary: '演示文稿已生成',
    params: [{ label: '主题', value: '创青春路演' }],
  };

  it('⭐ 只有 succeeded 才算"已完成"（queued / running 一律"处理中"）', () => {
    expect(cardStatusText({ ...base, kind: 'result', status: 'succeeded' })).toBe('已完成');
    expect(cardStatusText({ ...base, kind: 'result', status: 'queued' })).toBe('处理中');
    expect(cardStatusText({ ...base, kind: 'result', status: 'running' })).toBe('处理中');
    expect(cardStatusText({ ...base, kind: 'result', status: 'failed' })).toBe('执行失败');
  });

  it('⭐ 状态缺失时按"处理中"处理（宁可保守，也不谎报完成）', () => {
    expect(cardStatusText({ ...base, kind: 'result' })).toBe('处理中');
  });

  it('引导卡的状态与完成态明显不同', () => {
    expect(cardStatusText({ ...base, kind: 'guide' })).toBe('需要上传文件');
  });

  it('⭐ 结果卡去结果页（用 jobId），引导卡去执行页（用后端拼好的 route）', () => {
    expect(cardTarget({ ...base, kind: 'result', jobId: 'job-1' })).toBe(
      '/pkg-toolbox/result/index?jobId=job-1',
    );
    expect(
      cardTarget({
        ...base,
        kind: 'guide',
        route: '/pkg-toolbox/run/index?toolName=remove_background',
      }),
    ).toBe('/pkg-toolbox/run/index?toolName=remove_background');
  });

  it('⭐ 没有去处就不跳转（避免"点了没反应"）', () => {
    expect(cardTarget({ ...base, kind: 'result' })).toBeNull();
    expect(cardTarget({ ...base, kind: 'guide' })).toBeNull();
    expect(cardActionable({ ...base, kind: 'result' })).toBe(false);
    expect(cardActionable({ ...base, kind: 'result', jobId: 'x' })).toBe(true);
  });

  it('jobId 里的特殊字符会被转义（否则会把路由参数截断）', () => {
    expect(cardTarget({ ...base, kind: 'result', jobId: 'a b&c' })).toBe(
      '/pkg-toolbox/result/index?jobId=a%20b%26c',
    );
  });

  it('toCardView 预先算好模板要用的三个字段（WXML 里不能调函数）', () => {
    const view = toCardView({
      ...base,
      kind: 'result',
      status: 'queued',
      jobId: 'job-2',
      params: [
        { label: '主题', value: '路演' },
        { label: '页数', value: '20' },
      ],
    });
    expect(view.statusText).toBe('处理中');
    expect(view.actionable).toBe(true);
    expect(view.actionText).toBe('查看结果');
    expect(view.icon).toBe('qz-i-sparkle');
    expect(view.paramText).toBe('主题：路演 · 页数：20');
  });

  it('params 缺失也不崩（历史数据可能没这个字段）', () => {
    const view = toCardView({
      toolName: 'x',
      title: 'X',
      summary: 's',
      kind: 'result',
      params: undefined as never,
    });
    expect(view.paramText).toBe('');
  });

  /**
   * `files` 卡：「本轮没执行，但东西在你名下」。
   *
   * 它是假成功净化的配套 —— 模型把历史里上一轮的"已经为您生成…"当成既成事实、
   * 不再调用工具时，光补一句"本轮没执行"只给了坏消息，
   * 还得有一条路让用户找到**确实存在**的那份文件。
   *
   * ⚠️ 它绝不能被渲染成"已完成"：徽标写「往期产物」、说明写「这一轮没有新生成」，
   * 否则用户会把下面这张卡当成刚刚生成的东西 —— 那就是另一种假成功。
   */
  describe('files 卡（往期产物入口）', () => {
    const filesCard = {
      toolName: '',
      title: '我的文件',
      summary: '你名下有 5 个文件',
      params: [],
      kind: 'files' as const,
      route: '/pkg-toolbox/files/index',
      note: '上面这一轮没有新生成文件',
    };

    it('⭐ 徽标是「往期产物」而不是「已完成」', () => {
      expect(cardStatusText(filesCard)).toBe('往期产物');
    });

    it('⭐ 点它进「我的文件」（用后端给的 route）', () => {
      expect(cardTarget(filesCard)).toBe('/pkg-toolbox/files/index');
      expect(cardActionable(filesCard)).toBe(true);
    });

    it('按钮文字与图标都指向"文件"，与底部快捷栏同一个图标', () => {
      const view = toCardView(filesCard);
      expect(view.actionText).toBe('打开我的文件');
      // 与底部快捷栏「我的文件」同一个图标：图标本身就是路标
      expect(view.icon).toBe('qz-i-files');
    });

    it('没有 jobId 也照样能点（否则会出现"点了没反应"）', () => {
      expect(filesCard.jobId).toBeUndefined();
      expect(cardTarget(filesCard)).toBeTruthy();
    });
  });
});
