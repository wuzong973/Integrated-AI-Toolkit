import { describe, expect, it } from 'vitest';

import { guardFalseCompletion, isFalseCompletion, sanitizeAssistantReply } from '../os-reply-guard';

/**
 * 对话回复净化
 *
 * 背景（实测）：降级链里的 `glm-4-flash` 会编造平台里不存在的链接。
 * 提示词要求了"不要编造平台功能"但它照样编 —— 所以出口必须能兜住。
 * 下面第一条用例就是**实测抓到的原文**，不要删。
 */
describe('sanitizeAssistantReply —— 删掉编造的链接', () => {
  it('实测抓到的原文：保留文字、去掉编造的链接', () => {
    const raw =
      '可以用 AI PPT 生成工具完成，点这里开始：[AI PPT 生成](https://www.qingzhi.com/ai/ppt)';
    expect(sanitizeAssistantReply(raw)).toBe('可以用 AI PPT 生成工具完成，点这里开始：AI PPT 生成');
  });

  it('裸链接（无 Markdown 包裹）也会被删掉', () => {
    const raw = '去 https://www.qingzhi.com/tools/ppt 就能用。';
    expect(sanitizeAssistantReply(raw)).toBe('去 就能用。');
  });

  it('www. 开头、没有协议的也算', () => {
    expect(sanitizeAssistantReply('见 www.qingzhi.com/ai/ppt')).toBe('见');
  });

  it('⭐ 不吃掉链接后面的中文标点与内容', () => {
    // 反面教材：用 /[^\s]+/ 匹配会一路吞到行尾
    const raw = '参考 https://example.com/a，然后自己写。';
    expect(sanitizeAssistantReply(raw)).toBe('参考 ，然后自己写。');
  });

  it('图片整段删掉（比链接更没必要出现在对话里）', () => {
    expect(sanitizeAssistantReply('看图 ![示意图](https://x.com/a.png) 即可')).toBe('看图 即可');
  });

  it('删链接后残留的空括号一并清掉', () => {
    expect(sanitizeAssistantReply('点这里（）开始')).toBe('点这里开始');
    // 半角括号两侧原本有空格，清掉后只剩一个空格（不做「中文字间去空格」，那会误伤英文）
    expect(sanitizeAssistantReply('点这里 ( ) 开始')).toBe('点这里 开始');
  });

  it('删链接留下的重复标点会合并', () => {
    expect(sanitizeAssistantReply('点这里：https://x.com/a：开始')).toBe('点这里：开始');
  });

  it('整段只有一个链接 → 返回空串，交给客户端按意图兜底', () => {
    expect(sanitizeAssistantReply('https://www.qingzhi.com/ai/ppt')).toBe('');
    expect(sanitizeAssistantReply('[点这里](https://www.qingzhi.com/ai/ppt)')).toBe('点这里');
  });

  it('干净的正常回复原样返回', () => {
    const raw = '演讲稿生成功能还在开发中。你可以先用「AI 生成大纲」梳理结构。';
    expect(sanitizeAssistantReply(raw)).toBe(raw);
  });

  it('幂等：跑两遍结果一致', () => {
    const raw = '点这里：[AI PPT](https://www.qingzhi.com/ai/ppt)';
    const once = sanitizeAssistantReply(raw);
    expect(sanitizeAssistantReply(once)).toBe(once);
  });

  it('空输入 / 空白输入不炸', () => {
    expect(sanitizeAssistantReply('')).toBe('');
    expect(sanitizeAssistantReply('   ')).toBe('');
  });
});

/**
 * 推理标签残留（排查报告 P2-6）
 *
 * 实测原文：`只回复两个字：可以` → `可以</think>可以`
 * —— 正常内容被标签**切断并重复**了一次。这是"带 `reasoning_effort` 参数时
 * 个别服务商把闭合标签漏进 `content`"导致的，同一请求去掉该参数则输出干净。
 *
 * 为什么必须在出口拦：残留可能来自模型 / 网关 / 将来换的服务商任何一层，
 * 出口是唯一能覆盖全部来源的位置；而 Provider 只该管协议与容错，不该猜哪段是元数据。
 */
describe('sanitizeAssistantReply —— 剥离推理标签残留', () => {
  it('实测原文：剥掉标签，保留被它切断的内容', () => {
    expect(sanitizeAssistantReply('可以</think>可以')).toBe('可以可以');
  });

  it('成对标签包裹的整块推理被删掉，不把思考过程给用户看', () => {
    const raw = '<think>用户在问能不能做 PPT，我应该给出工具入口</think>可以用 AI PPT 生成工具完成。';
    expect(sanitizeAssistantReply(raw)).toBe('可以用 AI PPT 生成工具完成。');
  });

  it('大小写与自闭合变体都要覆盖', () => {
    expect(sanitizeAssistantReply('好的</THINK>')).toBe('好的');
    expect(sanitizeAssistantReply('好的<Think>')).toBe('好的');
  });

  it('整段只有标签 → 返回空串，交给客户端按意图兜底', () => {
    expect(sanitizeAssistantReply('</think>')).toBe('');
    expect(sanitizeAssistantReply('<think>只有思考</think>')).toBe('');
  });

  it('幂等：对已净化的文本再跑一次结果不变', () => {
    const once = sanitizeAssistantReply('可以</think>可以');
    expect(sanitizeAssistantReply(once)).toBe(once);
  });

  it('不误伤正文里正常出现的英文单词', () => {
    // 只删带尖括号的标签形态，裸词 think 必须原样保留
    expect(sanitizeAssistantReply('I think it works')).toBe('I think it works');
  });
});

/**
 * 假成功净化：说了"做完了"，但这一轮其实什么都没执行
 *
 * 这条守卫来自**真机实测**：同一会话里先成功生成过一次 PPT，
 * 用户再说一次同样的话时，模型把历史里自己上一轮的"已经为您生成…"
 * 当成既成事实，于是**不再调用工具、直接复述结论** ——
 * 用户看到"点下面的卡片查看"，而下面什么都没有。这比干脆失败更糟。
 *
 * 判据是服务端确知的 `executed`（工具循环有没有真跑出东西），
 * 不依赖对文案的猜测，所以下面「不误伤」那两条同样重要。
 */
describe('guardFalseCompletion —— 不许谎报完成', () => {
  const LIE = '已经为您生成了一份关于校园二手交易平台的课程汇报PPT，共12页。点下面的卡片查看详情。';

  it('⭐ 实测抓到的原文：没执行却说完成 → 补一句确知的事实', () => {
    const out = guardFalseCompletion(LIE, false);
    expect(out).toContain('已经为您生成'); // 不删原文，只补事实
    expect(out).toContain('没有实际执行任何动作');
    expect(out).toContain('再发一次需求');
  });

  it('⭐ 真的执行过 → 一个字都不动（这是正常路径，净化不能打扰它）', () => {
    expect(guardFalseCompletion(LIE, true)).toBe(LIE);
  });

  it('没执行但也**没说完成** → 不动（例如正常的问答、追问）', () => {
    const ask = '你想做什么主题的 PPT？大概需要多少页？';
    expect(guardFalseCompletion(ask, false)).toBe(ask);
  });

  it('执行失败后的如实说明不会被误伤', () => {
    const fail = '「AI PPT 生成」执行失败：今日可用次数已用完。请如实把原因告诉用户。';
    expect(guardFalseCompletion(fail, false)).toBe(fail);
  });

  it('只在"没执行 + 说完成"同时成立时才介入', () => {
    // 两种说法都要被认定为"声称完成"（中间夹了"为您"的那句最容易被漏掉）
    for (const s of [
      '已经为您生成了PPT',
      '已生成了PPT',
      '已经完成',
      '已经提交，正在后台处理',
      '正在为您生成',
    ]) {
      expect(guardFalseCompletion(s, false)).toContain('没有实际执行');
    }
    // 正常的叙述不该被拦
    for (const s of ['AI PPT 生成这个功能已经上线了', '我帮你记下了这个需求', '你想做几页？']) {
      expect(guardFalseCompletion(s, false)).toBe(s);
    }
  });

  /**
   * `isFalseCompletion` 单独导出，是因为 `OsService` 还要**据此再附一张
   * 「我的文件」卡**（见 `os-tool-card.ts` 的 `files` 形态）。
   * 所以它的判定必须与 `guardFalseCompletion` 完全一致 —— 不一致会出现
   * "补了卡但没有说明"或"有说明却没有卡"的半吊子状态。
   */
  it('⭐ 判定与净化必须一致（否则会出现"有卡没说明"或"有说明没卡"）', () => {
    const cases: [string, boolean][] = [
      [LIE, false],
      [LIE, true],
      ['你想做什么主题的 PPT？', false],
      ['「AI PPT 生成」执行失败：次数已用完', false],
      ['已经上线了', false],
    ];
    for (const [reply, executed] of cases) {
      const corrected = guardFalseCompletion(reply, executed) !== reply;
      expect(isFalseCompletion(reply, executed)).toBe(corrected);
    }
  });

  it('空回复不会被判定为假成功', () => {
    expect(isFalseCompletion('', false)).toBe(false);
    expect(isFalseCompletion(undefined as never, false)).toBe(false);
  });
});
