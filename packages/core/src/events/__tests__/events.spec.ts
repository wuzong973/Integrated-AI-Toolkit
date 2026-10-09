import { describe, expect, it } from 'vitest';

import {
  mergeJobProgress,
  parseServerMessage,
  toSnapshot,
  type JobProgressSnapshot,
} from '../index';

/**
 * 进度合并规则（M1-05 验收项"断线重连后可补齐进度，不出现进度倒退"）
 *
 * 这些边界不值得靠"看代码觉得对了"来保证 —— 它决定了用户界面上那个进度条
 * 会不会突然往回跳，一旦错了很难在联调时发现。
 */
describe('mergeJobProgress 进度合并', () => {
  const snap = (over: Partial<JobProgressSnapshot> = {}): JobProgressSnapshot => ({
    jobId: 'job-1',
    status: 'running',
    progress: 10,
    stage: '开始处理',
    ...over,
  });

  it('首次收到（无历史）一律采纳', () => {
    const r = mergeJobProgress(undefined, snap({ progress: 0 }));
    expect(r.accepted).toBe(true);
    expect(r.next.progress).toBe(0);
  });

  it('正常前进被采纳', () => {
    const r = mergeJobProgress(snap({ progress: 40 }), snap({ progress: 70, stage: '渲染中' }));
    expect(r.accepted).toBe(true);
    expect(r.next.progress).toBe(70);
    expect(r.next.stage).toBe('渲染中');
  });

  it('进度倒退的消息被丢弃（乱序/重复投递），且不夹断成上界', () => {
    const prev = snap({ progress: 80 });
    const r = mergeJobProgress(prev, snap({ progress: 30 }));
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('regressed');
    // 关键：返回的是 prev 本身，而不是把 30 夹到 80 ——
    // 夹断会掩盖服务端真正的 bug
    expect(r.next).toBe(prev);
  });

  it('完全相同（进度/状态/阶段）的消息不触发二次渲染', () => {
    const r = mergeJobProgress(snap(), snap());
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('duplicate');
  });

  it('阶段名变化但进度未变，仍然采纳（用户要看到"正在保存"这类信息）', () => {
    const r = mergeJobProgress(
      snap({ progress: 90, stage: '渲染中' }),
      snap({ progress: 90, stage: '保存中' }),
    );
    expect(r.accepted).toBe(true);
    expect(r.next.stage).toBe('保存中');
  });

  it('终态不可被迟到消息改回处理中', () => {
    const prev = snap({ status: 'succeeded', progress: 100, stage: '已完成' });
    const r = mergeJobProgress(prev, snap({ status: 'running', progress: 60 }));
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('terminal');
    expect(r.next.status).toBe('succeeded');
  });

  it('终态之间的切换也不再采纳（终态是最终结论）', () => {
    const prev = snap({ status: 'failed', progress: 50 });
    const r = mergeJobProgress(prev, snap({ status: 'canceled', progress: 50 }));
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('terminal');
  });

  it('进入失败态被采纳（进度可以停在中间值）', () => {
    const r = mergeJobProgress(
      snap({ progress: 60 }),
      snap({ status: 'failed', progress: 60, error: '存储不可用' }),
    );
    expect(r.accepted).toBe(true);
    expect(r.next.status).toBe('failed');
    expect(r.next.error).toBe('存储不可用');
  });

  it('未知状态不会被误判为终态（脏数据不能把界面锁死）', () => {
    const r = mergeJobProgress(
      snap({ status: 'weird_status', progress: 10 }),
      snap({ progress: 20 }),
    );
    expect(r.accepted).toBe(true);
  });

  it('断线重连场景：重连后先拿到快照再收到增量，进度连续不跳回', () => {
    // 断线前的最后状态
    let state: JobProgressSnapshot | undefined = snap({ progress: 30, stage: '生成大纲' });
    // 断线期间服务端继续推进（客户端看不到）
    // 重连后：① 服务端下发快照 ② 之后是增量事件
    const afterReconnect = [
      snap({ progress: 70, stage: '渲染页面' }),
      snap({ progress: 90, stage: '保存文件' }),
      snap({ progress: 100, status: 'succeeded', stage: '已完成' }),
    ];
    for (const incoming of afterReconnect) {
      const r = mergeJobProgress(state, incoming);
      if (r.accepted) state = r.next;
    }
    // 断线期间累积的进度被一次性补齐，且没有任何一次倒退
    expect(state?.progress).toBe(100);
    expect(state?.status).toBe('succeeded');
  });
});

describe('消息解析', () => {
  it('非法 JSON 返回 null 而不是抛错', () => {
    expect(parseServerMessage('{ not json')).toBeNull();
  });

  it('缺少 type 的消息被拒绝', () => {
    expect(parseServerMessage('{"jobId":"x"}')).toBeNull();
  });

  it('正常消息可解析', () => {
    const msg = parseServerMessage('{"type":"tool.progress","jobId":"j1","progress":50}');
    expect(msg?.type).toBe('tool.progress');
  });

  it('缺少 jobId 或 progress 的消息不构成快照', () => {
    expect(toSnapshot({ type: 'pong' })).toBeNull();
    expect(toSnapshot({ type: 'tool.progress', jobId: 'j1' })).toBeNull();
  });

  it('快照缺省 status 时按"处理中"处理', () => {
    expect(toSnapshot({ type: 'tool.progress', jobId: 'j1', progress: 20 })?.status).toBe(
      'running',
    );
  });
});
