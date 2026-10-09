import { describe, expect, it } from 'vitest';

import {
  LOG_LIMIT,
  buildLog,
  dayLabel,
  formatSessionTime,
  toSessionRows,
} from '../../apps/mp/utils/os-history';
import type { OsMessageItem, OsSessionItem } from '../../apps/mp/utils/api-types';
import type { OsToolCard } from '../../apps/mp/utils/os';

/**
 * 聊天记录（历史记录页）的纯逻辑。
 *
 * 重点：
 *   ① **时间正序**——记录倒着显示这种错在真机上很难第一时间看出来；
 *   ② **日期分段**——同一段只出现一次分隔标题，不能每条都顶一个"今天"；
 *   ③ **只取最近 N 条**——并且截断了要如实说，不能装作这就是全部。
 *
 * ⚠️ 时间一律用**本地时间**造 ISO 串：跑测机器的时区不影响断言。
 */
function iso(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): string {
  return new Date(y, mo - 1, d, h, mi, s).toISOString();
}

/** 基准"现在"：2026-09-19 10:00（本地） */
const NOW = new Date(2026, 8, 19, 10, 0, 0);

/** 造一条后端消息（默认是助手的文本） */
function msg(partial: Partial<OsMessageItem> & { id: string; createdAt: string }): OsMessageItem {
  return { role: 'assistant', kind: 'text', content: '好的', ...partial };
}

function session(id: string, updatedAt: string): OsSessionItem {
  return { id, title: '青智 OS', status: 'active', updatedAt };
}

describe('formatSessionTime —— 会话的最近活跃时间', () => {
  it('一分钟内（含时钟偏差导致的未来时间）显示「刚刚」', () => {
    expect(formatSessionTime(iso(2026, 9, 19, 9, 59, 30), NOW)).toBe('刚刚');
    expect(formatSessionTime(iso(2026, 9, 19, 11, 0, 0), NOW)).toBe('刚刚');
  });

  it('一小时内显示「N 分钟前」', () => {
    expect(formatSessionTime(iso(2026, 9, 19, 9, 30), NOW)).toBe('30 分钟前');
    expect(formatSessionTime(iso(2026, 9, 19, 9, 1), NOW)).toBe('59 分钟前');
  });

  it('今天 / 昨天 / 同年 / 跨年逐级降到更省地方的形式', () => {
    expect(formatSessionTime(iso(2026, 9, 19, 8, 0), NOW)).toBe('今天 08:00');
    expect(formatSessionTime(iso(2026, 9, 18, 20, 15), NOW)).toBe('昨天 20:15');
    expect(formatSessionTime(iso(2026, 9, 16, 10, 0), NOW)).toBe('09-16 10:00');
    expect(formatSessionTime(iso(2025, 12, 31, 23, 0), NOW)).toBe('2025-12-31');
  });

  it('时间读不出来时说「时间未知」，不铺一串 Invalid Date', () => {
    expect(formatSessionTime('not-a-date', NOW)).toBe('时间未知');
  });
});

describe('dayLabel —— 记录里的日期分隔标题', () => {
  it('三天内用相对说法，更早用具体日期', () => {
    expect(dayLabel(iso(2026, 9, 19, 0, 5), NOW)).toBe('今天');
    expect(dayLabel(iso(2026, 9, 18, 23, 55), NOW)).toBe('昨天');
    expect(dayLabel(iso(2026, 9, 17, 9, 0), NOW)).toBe('前天');
    expect(dayLabel(iso(2026, 9, 16, 9, 0), NOW)).toBe('9月16日');
  });

  it('跨年带上年份', () => {
    expect(dayLabel(iso(2025, 12, 31, 9, 0), NOW)).toBe('2025年12月31日');
  });

  it('非法日期不会渲染成空标题', () => {
    expect(dayLabel('', NOW)).toBe('时间未知');
  });
});

describe('toSessionRows', () => {
  it('只补一个时间文案，其余字段原样透出', () => {
    const rows = toSessionRows([session('s1', iso(2026, 9, 19, 9, 0))], NOW);
    expect(rows).toEqual([
      {
        id: 's1',
        title: '青智 OS',
        status: 'active',
        updatedAt: iso(2026, 9, 19, 9, 0),
        timeText: '今天 09:00',
      },
    ]);
  });
});

describe('buildLog —— 可渲染的记录行', () => {
  it('空列表不报错也不产生假数据', () => {
    expect(buildLog([], { now: NOW })).toEqual({ rows: [], truncated: false });
  });

  it('⭐ 无论后端给什么顺序，输出一律按时间正序', () => {
    const items = [
      msg({ id: 'late', createdAt: iso(2026, 9, 19, 9, 30) }),
      msg({ id: 'early', createdAt: iso(2026, 9, 19, 9, 0) }),
      msg({ id: 'mid', createdAt: iso(2026, 9, 19, 9, 15) }),
    ];
    const { rows } = buildLog(items, { now: NOW });
    expect(rows.map((r) => r.id)).toEqual(['early', 'mid', 'late']);
  });

  it('读不出时间的消息排到最后，不会插进对话中间', () => {
    const items = [
      msg({ id: 'bad', createdAt: 'oops' }),
      msg({ id: 'ok', createdAt: iso(2026, 9, 19, 9, 0) }),
    ];
    const { rows } = buildLog(items, { now: NOW });
    expect(rows.map((r) => r.id)).toEqual(['ok', 'bad']);
    expect(rows[1].dayText).toBe('时间未知');
  });

  it('同一天只在首条上方画日期分隔', () => {
    const items = [
      msg({ id: 'a', createdAt: iso(2026, 9, 17, 9, 0) }),
      msg({ id: 'b', createdAt: iso(2026, 9, 17, 21, 0) }),
      msg({ id: 'c', createdAt: iso(2026, 9, 18, 8, 0) }),
    ];
    const { rows } = buildLog(items, { now: NOW });
    expect(rows.map((r) => r.showDay)).toEqual([true, false, true]);
    expect(rows.map((r) => r.dayText)).toEqual(['前天', '前天', '昨天']);
    expect(rows.map((r) => r.timeText)).toEqual(['09:00', '21:00', '08:00']);
  });

  it('角色与形态按白名单映射（表外取值不产生落空的样式）', () => {
    const items = [
      msg({ id: 'u', role: 'user', createdAt: iso(2026, 9, 19, 9, 0) }),
      msg({
        id: 'a',
        role: 'assistant',
        agentName: 'coordinator',
        createdAt: iso(2026, 9, 19, 9, 1),
      }),
      msg({ id: 's', role: 'system', createdAt: iso(2026, 9, 19, 9, 2) }),
      msg({ id: 'x', role: 'weird', kind: 'weird', createdAt: iso(2026, 9, 19, 9, 3) }),
    ];
    const { rows } = buildLog(items, { now: NOW });
    expect(rows.map((r) => r.roleLabel)).toEqual(['我', 'coordinator', '系统', '青智 OS']);
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant', 'system', 'assistant']);
    expect(rows[3].kind).toBe('text');
  });

  it('⭐ 结果卡转成视图对象（状态文案 / 能否点 / 图标都在进 setData 前算好）', () => {
    const card: OsToolCard = {
      kind: 'result',
      toolName: 'generate_ppt',
      title: 'AI PPT 生成',
      summary: '已生成 12 页',
      params: [{ label: '页数', value: '12' }],
      jobId: 'job-1',
      status: 'succeeded',
    };
    const { rows } = buildLog(
      [msg({ id: 'c', createdAt: iso(2026, 9, 19, 9, 0), cards: [card] })],
      { now: NOW },
    );
    expect(rows[0].cards?.[0]).toMatchObject({
      statusText: '已完成',
      actionable: true,
      icon: 'qz-i-sparkle',
      paramText: '页数：12',
    });
  });

  it('没有卡片时不产出一个空数组（模板的 wx:if 靠它判断）', () => {
    const { rows } = buildLog([msg({ id: 'n', createdAt: iso(2026, 9, 19, 9, 0) })], { now: NOW });
    expect(rows[0].cards).toBeUndefined();
  });

  it('⭐ 只保留最近 N 条，并如实标记被截断', () => {
    const many = Array.from({ length: LOG_LIMIT + 1 }, (_, i) =>
      msg({ id: `m${i}`, createdAt: iso(2026, 9, 19, 9, 0, i) }),
    );
    const { rows, truncated } = buildLog(many, { now: NOW });
    expect(truncated).toBe(true);
    expect(rows).toHaveLength(LOG_LIMIT);
    // 丢的是**最早**那条，留下的最后一条是最新的
    expect(rows[0].id).toBe('m1');
    expect(rows[rows.length - 1].id).toBe(`m${LOG_LIMIT}`);
  });

  it('刚好等于上限时不算截断（不能凭空报"更早的没显示"）', () => {
    const many = Array.from({ length: LOG_LIMIT }, (_, i) =>
      msg({ id: `m${i}`, createdAt: iso(2026, 9, 19, 9, 0, i) }),
    );
    expect(buildLog(many, { now: NOW }).truncated).toBe(false);
  });
});
