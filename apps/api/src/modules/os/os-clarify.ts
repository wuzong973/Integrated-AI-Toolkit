/**
 * 澄清机制（Q13）
 *
 * ## 它解决什么
 *
 * 意图识别早就会输出 `needsClarification` 与 `questions`（`os-intent.ts` 的
 * schema 与提示词都写了），但**全仓没有任何消费点** ——
 * 服务端不读、客户端也没读。于是那句"把 needsClarification 设为 true
 * 并给出 1~2 个具体问题"的提示词永远不起作用：模型想问也问不出来，
 * 只能拿默认值硬做一份。
 *
 * 实测形态：用户说"帮我做个 PPT"，助手直接按默认 16 页商务风开做；
 * 用户说"帮我弄一下那个"，它照样产出一份完全不对题的东西。
 * **信息不足时最该做的是问一句，而不是猜**。
 *
 * ## 为什么判定放在服务端
 *
 * 小程序端是 `intent` 与 `send` **并发**发起的（见 `pages/os/index.ts`），
 * 意图回来时正文往往已经在生成 —— 客户端拿到 `needsClarification` 也**来不及拦**。
 * 只有服务端掌握"是否真的执行"，所以判断必须在这里做。
 *
 * ## 为什么不能只看 needsClarification
 *
 * 模型偶尔会在信息其实够用时也置 `true`（保守过头）。若一律照它拦，
 * 用户会频繁被反问、体验变差。所以这里加一道"信息量下限"复核：
 * 短到明显无法执行的才拦，其余交给模型正常回答。
 */
import type { OsIntentResult } from '@qz/core';

import type { AppLogger } from '../../common/logger/logger.service';

/** 触发澄清的最短输入长度：低于此长度且模型也说信息不足，才拦 */
const MIN_ACTIONABLE_CHARS = 8;

export interface ClarifyDecision {
  /** 是否应当先追问、暂不执行 */
  ask: boolean;
  /** 要问的问题（1~2 个）；ask 为 false 时为空数组 */
  questions: string[];
  /** 追问卡片的引导文案 */
  hint: string;
}

/**
 * 判定这次是否应当先澄清。
 *
 * 两个条件**同时满足**才拦：
 *   ① 模型明确说信息不足（`needsClarification === true`）；
 *   ② 用户这句话确实短（低于 `MIN_ACTIONABLE_CHARS`）或**模型给出了具体问题**。
 *
 * ② 的意义是"双重确认"：模型说要澄清、且它真的想得出问题，才值得打断用户。
 * 只说"信息不足"却给不出问题的情况，追问会变成"你想做什么？"这种无效反问。
 */
export function decideClarify(intent: OsIntentResult, userText: string): ClarifyDecision {
  const questions = (intent.questions ?? []).map((q) => q.trim()).filter(Boolean).slice(0, 2);
  const text = userText.trim();

  const modelSaysVague = intent.needsClarification === true;
  const worthAsking = text.length < MIN_ACTIONABLE_CHARS || questions.length > 0;

  if (!modelSaysVague || !worthAsking) return { ask: false, questions: [], hint: '' };

  // 模型想追问但没给出问题：给一个**兜底问题**，而不是空手打断用户。
  // 空列表会让卡片只有一句"能说得更具体吗"，用户反而不知道该补什么。
  const finalQuestions = questions.length
    ? questions
    : ['你想完成的具体任务是什么？（例如「做一份社团招新的 PPT」）'];

  return {
    ask: true,
    questions: finalQuestions,
    hint: '信息还不太够，先确认一下再动手 —— 这样不会做出一份不对题的东西。',
  };
}

/**
 * 澄清追问的回复文案。
 *
 * 直接把问题列出来，而不是说一句"请补充信息"：用户需要知道**补什么**。
 */
export function clarifyReply(decision: ClarifyDecision): string {
  if (!decision.ask) return '';
  const list = decision.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
  return `为了不做出不对题的结果，我先确认几个信息：\n${list}\n\n回复后我就直接开始做。`;
}
/** 澄清判定的等待上限（毫秒）。实测意图识别 3.5~6.7s；不能吃掉正文的等待预算 */
export const CLARIFY_TIMEOUT_MS = 6000;
/** 超过这个长度就不做澄清判定：长句几乎不可能"信息不足"，白跑一次要 3~6 秒 */
export const CLARIFY_MAX_CHARS = 60;

/**
 * 尝试澄清：识别意图 → 判定是否该先追问。
 *
 * 返回 null 表示"不用追问"（含超时、识别失败、信息其实够用三种情况）——
 * 三种都走正常回答路径，调用方不需要区分。
 *
 * ## 为什么放在本文件而不是 OsService
 *
 * `os.service.ts` 已贴 300 行红线；而且这段是"要不要追问"的**独立判断**，
 * 与"怎么组装对话上下文"无关。识别函数由调用方注入，避免两文件互相 import。
 *
 * ## 为什么超时给 6 秒
 *
 * 实测意图识别 3.5~6.7s，而客户端对回复的等待上限是 15s、正文本身要 5~10s。
 * 澄清判定不能吃掉超过 1/3 的预算，否则会变成"为了可能追问，让所有对话都变慢"。
 */
export async function tryClarify(opts: {
  text: string;
  recognize: (text: string) => Promise<OsIntentResult>;
  logger: AppLogger;
  userId: string;
}): Promise<string | null> {
  // 只有短句才值得花这一次判定 —— 长句几乎不可能"信息不足"，
  // 而白跑一次识别就是 3~6 秒。这是"省钱也省用户时间"的前置过滤。
  if (opts.text.trim().length >= CLARIFY_MAX_CHARS) return null;

  try {
    const intent = await withTimeout(opts.recognize(opts.text), CLARIFY_TIMEOUT_MS);
    const decision = decideClarify(intent, opts.text);
    if (!decision.ask) return null;
    opts.logger.log(
      `澄清拦截：信息不足，追问 ${decision.questions.length} 个问题（用户 ${opts.userId}）`,
      'Os',
    );
    return clarifyReply(decision);
  } catch (e) {
    // 超时 / 识别失败：静默降级为正常回答。澄清是优化项，不是必经步骤。
    opts.logger.warn(`澄清判定跳过：${(e as Error).message}`, 'Os');
    return null;
  }
}

/**
 * 给 Promise 加超时。用于**可选**步骤（如澄清判定）：
 * 超时不是失败，只是"这次不做这件事"，所以由调用方 catch 后静默降级。
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`澄清判定超过 ${ms}ms`)), ms),
    ),
  ]);
}
