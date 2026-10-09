/**
 * 执行结果页（文档 5.3.6）
 *
 * 关键设计：必须提供"下一步"（AI 继续做 / 转真人做）。
 * 这是 AI 工具箱 → 青智 OS → 青智驿站 串起来的核心转化位。
 *
 * ## 本页也会跟踪进度
 *
 * 从执行页 `redirectTo` 过来时作业**未必已经跑完**，从执行记录或同学转发的
 * 链接进来时更可能还在排队。以前本页只拉一次 `GET /jobs/:id`，
 * 于是"处理中"永远停在原地 —— 现在与执行页同口径：非终态时 WebSocket 优先、
 * 轮询兜底，合并规则共用 `utils/progress.ts`（进度不倒退、终态不被改写）。
 *
 * 纯展示映射（状态图标 / 产物图标 / 下一步出口）在 `./presenters.ts`。
 */
import type { JobItem } from '../../utils/api';
import { toolboxApi } from '../../utils/api';
import { costText, failureHint, loadBillingMode } from '../../utils/billing';
import { API_BASE } from '../../utils/env';
import { downloadToLocal, isPlayableMedia, openLocalFile, stopAudio } from '../../utils/file-transfer';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { openOs } from '../../utils/nav';
import { isTerminal, type ProgressUpdate } from '../../utils/progress';
import { getToken, toastError } from '../../utils/request';
import { JobProgressChannel } from '../../utils/ws';

import {
  type MetricRow,
  type NextStep,
  type OutFile,
  STATUS_FALLBACK,
  STATUS_MAP,
  metricRows,
  nextStepsFor,
  pickOne,
  qualityLabel,
  resolveOutFiles,
} from './presenters';

/** 质量档位 → 界面字段。无分（非 AI 工具）时两个字段都清空，不显示空档位 */
function qualityFields(job: JobItem) {
  const q = qualityLabel(job.qualityScore);
  return { qualityText: q?.text ?? '', qualityWarn: q?.warn ?? false };
}

/** 状态 → 界面字段（页头图标 + 两行文案） */
function statusFields(s: { icon: string; title: string; sub: string }, status: string) {
  return {
    statusIcon: s.icon,
    statusTitle: s.title,
    // 失败文案不能写死"积分已退回"：免费开放期压根没扣过积分
    statusSub: status === 'failed' ? failureHint() : s.sub,
  };
}

Page({
  data: {
    jobId: '',
    job: null as JobItem | null,
    loading: true,
    error: '',
    nextSteps: [] as (NextStep & { iconClass: string })[],
    /** 是否需要版权声明提示（涉版权工具） */
    showCopyrightTip: false,
    /** 以下均为纯展示字段 */
    statusIcon: 'qz-i-clock',
    statusTitle: '处理中',
    statusSub: '',
    /** 费用文案：免费开放期显示"本次免费"，不能写死"消耗 N 积分" */
    costLabel: '',
    outFiles: [] as OutFile[],
    /** 产出指标（体积/尺寸/时长/页数…）：让用户直接看到"这次产出好不好" */
    metricRows: [] as MetricRow[],
    /** AI 产出的质量档位（非 AI 工具为空） */
    qualityText: '',
    /** 质量是否需要注意（及格/待改进时为 true，用于换色） */
    qualityWarn: false,
    /** 主按钮文案：随第一个产物类型在"打开/播放"间切换 */
    openLabel: '打开',
    /** 作业还没跑完（本页正在跟踪）：此时不给下载/分享入口 */
    tracking: false,
    progress: 0,
    stage: '',
    /** 实时通道是否连上（false 时标注"轮询同步"，不把兜底当实时） */
    realtime: false,
    /** 装饰层视差位移（由 utils/fx.ts 写入） */
    fxStyle: '',
  },

  channel: null as JobProgressChannel | null,
  pollTimer: null as ReturnType<typeof setInterval> | null,
  stopTimer: null as ReturnType<typeof setTimeout> | null,

  onLoad(query: Record<string, string>) {
    const jobId = query.jobId || '';
    this.setData({ jobId });
    void this.loadJob(jobId);
  },

  onShow() {
    fxEnableTilt(this);
    // 从后台回来时 WS 多半已经断了，按权威状态重新拉起跟踪
    this.syncTracking(this.data.job);
  },

  onHide() {
    fxDisableTilt();
    this.stopTracking();
    stopAudio();
  },

  onUnload() {
    fxDisableTilt();
    this.stopTracking();
    stopAudio();
  },

  onPullDownRefresh() {
    void this.loadJob(this.data.jobId).finally(() => wx.stopPullDownRefresh());
  },

  async loadJob(jobId: string) {
    if (!jobId) {
      // 没带 jobId 不是"出错"，而是"这条任务不在你面前"——交给空态说清楚
      this.setData({ loading: false, job: null, error: '' });
      return;
    }

    try {
      await loadBillingMode();
      const job = await toolboxApi.job(jobId);
      const outs = await resolveOutFiles(job.outputFiles ?? []);
      this.setData({
        job,
        loading: false,
        error: '',
        ...statusFields(STATUS_MAP[job.status] ?? STATUS_FALLBACK, job.status),
        costLabel: costText(job.cost),
        outFiles: outs,
        // 主按钮跟着第一个产物的类型走：音频/视频说"播放"，其余说"打开"
        openLabel: outs.length && isPlayableMedia(outs[0]!.name) ? '播放' : '打开',
        nextSteps: nextStepsFor(job),
        metricRows: metricRows(job),
        ...qualityFields(job),
        showCopyrightTip: job.toolName.includes('repair') || job.toolName.includes('watermark'),
      });
      this.syncTracking(job);
    } catch (e) {
      this.setData({ loading: false, error: (e as Error).message || '结果加载失败' });
    }
  },

  /* ---------- 进度跟踪（与执行页同一套双通道口径） ---------- */

  /** 非终态才跟踪；终态一律停表，不占着连接 */
  syncTracking(job: JobItem | null) {
    if (!job || isTerminal(job.status)) {
      this.stopTracking();
      return;
    }
    this.startTracking(job);
  },

  startTracking(job: JobItem) {
    const { jobId } = this.data;
    if (!jobId || this.channel) return;

    const channel = new JobProgressChannel({
      apiBase: API_BASE,
      accessToken: getToken(),
      onUpdate: (update) => this.onProgress(update),
      onStateChange: (state) => this.setData({ realtime: state === 'open' }),
    });
    this.channel = channel;
    // 先把当前权威值喂进合并器：否则服务端那份旧快照会把界面进度往回拽
    channel.applyLocal({
      jobId,
      status: job.status,
      progress: job.progress ?? 0,
      stage: job.stage,
      error: job.error,
    });
    channel.open();
    channel.watch(jobId);

    this.setData({
      tracking: true,
      progress: job.progress ?? 0,
      // stage 由服务端给；没给就按状态说一句事实，不编"正在生成 PPT 第 3 页"这种细节
      stage: job.stage ?? (job.status === 'running' ? '已开始执行' : '等待执行'),
    });

    // 轮询始终开着而不是"WS 连上就关"：小程序切后台会静默断连且不一定触发 onClose
    this.pollTimer = setInterval(() => void this.pollOnce(), 3000);
    this.stopTimer = setTimeout(() => this.stopTracking(), 10 * 60 * 1000);
  },

  async pollOnce() {
    const { jobId } = this.data;
    try {
      const job = await toolboxApi.job(jobId);
      // 走同一个合并入口：轮询结果同样受"不倒退"约束
      this.channel?.applyLocal({
        jobId,
        status: job.status,
        progress: job.progress ?? 0,
        stage: job.stage,
        error: job.error,
      });
    } catch {
      // 单次轮询失败不弹红字：连接抖动是常态，终态由下一次成功拉取给出
    }
  },

  /** 合并通过后回调（已保证不倒退、终态不被改写） */
  onProgress(update: ProgressUpdate) {
    if (isTerminal(update.status)) {
      // 终态不自己拼界面：重拉一次权威结果，产物 / 费用 / 下一步一起补齐
      this.stopTracking();
      void this.loadJob(this.data.jobId);
      return;
    }
    this.setData({
      progress: update.progress,
      stage: update.stage ?? this.data.stage,
      ...statusFields(STATUS_MAP[update.status] ?? STATUS_FALLBACK, update.status),
    });
  },

  /** 停止跟踪（可重复调用） */
  stopTracking() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.pollTimer = null;
    this.stopTimer = null;
    this.channel?.close();
    this.channel = null;
    if (this.data.tracking) this.setData({ tracking: false, realtime: false });
  },

  /* ---------- 产物动作 ---------- */

  /**
   * 下载产物到小程序本地文件系统。
   *
   * 产物的 id 就是文件资产 id，所以直接复用"我的文件"那套下载链路
   * （签发地址 → downloadFile → 存进用户目录 → 打开），
   * 而不是弹一句"需接入签名 URL（M1-13）"就结束。
   */
  async onDownload() {
    const out = this.data.outFiles;
    if (!out.length) {
      wx.showToast({ title: '暂无可打开的文件', icon: 'none' });
      return;
    }

    // 小程序没有"批量下载"：多个产物时让用户挑，而不是静默只下第一个
    const index = out.length === 1 ? 0 : await pickOne(out.map((f) => f.name));
    if (index === null) return;
    const target = out[index];
    if (!target) return;

    wx.showLoading({ title: '打开中…', mask: true });
    try {
      const path = await downloadToLocal(target.key, target.name);
      wx.hideLoading();
      const hint = await openLocalFile(path, target.name);
      if (hint) wx.showToast({ title: hint, icon: 'none', duration: 3000 });
    } catch (e) {
      wx.hideLoading();
      toastError(e);
    }
  },

  /**
   * "保存到我的文件"。
   *
   * 产物在后端生成时就已落进文件资产（`FileService.saveGenerated`），
   * 所以这里不需要再"保存"一次 —— 把用户带到文件页即可，
   * 而不是弹一句"已保存"却什么都没发生。
   */
  onSaveToFiles() {
    wx.navigateTo({ url: '/pkg-toolbox/files/index' });
  },

  /** 用 AI 修改（回到 AI 页，带上上下文）。AI 页是 tabBar 页，须走 openOs */
  onReviseWithAi() {
    openOs(`帮我修改刚生成的${this.data.job?.toolName ?? ''}结果`);
  },

  /** 空态兜底：任务不存在 / 无权查看时给一条去处（工具箱是 tabBar 页，必须 switchTab） */
  onGoToolbox() {
    wx.switchTab({ url: '/pages/toolbox/index' });
  },

  /** 下一步（核心转化位） */
  onNextStep(e: WechatMiniprogram.TouchEvent) {
    const { kind, target, query } = e.currentTarget.dataset as {
      kind: string;
      target?: string;
      query?: string;
    };

    if (kind === 'os') {
      openOs(query ?? '');
      return;
    }
    if (kind === 'station') {
      wx.navigateTo({ url: '/pkg-station/publish/index?source=result' });
      return;
    }
    if (kind === 'tool' && target) {
      wx.navigateTo({ url: `/pkg-toolbox/run/index?toolName=${target}` });
    }
  },

  onRetry() {
    void this.loadJob(this.data.jobId);
  },

  onRegenerate() {
    const toolName = this.data.job?.toolName;
    if (toolName) wx.redirectTo({ url: `/pkg-toolbox/run/index?toolName=${toolName}` });
  },

  /* ---------- 指针视差（装饰层动，内容不动） ---------- */
  onFxStart(e: WechatMiniprogram.TouchEvent) {
    fxStart(this, e);
  },
  onFxMove(e: WechatMiniprogram.TouchEvent) {
    fxMove(this, e);
  },
  onFxEnd() {
    fxEnd(this);
  },

  /** 真正的分享：标题带任务名，path 回本页（对方打开看到的是产物或"无权查看"空态） */
  onShareAppMessage() {
    const { jobId, job } = this.data;
    return {
      title: `我用「${job?.toolName ?? 'AI 工具'}」生成了结果，你看看`,
      path: jobId ? `/pkg-toolbox/result/index?jobId=${jobId}` : '/pages/toolbox/index',
    };
  },
});
