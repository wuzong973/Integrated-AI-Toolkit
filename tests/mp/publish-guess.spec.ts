import { describe, expect, it } from 'vitest';

import { guessBudget, localParse } from '../../apps/mp/utils/publish-guess';

/**
 * 本地兜底解析：日期不能当成钱（发布页 M3-07 离线分支）
 *
 * ## 起因（2026-09-19 端到端复核实测）
 *
 * 断网兜底的预算正则原本写成 `/(\d{2,6})(元|块)?/` —— 货币单位是**可选**的，
 * 于是"任意两位以上数字"都是钱：「我想找人拍毕业照，12月20日」被填成 **¥12**（1200 分），
 * 而且 toast 还说着"已为你填好表单"。这类错不会报错、不会红屏，
 * 只会在用户眼里变成"系统乱填"，并且**只在断网/后端不可用时**出现，手点很难复现 ——
 * 所以它必须由单测钉住，而不是靠 review 时"看着像对的"。
 *
 * ## 两个方向都要测（漏判与误判同样贵）
 *
 *  · **误判**（把日期/年份当钱）→ 预填出一个凭空的价格，比不填更糟；
 *  · **漏判**（把真价格判没了）→ AI 极速发布失去意义，用户以为功能坏了。
 * 因此下面正反两组用例是成对写的，改正则时任何一侧塌了都会红。
 */
describe('guessBudget —— 日期不是钱（误判方向）', () => {
  it('纯日期里的数字不再被当成预算（旧规则这里返回 1200 分 = ¥12）', () => {
    expect(guessBudget('我想找人拍毕业照，12月20日')).toBeNull();
    expect(guessBudget('帮我剪个视频，3号之前要')).toBeNull();
    expect(guessBudget('2024年6月10日需要家教')).toBeNull();
    expect(guessBudget('下周有 3 个人要拍证件照')).toBeNull();
  });

  it('「预算/价格」后面跟着日期也不算钱（月份和日子不是金额）', () => {
    expect(guessBudget('预算12月20日交片')).toBeNull();
    expect(guessBudget('价格下周再说')).toBeNull();
  });

  /**
   * 单位量级（千/万/亿）不猜：正则若允许"退而求其次"，"预算300万"会抠出 30 → ¥30，
   * 比不填更糟 —— 它是一个看起来完全合理的错数字。
   */
  it('带数量级的说法一律不猜（也不许从长数字里抠一截出来）', () => {
    expect(guessBudget('预算300万')).toBeNull();
    expect(guessBudget('价格12.5万')).toBeNull();
  });

  it('孤零零的数字不猜：宁可不预填，也不填一个像是系统估价的假数', () => {
    expect(guessBudget('拍毕业照 300')).toBeNull();
    expect(guessBudget('找人做个答辩PPT')).toBeNull();
  });
});

describe('guessBudget —— 真价格必须仍然认得出（漏判方向）', () => {
  it('数字 + 货币单位（元 / 块 / ¥ / RMB）→ 认', () => {
    expect(guessBudget('拍毕业照，300元')).toBe(30000);
    expect(guessBudget('大概 500 块吧')).toBe(50000);
    expect(guessBudget('预算 ¥200')).toBe(20000);
    expect(guessBudget('给 80 RMB')).toBe(8000);
  });

  it('「预算 / 价格 / 报价」+ 数字 → 认（用户常省略单位）', () => {
    expect(guessBudget('帮我拍毕业照，预算300')).toBe(30000);
    expect(guessBudget('价格大概200，可议')).toBe(20000);
  });

  it('句子里同时有日期和价格时，取的是钱而不是日期', () => {
    expect(guessBudget('12月20日拍毕业照，预算200元')).toBe(20000);
    expect(guessBudget('6月10日，3人，每人100块')).toBe(10000);
  });

  /**
   * 单位口径：**分**（整数）。与后端 `POST /station/parse`（`normalizeParsed` 元 → 分）一致。
   * 两边差 100 倍的话，"在线走模型 / 断网走兜底"会给出相差两个数量级的预算，
   * 而用户只会觉得"这表单不靠谱" —— 所以这条单独钉住，小数说法也不能漏出浮点。
   */
  it('返回的是「分」且为整数（与后端 parse 口径一致，红线：金额不用浮点）', () => {
    expect(guessBudget('300.5元')).toBe(30050);
    for (const cents of [guessBudget('预算300元'), guessBudget('300.5元')]) {
      expect(Number.isInteger(cents)).toBe(true);
    }
    expect(guessBudget('预算300元')).toBe(300 * 100);
  });
});

describe('localParse —— 字段形状与后端 ParsedDraft 对齐', () => {
  it('那句把 bug 暴露出来的原话：只填时间，不填钱', () => {
    const draft = localParse('我想找人拍毕业照，12月20日，3人');
    expect(draft.title).toBe('我想找人拍毕业照，12月20日，3人');
    expect(draft.categoryId).toBe('photo');
    expect(draft.time).toBe('12月20日');
    expect(draft).not.toHaveProperty('budget');
  });

  it('用户真说了钱才预填预算（否则留空，由用户自己填）', () => {
    expect(localParse('拍毕业照，预算300，6月10日').budget).toBe(30000);
    expect(localParse('拍毕业照，6月10日学校').budget).toBeUndefined();
  });

  it('time 原样保留用户说法（口语时间不能在这里被换算成日期）', () => {
    expect(localParse('明天需要人跑腿取件').time).toBe('明天');
    expect(localParse('下周要个答辩PPT').time).toBe('下周');
  });
});
