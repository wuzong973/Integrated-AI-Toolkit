import { describe, expect, it } from 'vitest';

// 直接引用 core 的**源码**而不是 @qz/core（后者指向 dist，会因构建陈旧而让守卫失效）
import { mergeJobProgress } from '../../packages/core/src/events';
import { mergeProgress, isTerminal, type ProgressUpdate } from '../../apps/mp/utils/progress';

/**
 * 小程序侧进度合并的验证 + **与 core 的漂移守卫**
 *
 * ## 为什么这个测试不在 `apps/mp/` 里
 *
 * `project.config.json` 的 `miniprogramRoot` 就是 `apps/mp/`，也就是**发布包本身**。
 * 包内任何"没有被引用到"的文件都会被开发者工具的「过滤无依赖文件」分析点名
 * （控制台出现「xxx 目录下的所有文件将会被忽略」），而且有被误打包上传的风险。
 *
 * **约定：小程序的测试一律放 `tests/mp/`，不要放回 `apps/mp/`。**
 * `vitest.config.ts` 的 `include` 已覆盖本目录；`project.config.json` 的
 * `packOptions.ignore` 也加了兜底规则，万一有人放回去也不会进包。
 *
 * ## 这个测试在守什么
 *
 * 小程序没有 `package.json`、不参与 npm workspaces，**无法 `import '@qz/core'`**，
 * 因此 `apps/mp/utils/progress.ts` 是 core 规则的**镜像实现**。
 * 重复本身不可怕，"两份实现悄悄走偏"才可怕 —— 所以这里做两件事：
 *   ① 用常规用例验证行为本身（进度不倒退、终态不可变）；
 *   ② 把两份实现在**同一组输入矩阵**上跑，逐条比对结论。
 * 哪天 core 改了规则而镜像没跟上，第 ② 组会立刻红。
 */
describe('小程序侧进度合并', () => {
  const snap = (over: Partial<ProgressUpdate> = {}): ProgressUpdate => ({
    jobId: 'j1',
    status: 'running',
    progress: 10,
    stage: '开始处理',
    ...over,
  });

  it('首次收到一律采纳', () => {
    expect(mergeProgress(undefined, snap({ progress: 0 })).accepted).toBe(true);
  });

  it('进度倒退被丢弃，且不夹断成上界', () => {
    const prev = snap({ progress: 80 });
    const r = mergeProgress(prev, snap({ progress: 30 }));
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('regressed');
    expect(r.next).toBe(prev);
  });

  it('终态不可被迟到消息改回处理中', () => {
    const prev = snap({ status: 'succeeded', progress: 100 });
    const r = mergeProgress(prev, snap({ status: 'running', progress: 50 }));
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('terminal');
  });

  it('isTerminal 识别四个终态', () => {
    for (const s of ['succeeded', 'failed', 'canceled', 'rejected'])
      expect(isTerminal(s)).toBe(true);
    for (const s of ['queued', 'running', 'weird']) expect(isTerminal(s)).toBe(false);
  });
});

describe('漂移守卫：小程序镜像实现 ≡ core 实现', () => {
  const statuses = ['queued', 'running', 'succeeded', 'failed', 'canceled', 'rejected', 'unknown'];
  const progresses = [0, 30, 60, 100];
  const stages = ['', '渲染中'];

  it('在全部状态 × 进度 × 阶段组合上结论一致', () => {
    const mismatches: string[] = [];

    for (const prevStatus of statuses) {
      for (const nextStatus of statuses) {
        for (const prevProgress of progresses) {
          for (const nextProgress of progresses) {
            for (const prevStage of stages) {
              for (const nextStage of stages) {
                const prev: ProgressUpdate = {
                  jobId: 'j1',
                  status: prevStatus,
                  progress: prevProgress,
                  stage: prevStage,
                };
                const next: ProgressUpdate = {
                  jobId: 'j1',
                  status: nextStatus,
                  progress: nextProgress,
                  stage: nextStage,
                };

                const local = mergeProgress(prev, next);
                const reference = mergeJobProgress(prev, next);

                if (local.accepted !== reference.accepted || local.reason !== reference.reason) {
                  mismatches.push(
                    `prev(${prevStatus},${prevProgress},'${prevStage}') next(${nextStatus},${nextProgress},'${nextStage}')` +
                      ` → 小程序 accepted=${local.accepted}/${local.reason}，core accepted=${reference.accepted}/${reference.reason}`,
                  );
                }
              }
            }
          }
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('prev 为空时两份实现都采纳', () => {
    const next: ProgressUpdate = { jobId: 'j1', status: 'running', progress: 5 };
    expect(mergeProgress(undefined, next).accepted).toBe(true);
    expect(mergeJobProgress(undefined, next).accepted).toBe(true);
  });
});
