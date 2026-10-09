/**
 * 作业进度合并（小程序侧）
 *
 * ## ⚠️ 为什么这里是 `packages/core/src/events` 的一份镜像实现
 *
 * 规则本身在 core 里已经有一份（`mergeJobProgress`）。之所以不能直接 import：
 * **小程序当前没有 `package.json`、不参与 npm workspaces**，因此
 * `require('@qz/core')` 在微信开发者工具里解析不到（需要"构建 npm"配合，
 * 属于 M1-15 之后要补的工程化事项）。
 *
 * 这是**有意的临时重复**，不是疏忽。防漂移的手段是测试：
 * `__tests__/progress.spec.ts` 会把两份实现在同一组用例上跑，
 * 结论必须逐条一致 —— 一旦哪天 core 改了规则而这里没跟上，单测立刻失败。
 *
 * 补齐工程化后应删除本文件，改为直接从 core 导入。
 */

/** 一次进度更新（与 core 的 JobProgressSnapshot 字段一致） */
export interface ProgressUpdate {
  jobId: string;
  status: string;
  progress: number;
  stage?: string;
  error?: string;
}

/** 合并结论 */
export interface MergeOutcome {
  accepted: boolean;
  /** 拒绝原因，便于排查"为什么界面没动" */
  reason?: 'terminal' | 'regressed' | 'duplicate';
  next: ProgressUpdate;
}

/** 终态：进入后不可再被迟到的消息改写（与 core 的 JOB_TERMINAL_STATUSES 对齐） */
const TERMINAL_STATUSES = ['succeeded', 'failed', 'canceled', 'rejected'];

/**
 * 合并一次更新 —— 保证界面上的进度不倒退（M1-05 验收项）
 *
 * 规则与 core 完全一致，按优先级：
 *   ① 终态不可变；② 进度不倒退；③ 完全重复不触发渲染。
 */
export function mergeProgress(
  prev: ProgressUpdate | undefined,
  incoming: ProgressUpdate,
): MergeOutcome {
  if (!prev) return { accepted: true, next: { ...incoming } };

  if (TERMINAL_STATUSES.indexOf(prev.status) >= 0 && prev.status !== incoming.status) {
    return { accepted: false, reason: 'terminal', next: prev };
  }

  if (incoming.progress < prev.progress) {
    return { accepted: false, reason: 'regressed', next: prev };
  }

  if (
    prev.progress === incoming.progress &&
    prev.status === incoming.status &&
    (prev.stage || '') === (incoming.stage || '')
  ) {
    return { accepted: false, reason: 'duplicate', next: prev };
  }

  return { accepted: true, next: { ...incoming } };
}

/** 是否已到终态（界面据此停止展示进度动画） */
export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.indexOf(status) >= 0;
}
