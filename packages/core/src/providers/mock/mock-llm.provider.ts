import type { LlmCallOptions, LlmMessage, LlmProvider, LlmResponse } from '../types';

/** 演示计划数据表：AI 节点 [id, 名称, agent, tool, 依赖] */
const DEMO_AI_NODES: [string, string, string, string, string[]][] = [
  ['n1', '活动方案', 'event_planner', 'generate_document', []],
  ['n2', '预算表', 'event_planner', 'generate_document', ['n1']],
  ['n3', '宣传文案', 'copywriter', 'generate_document', ['n1']],
  ['n4', '海报设计', 'image_design', 'generate_image_prompt', ['n3']],
  ['n5', '报名页面', 'event_planner', 'generate_document', ['n3']],
];

/** 演示计划数据表：人力节点 [id, 名称, 技能, 预算（元）] */
const DEMO_HUMAN_NODES: [string, string, string[], number][] = [
  ['n6', '摄影摄像', ['摄影', '摄像'], 300],
  ['n7', '现场主持', ['主持'], 500],
  ['n8', '志愿者×5', ['志愿者'], 0],
];

const aiNode = ([id, name, agent, tool, depends]: [string, string, string, string, string[]]) => ({
  id,
  name,
  type: 'ai',
  agent,
  tool,
  depends,
});
const humanNode = ([id, name, skill, budget]: [string, string, string[], number]) => ({
  id,
  name,
  type: 'human',
  skill,
  budget,
  depends: ['n1'],
});

/** 三阶段 8 节点：策划 → 宣传 → 现场执行（人力） */
const DEMO_PLAN_STAGES = [
  { name: '策划', nodes: DEMO_AI_NODES.slice(0, 2).map(aiNode) },
  { name: '宣传', nodes: DEMO_AI_NODES.slice(2).map(aiNode) },
  { name: '现场执行', nodes: DEMO_HUMAN_NODES.map(humanNode) },
];

/**
 * Mock LLM（红线 10：Mock 必须显式可辨）
 * 行为：按关键词回放预置结果，保证 Demo 与单测在无 API Key 时也能跑通。
 * 真实实现见 apps/api/src/providers/llm/openai-compatible.provider.ts
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock-llm';

  async chat(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmResponse> {
    const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

    // 意图识别场景：返回结构化 JSON
    if (options?.tier === 'intent') {
      const content = JSON.stringify({
        intent: this.guessIntent(last),
        confidence: 0.92,
        entities: {},
        needsClarification: false,
        questions: [],
        isComposite: /活动|策划|全部安排/.test(last),
        subtasks: [],
      });
      return {
        content,
        model: 'mock',
        usage: { promptTokens: 20, completionTokens: 40, totalTokens: 60 },
      };
    }

    // 规划场景：返回一份可执行的 8 节点计划
    if (options?.tier === 'plan') {
      return {
        content: JSON.stringify(this.buildDemoPlan(last)),
        model: 'mock',
        usage: { promptTokens: 60, completionTokens: 300, totalTokens: 360 },
      };
    }

    // 生成场景：返回可读的示例内容
    return {
      content: `【演示模式】已根据「${last.slice(0, 40)}」生成示例内容。\n\n说明：当前未配置 LLM_API_KEY，本内容由 MockProvider 产生。`,
      model: 'mock',
      usage: { promptTokens: 30, completionTokens: 50, totalTokens: 80 },
    };
  }

  async structured<T>(
    messages: LlmMessage[],
    _schema: unknown,
    options?: LlmCallOptions,
  ): Promise<T> {
    const res = await this.chat(messages, options);
    return JSON.parse(res.content) as T;
  }

  private guessIntent(text: string): string {
    if (/\.(mov|avi|mkv).*(转|换|mp4)/i.test(text)) return 'file_process';
    if (/压(缩)?到\s*\d+\s*(mb|兆)/i.test(text)) return 'file_process';
    if (/(去|分离).*(人声|伴奏)/.test(text)) return 'media_ai';
    if (/(ppt|幻灯片|演示)/i.test(text)) return 'ai_generate';
    if (/(活动|策划)/.test(text)) return 'campus_service';
    if (/(找|请).*(同学|服务)/.test(text)) return 'campus_service';
    return 'knowledge';
  }

  /** 演示用：活动策划的 8 节点计划（5 个 AI 节点 + 3 个人力节点，见 L2 验收标准） */
  private buildDemoPlan(goal: string) {
    // normalizePlan 只认**扁平 nodes + dependsOn**（os-planner.ts）；
    // 旧形状 {stages:[{nodes}]} + depends 会让 Mock 档的 /os/plan 恒 degraded，
    // 演示模式因此永远产生不了 runId。这里按契约展平，stages 分组交给读模型派生。
    const nodes = DEMO_PLAN_STAGES.flatMap((stage) =>
      stage.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        type: n.type,
        dependsOn: n.depends,
      })),
    );
    return { goal, nodes };
  }
}
