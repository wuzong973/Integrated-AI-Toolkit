import { Injectable } from '@nestjs/common';

import { KnowledgeService } from '../knowledge/knowledge.service';

/** 内部能力名（与 `ai-capability.catalog.ts` 的 `toolName` 逐字一致） */
export const SEARCH_KNOWLEDGE = 'search_knowledge';

/**
 * 校园知识库检索 —— 助手唯一的**内部**能力（不进工具箱 UI）
 *
 * ## 为什么它需要被单独实现，而不是走工具执行器
 *
 * 工具箱里的能力都是"输入 → 产出文件"（`.pptx` / `.md` / 处理后的图片），
 * 走的是作业 + 产物那套链路。而知识库检索的产物是**给模型读的材料**，
 * 拿不到执行记录里去看，也不该出现在"我的文件"里。
 * 所以它归内部能力：由助手进程内直接调服务，`resultKind: 'text'`。
 *
 * ## 工具结果为什么必须是"数据"而不是"回答"
 *
 * 返回给模型的是一份**带出处的检索结果**，不是"我查到了 XX"。
 * 模型自己决定怎么用：查不到时它应当如实说"知识库里没有相关材料"，
 * 而这一点靠系统提示词约束（见 `os.service.ts`）而不是在这里写死话术。
 */
@Injectable()
export class KnowledgeTool {
  constructor(private readonly knowledge: KnowledgeService) {}

  /**
   * 执行检索，返回**给模型看的文本结果** + 是否真的检索成功。
   *
   * 失败时返回一句说明而不是抛异常：这是"模型可以自行纠正"的情形
   *（换个关键词再试），把异常抛出去会直接打断整轮对话，
   * 用户看到的是"回答失败"而不是"换个说法再问"。
   *
   * `executed` 用于出口净化判断"这一轮到底有没有真做过事"（见 `os-reply-guard`）：
   * 检索**失败**不算执行过 —— 否则模型可以借一次失败的检索说"我查过了"。
   */
  async run(args: string): Promise<{ forModel: string; executed: boolean }> {
    const query = parseQuery(args);
    if (!query) {
      return {
        forModel: '调用失败：缺少 query 参数。请用问题里的核心名词重新调用。',
        executed: false,
      };
    }

    try {
      const hits = await this.knowledge.search(query);
      return { forModel: formatHits(query, hits), executed: true };
    } catch (e) {
      // 未配向量库 / 检索超时等：如实告诉模型"检索不可用"，
      // 它才有机会说"知识库暂时查不了"，而不是凭记忆编一个校规出来。
      return {
        forModel: `检索失败：${(e as Error)?.message ?? '未知错误'}。请如实告知用户暂时无法查询，不要凭猜测回答。`,
        executed: false,
      };
    }
  }
}

/** 解析模型给的参数。格式不合法不是异常，是"模型需要被纠正" */
function parseQuery(args: string): string {
  try {
    const parsed = JSON.parse(args || '{}') as { query?: unknown };
    return typeof parsed.query === 'string' ? parsed.query.trim() : '';
  } catch {
    return '';
  }
}

/**
 * 把检索结果格式化成给模型读的文本。
 *
 * 编号 + 出处的写法是刻意的：模型可以据此在回答里写出"根据《学生手册》第 3 章"，
 * 用户也能自己去核对。只给正文不给出处，模型就只能给出无法验证的断言。
 */
function formatHits(
  query: string,
  hits: { title: string; source?: string; text: string; score: number }[],
): string {
  if (!hits.length) {
    return `针对「${query}」没有检索到任何材料。请如实告知用户知识库里没有相关内容，不要编造。`;
  }

  const blocks = hits.map((hit, i) => {
    const from = hit.source ? `（出处：${hit.source}）` : '';
    return `[${i + 1}] 《${hit.title}》${from}\n${hit.text}`;
  });

  return [
    `针对「${query}」检索到 ${hits.length} 段材料：`,
    ...blocks,
    '回答时请只使用上面的内容，并在句末标注引用的编号（如「[1]」）。',
  ].join('\n\n');
}
