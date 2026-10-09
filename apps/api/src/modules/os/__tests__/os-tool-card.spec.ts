import { describe, expect, it } from 'vitest';

import { buildFilesCard } from '../os-tool-card';

/**
 * 「我的文件」卡
 *
 * ## 它为什么存在
 *
 * 真机实测：同一会话里第二次提同样需求时，模型会把历史里自己上一轮的
 * "已经为您生成…"当成既成事实，于是不再调用工具、直接复述结论 ——
 * 用户看到"点下面的卡片查看"而下面什么都没有。
 *
 * 出口净化会补一句"本轮没有实际执行"的事实。但**只补一句话是不够的**：
 * 用户想要的东西很可能**真的存在**（就在上一轮那次），只是他没有任何路径去找。
 * 所以再给一张卡把"东西在哪"答完。
 *
 * ## 这组用例盯的是"话要说清楚"
 */

describe('buildFilesCard', () => {
  it('⭐ 指向「我的文件」列表页', () => {
    const card = buildFilesCard(7);

    expect(card.kind).toBe('files');
    expect(card.title).toBe('我的文件');
    expect(card.route).toBe('/pkg-toolbox/files/index');
    // 数量必须是真实查出来的，用户据此判断"值不值得点进去"
    expect(card.summary).toContain('7 个文件');
  });

  it('⭐ 一个文件都没有也照给卡 —— 但**不能**谎报数量', () => {
    // 真机探针发现：长任务（PPT）异步落盘，净化触发时常常还没有文件。
    // 若拿"count > 0"当门槛，最需要这张卡的时刻它恰好不出现。
    const card = buildFilesCard(0);

    expect(card.kind).toBe('files');
    expect(card.summary).not.toMatch(/\d+ 个文件/);
    expect(card.summary).toContain('上传或生成过的文件');
  });

  it('⭐ 卡上必须写清"不是本轮生成的"（否则用户会当成刚做好的东西）', () => {
    expect(buildFilesCard(3).note).toContain('这一轮没有新生成');
    // 空文件数时说法要跟着变，不能留一句对不上的话
    expect(buildFilesCard(0).note).toContain('没有实际生成');
  });

  it('不是 result 卡：不能带 jobId / status（带了就会被界面当成"已完成"）', () => {
    const card = buildFilesCard(1);
    expect(card.jobId).toBeUndefined();
    expect(card.status).toBeUndefined();
    expect(card.outputCount).toBeUndefined();
  });

  it('没有"参数"可言（它不是一次执行）', () => {
    expect(buildFilesCard(2).params).toEqual([]);
  });
});
