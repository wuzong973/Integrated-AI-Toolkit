/**
 * 行程模型单测
 *
 * 为什么这些用例值得写：
 *   行程表是"排错了也看不出来"的典型 —— 时间撞了、跨午夜算错、坏数据把整页搞崩，
 *   界面上都不会有任何提示。所以重点钉住四件事：
 *     **① 时间解析严格**（"24:00" 与 "9:5" 必须被拒绝，不能悄悄当成别的时刻）
 *     **② 跨午夜是正常情况**（23:30 + 90 分钟 = 次日 01:00，不是 00:30 也不是 01:30）
 *     **③ 冲突检测只看已定时间的站**（拿空时间比大小只会制造假冲突）
 *     **④ 反序列化只丢坏条目，不让整页打不开**
 */
import { describe, expect, it } from 'vitest';

import {
  conflictIds,
  dateRangeText,
  dayStats,
  formatDistance,
  formatDuration,
  formatTime,
  isNextDay,
  parseTime,
  parseTrip,
  sortStops,
  stopEndMinutes,
  type TripDay,
  type TripStop,
} from '../apps/mp/utils/trip';

const stop = (id: string, arriveAt = '', stayMinutes = 0, name = id): TripStop => ({
  id,
  name,
  address: '',
  arriveAt,
  stayMinutes,
});

const day = (stops: TripStop[], date = ''): TripDay => ({ id: 'd1', date, stops });

describe('parseTime', () => {
  it('接受 H:mm 与 HH:mm', () => {
    expect(parseTime('00:00')).toBe(0);
    expect(parseTime('9:05')).toBe(545);
    expect(parseTime('14:44')).toBe(884);
    expect(parseTime('23:59')).toBe(1439);
    expect(parseTime(' 10:00 ')).toBe(600);
  });

  it('⭐ 拒绝非法时刻，而不是悄悄算成别的值', () => {
    for (const bad of ['', '  ', '24:00', '23:60', '9:5', 'abc', '10', '10:0', '-1:00', '10:00:00']) {
      expect(parseTime(bad), `「${bad}」应被拒绝`).toBeNull();
    }
  });
});

describe('formatTime / isNextDay', () => {
  it('补零成 HH:mm', () => {
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(545)).toBe('09:05');
    expect(formatTime(884)).toBe('14:44');
  });

  it('⭐ 超过 24 小时会进位，并由 isNextDay 标出来（而不是回绕成当天）', () => {
    expect(formatTime(1500)).toBe('01:00');
    expect(isNextDay(1500)).toBe(true);
    expect(isNextDay(1439)).toBe(false);
  });
});

describe('formatDuration', () => {
  it('0 说"未定"，1 分钟说人话', () => {
    expect(formatDuration(0)).toBe('未定');
    expect(formatDuration(11)).toBe('11 分钟');
    expect(formatDuration(59)).toBe('59 分钟');
  });

  it('整点不带零头，非整点带分钟', () => {
    expect(formatDuration(60)).toBe('1 小时');
    expect(formatDuration(80)).toBe('1 小时 20 分');
    expect(formatDuration(120)).toBe('2 小时');
  });
});

describe('stopEndMinutes', () => {
  it('到达时间 + 停留时长', () => {
    expect(stopEndMinutes(stop('a', '10:00', 90))).toBe(690);
  });

  it('时间或时长缺一个就返回 null（不猜）', () => {
    expect(stopEndMinutes(stop('a', '', 90))).toBeNull();
    expect(stopEndMinutes(stop('a', '10:00', 0))).toBeNull();
  });

  it('⭐ 跨午夜：23:30 + 90 分钟 = 次日 01:00（1500 分钟，不回绕）', () => {
    const end = stopEndMinutes(stop('a', '23:30', 90));
    expect(end).toBe(1500);
    expect(formatTime(end!)).toBe('01:00');
    expect(isNextDay(end!)).toBe(true);
  });
});

describe('sortStops', () => {
  it('按时间升序，且不改入参', () => {
    const src = [stop('c', '14:00'), stop('a', '09:00'), stop('b', '11:30')];
    const out = sortStops(src);
    expect(out.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(src.map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });

  it('⭐ 没定时间的站排在最后，且保持原有相对顺序', () => {
    const out = sortStops([stop('x'), stop('a', '09:00'), stop('y')]);
    expect(out.map((s) => s.id)).toEqual(['a', 'x', 'y']);
  });

  it('空数组与单元素不报错', () => {
    expect(sortStops([])).toEqual([]);
    expect(sortStops([stop('a')]).map((s) => s.id)).toEqual(['a']);
  });
});

describe('conflictIds', () => {
  it('时间重叠时标出后一站', () => {
    // 10:00 起停留 120 分钟 → 到 12:00；下一站 11:00 就到了
    const d = day([stop('a', '10:00', 120), stop('b', '11:00', 30)]);
    expect(conflictIds(d)).toEqual(['b']);
  });

  it('首尾相接不算冲突（10:00+60 到 11:00，下一站正好 11:00）', () => {
    expect(conflictIds(day([stop('a', '10:00', 60), stop('b', '11:00', 30)]))).toEqual([]);
  });

  it('⭐ 没定时间的站一律不参与判断，不制造假冲突', () => {
    const d = day([stop('a', '10:00', 120), stop('x'), stop('b', '11:00', 30)]);
    expect(conflictIds(d)).toEqual(['b']);
    // 全是未定时间的站 → 一个冲突都不该报
    expect(conflictIds(day([stop('p'), stop('q')]))).toEqual([]);
  });

  it('停留时长为 0 的站不占用时间，因此不会引发冲突', () => {
    expect(conflictIds(day([stop('a', '10:00', 0), stop('b', '10:30', 0)]))).toEqual([]);
  });

  it('多站连锁重叠时，每个"撞上前面的"都被标出', () => {
    const d = day([
      stop('a', '10:00', 180), // 到 13:00
      stop('b', '11:00', 30), // 撞 a
      stop('c', '12:00', 30), // 仍撞 a（cursor 仍是最晚的 13:00）
    ]);
    expect(conflictIds(d)).toEqual(['b', 'c']);
  });

  it('⭐ 跨午夜不误判：23:30 起停留 90 分钟，次日 01:00 的站不算冲突', () => {
    // 排好序是 01:00(60) 在前、23:30(1410) 在后，两段本来就接得上
    const d = day([stop('late', '23:30', 90), stop('early', '01:00', 30)]);
    expect(conflictIds(d)).toEqual([]);
  });
});

describe('dayStats', () => {
  it('只统计已定时间的站', () => {
    const d = day([stop('a', '10:00', 60), stop('b', '11:00', 30), stop('x')]);
    expect(dayStats(d)).toEqual({ stops: 3, totalMinutes: 90 });
  });

  it('空的一天返回零值而不是 NaN', () => {
    expect(dayStats(day([]))).toEqual({ stops: 0, totalMinutes: 0 });
  });
});

describe('dateRangeText', () => {
  it('同一天只显示一个日期，跨天显示区间', () => {
    expect(dateRangeText([{ id: '1', date: '2026-07-23', stops: [] }])).toBe('7月23日');
    expect(
      dateRangeText([
        { id: '1', date: '2026-07-23', stops: [] },
        { id: '2', date: '2026-07-26', stops: [] },
      ]),
    ).toBe('7月23日 - 7月26日');
  });

  it('没有日期返回空串（界面据此不显示）', () => {
    expect(dateRangeText([{ id: '1', date: '', stops: [] }])).toBe('');
    expect(dateRangeText([])).toBe('');
  });
});

describe('parseTrip', () => {
  it('正常数据原样读回', () => {
    const raw = {
      city: '成都',
      days: [{ id: 'd1', date: '2026-07-23', stops: [stop('a', '10:00', 60, '武侯祠')] }],
    };
    const trip = parseTrip(raw);
    expect(trip.city).toBe('成都');
    expect(trip.days).toHaveLength(1);
    expect(trip.days[0].stops[0]).toMatchObject({ name: '武侯祠', arriveAt: '10:00', stayMinutes: 60 });
  });

  it('非对象 / 缺字段输入不报错，返回空行程', () => {
    for (const bad of [null, undefined, 42, 'x', {}, { days: 'nope' }]) {
      const trip = parseTrip(bad);
      expect(trip.days).toEqual([]);
      expect(trip.city).toBe('');
    }
  });

  it('⭐ 坏条目直接丢弃，不让整页打不开', () => {
    const raw = {
      city: '成都',
      days: [
        { id: 'ok', date: '2026-07-23', stops: [{ id: 's1', name: 'A' }] },
        { id: '', date: '', stops: [] },
        null,
        { nope: true },
        { id: 'ok', date: '', stops: [] },
      ],
    };
    const trip = parseTrip(raw);
    expect(trip.days.map((d) => d.id)).toEqual(['ok']);
  });

  it('⭐ 时间非法时降级成"未定"，而不是丢掉这一站', () => {
    const raw = {
      city: '',
      days: [{ id: 'd1', date: '', stops: [{ id: 's1', name: 'A', arriveAt: '25:00', stayMinutes: -5 }] }],
    };
    const s = parseTrip(raw).days[0].stops[0];
    expect(s.arriveAt).toBe('');
    expect(s.stayMinutes).toBe(0);
  });

  it('缺 id 或 name 字段的站被丢弃（它们是更新与渲染的最小前提）', () => {
    const raw = {
      city: '',
      days: [
        {
          id: 'd1',
          date: '',
          stops: [
            { id: 's1' },
            { name: '无 id' },
            { id: 's2', name: 42 },
            { id: 's3', name: '有效' },
          ],
        },
      ],
    };
    expect(parseTrip(raw).days[0].stops.map((s) => s.id)).toEqual(['s3']);
  });

  it('⭐ 名字是空串的站要保留（用户刚点"添加一站"，还没填名字）', () => {
    const raw = {
      city: '',
      days: [{ id: 'd1', date: '', stops: [{ id: 's1', name: '', arriveAt: '', stayMinutes: 0 }] }],
    };
    const stops = parseTrip(raw).days[0].stops;
    expect(stops).toHaveLength(1);
    expect(stops[0].name).toBe('');
  });

  it('名字只有空白时 trim 成空串后保留，而不是丢掉', () => {
    const raw = { city: '', days: [{ id: 'd1', date: '', stops: [{ id: 's1', name: '   ' }] }] };
    expect(parseTrip(raw).days[0].stops[0].name).toBe('');
  });

  it('日期格式非法时降级成空串', () => {
    const raw = { city: '', days: [{ id: 'd1', date: '2026/07/23', stops: [] }] };
    expect(parseTrip(raw).days[0].date).toBe('');
  });
});

describe('formatDistance', () => {
  it('1 公里以下说"米"，以上说"公里"', () => {
    expect(formatDistance(0)).toBe('0 米');
    expect(formatDistance(1)).toBe('1 米');
    expect(formatDistance(867)).toBe('867 米');
    expect(formatDistance(999)).toBe('999 米');
    expect(formatDistance(1000)).toBe('1.0 公里');
    expect(formatDistance(3628)).toBe('3.6 公里');
    expect(formatDistance(5951)).toBe('6.0 公里');
  });

  it('负数与小数被归一化，不产生 NaN', () => {
    expect(formatDistance(-5)).toBe('0 米');
    expect(formatDistance(866.6)).toBe('867 米');
  });
});

/**
 * `leg`（从上一站到这里的通行估算）的校验。
 *
 * 它是**外部事实**（地图服务算的）而存进了本地存储 —— 存储不可信这条规矩
 * 对它同样适用。关键判据：形状不对时**丢成 undefined**（界面显示"还没算"），
 * **绝不能编一个 0 米** —— "0 米 / 0 分钟"看起来像"就在原地"，比"没算过"更糟。
 */
describe('parseTrip 对 leg 的处理', () => {
  const withLeg = (leg: unknown) => ({
    city: '',
    days: [{ id: 'd1', date: '', stops: [{ id: 's1', name: 'A', leg }] }],
  });
  const legOf = (leg: unknown) => parseTrip(withLeg(leg)).days[0].stops[0].leg;

  it('合法的 leg 原样读回', () => {
    expect(
      legOf({ distanceMeters: 3628, durationSeconds: 3534, mode: 'walking', at: '2026-09-20T13:00:00.000Z' }),
    ).toEqual({
      distanceMeters: 3628,
      durationSeconds: 3534,
      mode: 'walking',
      at: '2026-09-20T13:00:00.000Z',
    });
  });

  it('⭐ 形状不对时丢成 undefined，而不是编一个 0 米', () => {
    for (const bad of [
      null,
      'x',
      42,
      {},
      { distanceMeters: 100 }, // 缺 durationSeconds
      { distanceMeters: -1, durationSeconds: 10 }, // 负数
    ]) {
      expect(legOf(bad), `${JSON.stringify(bad)} 应被丢弃`).toBeUndefined();
    }
  });

  it('mode 不是 driving 时归一到 walking（不给未知值留口子）', () => {
    expect(legOf({ distanceMeters: 100, durationSeconds: 60, mode: 'flying' })?.mode).toBe('walking');
  });

  it('缺 leg 字段的站点照常保留（第一站本来就没有）', () => {
    const stops = parseTrip({
      city: '',
      days: [{ id: 'd1', date: '', stops: [{ id: 's1', name: 'A' }] }],
    }).days[0].stops;
    expect(stops).toHaveLength(1);
    expect(stops[0].leg).toBeUndefined();
  });

  it('小数距离被四舍五入到整米（界面不显示 3627.6 米）', () => {
    expect(legOf({ distanceMeters: 3627.6, durationSeconds: 3533.8 })?.distanceMeters).toBe(3628);
    expect(legOf({ distanceMeters: 3627.6, durationSeconds: 3533.8 })?.durationSeconds).toBe(3534);
  });
});
