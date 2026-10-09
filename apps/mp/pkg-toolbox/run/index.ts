/**
 * 工具执行页（文档 5.3.5）
 *
 * 通用设计：表单字段由工具的 inputSchema 动态渲染（不写死每个工具页面）。
 * 覆盖：参数填写 → 费用预估 → 版权声明（涉版权工具）→ 提交 → 进度 → 结果
 */
import type { ToolItem } from '../../utils/api';
import { toolboxApi } from '../../utils/api';
import { failureHint, loadBillingMode, priceText } from '../../utils/billing';
import { API_BASE } from '../../utils/env';
import { formatBytes, pickFile, uploadFile, type PickedFile } from '../../utils/file-transfer';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { getToken, toastError } from '../../utils/request';
import { JobProgressChannel } from '../../utils/ws';

import type { FormField } from './field-presets';
import { FIELD_PRESETS } from './field-presets';
import { schemaToFields } from './schema-to-fields';

Page({
  data: {
    toolName: '',
    tool: null as ToolItem | null,
    /** 工具定义请求进行中：页头/表单用骨架顶上，避免先闪一个空壳页 */
    toolLoading: true,
    /**
     * 用了本地预设兜底时必须说出来（红线 10）：
     * 表单看着"能填"，其实字段定义来自内置预设而非后端工具目录，
     * 参数可能与真实 schema 不一致 —— 不告诉用户就是拿本地假设冒充权威定义。
     */
    presetNotice: '',
    fields: [] as FormField[],
    form: {} as Record<string, string | number | boolean>,
    /** 已选文件（fileId 列表） */
    fileIds: [] as string[],
    /** 已上传文件的展示文案（WXML 不支持 join，这里预拼好） */
    fileNamesText: '',
    /** 涉版权声明勾选（文档 6.7.2） */
    copyrightAck: false,
    /** 费用文案（免费开放期为"限时免费开放中"，由 utils/billing.ts 决定） */
    costLabel: '',
    submitting: false,
    /** 执行中的进度层 */
    running: false,
    progress: 0,
    stage: '',
    jobId: '',
    error: '',
    /** 实时通道是否已连上（false 时界面标注"轮询中"，避免把兜底当实时） */
    realtime: false,
    /** 步骤 chip 的高亮位：1 填写 / 2 执行 / 3 领取（失败停在 2，不假装走完） */
    currentStep: 1,
    /** 用户点了"后台运行"后的回流提示条是否展示 */
    backgrounded: false,
    /** 装饰层视差位移（由 utils/fx.ts 写入） */
    fxStyle: '',
  },

  /** 进度实时通道（非 data，避免被 setData 序列化） */
  channel: null as JobProgressChannel | null,
  /** 轮询定时器 */
  pollTimer: null as ReturnType<typeof setInterval> | null,
  /** 最长跟踪时长定时器（防止页面被遗忘时永久轮询） */
  stopTimer: null as ReturnType<typeof setTimeout> | null,

  onLoad(query: Record<string, string>) {
    const toolName = query.toolName || 'generate_ppt';
    this.setData({ toolName });
    void this.loadTool(toolName);
  },

  onShow() {
    // 真机上开启陀螺仪倾斜视差；开发者工具无传感器时会静默跳过
    fxEnableTilt(this);
  },

  onHide() {
    fxDisableTilt();
  },

  onUnload() {
    fxDisableTilt();
    this.teardown();
  },

  async loadTool(name: string) {
    // 费用文案依赖计费模式：必须先取（已缓存则不发请求），否则会先闪一下价格再变成"限时免费"
    await loadBillingMode();

    try {
      const tool = await toolboxApi.detail(name);
      // 以后端 inputSchema 为准；未声明 schema 的工具回退到本地预设
      const fields = resolveFields(name, tool.inputSchema);

      this.setData({
        tool,
        fields,
        form: buildDefaults(fields),
        costLabel: priceText(tool.price),
        toolLoading: false,
        presetNotice: '',
      });
      wx.setNavigationBarTitle({ title: tool.displayName || '工具执行' });
    } catch {
      // 接口不可用时用内置定义兜底，保证页面可用。
      // 注意：拿不到后端就拿不到标价，这里的 `price: 0` 是"未知"而不是"免费"，
      // 因此费用文案按 0 计算（计费模式下显示"免费"、免费模式下显示免费提示），
      // 真实价格会在提交时由后端按 tool.price 计算 —— 前端不参与计价。
      const fields = FIELD_PRESETS[name] ?? [];
      this.setData({
        tool: {
          name,
          displayName: name,
          categoryId: '',
          description: '',
          price: 0,
          status: 'active',
          sync: false,
          useCount: 0,
          requiresCopyrightAck: false,
        } as ToolItem,
        fields,
        form: buildDefaults(fields),
        costLabel: priceText(0),
        error: '',
        toolLoading: false,
        // 兜底不是"没事发生"：必须把"这不是后端定义"写在表单上方，并给一次重试机会
        presetNotice: fields.length
          ? '工具定义加载失败，当前使用内置表单'
          : '工具定义加载失败，且本地没有该工具的表单，请重试',
      });
    }
  },

  /** 重新拉取工具定义（加载失败时的重试入口：不发骨架，成功时按后端 schema 重建表单） */
  onRetryTool() {
    void this.loadTool(this.data.toolName);
  },

  onFieldInput(e: WechatMiniprogram.Input) {
    const key = e.currentTarget.dataset.key as string;
    this.setData({ [`form.${key}`]: e.detail.value });
  },

  onFieldSelect(e: WechatMiniprogram.PickerChange) {
    const key = e.currentTarget.dataset.key as string;
    const idx = Number(e.detail.value);
    const field = this.data.fields.find((f) => f.key === key);
    const value = field?.options?.[idx]?.value ?? '';
    this.setData({ [`form.${key}`]: value });
  },

  onCopyrightToggle() {
    this.setData({ copyrightAck: !this.data.copyrightAck });
  },

  /** 提交执行 */
  async onSubmit() {
    const { form, fields, toolName, fileIds, copyrightAck, tool } = this.data;

    // 1) 必填校验（前端先校验，避免无意义请求）
    for (const f of fields) {
      if (f.required && !String(form[f.key] ?? '').trim()) {
        wx.showToast({ title: `请填写「${f.label}」`, icon: 'none' });
        return;
      }
    }

    // 2) 涉版权工具强制声明（服务端还会二次校验）
    if (tool?.requiresCopyrightAck && !copyrightAck) {
      wx.showToast({ title: '请先确认版权授权', icon: 'none' });
      return;
    }

    if (this.data.submitting || this.data.toolLoading) return;
    this.setData({ submitting: true, error: '', backgrounded: false });

    try {
      const res = await toolboxApi.invoke(
        toolName,
        form as Record<string, unknown>,
        fileIds,
        copyrightAck,
      );
      this.setData({
        jobId: res.jobId,
        running: true,
        currentStep: 2,
        progress: 0,
        stage: '已提交，正在处理…',
      });
      this.startTracking(res.jobId);
    } catch (e) {
      toastError(e);
      this.setData({ error: (e as Error).message });
    } finally {
      this.setData({ submitting: false });
    }
  },

  /**
   * 开始跟踪作业进度：**WebSocket 优先，轮询兜底**（文档 5.3.2 / 9.3）
   *
   * 两条通道**共用同一套合并规则**（JobProgressChannel.applyLocal），
   * 因此无论消息从哪条路来，"进度不倒退"的保证都成立；
   * 也不会出现"实时说 80%、轮询说 60%"这种两套口径互相打架的情况。
   *
   * 轮询**始终开着**而不是"WS 连上就关"：
   * 小程序切后台会静默断连且不一定触发 onClose，
   * 少了轮询就可能出现"界面停在 60% 但其实早就完成"。
   * 代价只是每 1.5 秒一次轻量 GET，远小于进度停住带来的体验损失。
   */
  startTracking(jobId: string) {
    this.teardown();

    const channel = new JobProgressChannel({
      apiBase: API_BASE,
      accessToken: getToken(),
      onUpdate: (update) => this.onProgress(update),
      onStateChange: (state) => this.setData({ realtime: state === 'open' }),
    });
    this.channel = channel;
    channel.open();
    channel.watch(jobId);

    this.pollJob(jobId);
  },

  /** 进度合并通过后回调（已保证不倒退、终态不会被改写） */
  onProgress(update: { status: string; progress: number; stage?: string; error?: string }) {
    this.setData({
      progress: update.progress,
      stage: update.stage ?? this.data.stage,
    });

    if (update.status === 'succeeded') {
      this.teardown();
      this.setData({ running: false, currentStep: 3 });
      wx.redirectTo({ url: `/pkg-toolbox/result/index?jobId=${this.data.jobId}` });
    } else if (
      update.status === 'failed' ||
      update.status === 'canceled' ||
      update.status === 'rejected'
    ) {
      this.teardown();
      // 失败文案不能写死"积分已退回"：免费开放期压根没扣过积分
      // 步骤条**停在 ②**：任务没走完，把 ③ 点亮就是在冒充完成（红线 10）
      this.setData({ running: false, currentStep: 2, error: update.error || failureHint() });
    }
  },

  /** 轮询兜底（WebSocket 未就绪/已断开时的可靠通道） */
  pollJob(jobId: string) {
    this.pollTimer = setInterval(async () => {
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
        // 忽略单次轮询失败，继续重试
      }
    }, 1500);

    // 兜底：最多轮询 10 分钟
    this.stopTimer = setTimeout(() => this.teardown(), 10 * 60 * 1000);
  },

  /** 停止跟踪（页面卸载、作业终结、超时都会走到这里；可重复调用） */
  teardown() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.pollTimer = null;
    this.stopTimer = null;
    this.channel?.close();
    this.channel = null;
  },

  /**
   * 上传参考资料 / 待处理文件。
   *
   * 以前这里只弹一句"已选择 N 个文件（上传功能待接入）"，而 `fileIds` **始终是空的** ——
   * 用户以为文件已经带上了，提交时其实什么也没带（红线 9 的典型形态）。
   * 现在走真实上传（presign → 直传 → confirm），成功后才把文件 id 记进 `fileIds`。
   */
  async onChooseFile() {
    let picked: PickedFile | null;
    try {
      picked = await pickFile('file');
    } catch (e) {
      toastError(e);
      return;
    }
    if (!picked) return; // 用户取消，不打扰

    wx.showLoading({ title: '上传中…', mask: true });
    try {
      const file = await uploadFile(picked);
      const label = `${file.name}（${formatBytes(file.size)}）`;
      const names = this.data.fileNamesText ? `${this.data.fileNamesText}、${label}` : label;
      this.setData({ fileIds: [...this.data.fileIds, file.id], fileNamesText: names });
      wx.showToast({ title: '上传成功', icon: 'success' });
    } catch (e) {
      toastError(e);
    } finally {
      wx.hideLoading();
    }
  },

  /**
   * 「后台运行」：只是离开进度层，**作业仍在服务端跑**。
   *
   * 以前这里关掉浮层就回到空白表单，看起来像"任务被我取消了"，
   * 而实际上它还在排队执行。取消后必须留下一条回流入口（有 jobId 时），
   * 否则用户再也找不回这次任务。
   */
  onCancelRun() {
    this.teardown();
    const hasJob = Boolean(this.data.jobId);
    this.setData({ running: false, backgrounded: hasJob, currentStep: hasJob ? 2 : 1 });
    if (hasJob) wx.showToast({ title: '已转后台执行', icon: 'none' });
  },

  /** 回流：去结果页看这条后台执行的作业 */
  onGoResult() {
    const { jobId } = this.data;
    if (!jobId) {
      this.setData({ backgrounded: false });
      return;
    }
    wx.navigateTo({ url: `/pkg-toolbox/result/index?jobId=${jobId}` });
  },

  /** 关掉"后台执行中"的回流提示条（用户确认知道了） */
  onDismissBackground() {
    this.setData({ backgrounded: false });
  },

  /** 关闭错误提示（纯展示态，不影响业务） */
  onCloseError() {
    this.setData({ error: '' });
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
});

/**
 * 决定用哪套字段定义：后端 inputSchema 优先，为空时回退本地预设。
 * 抽成函数是为了让"以后端为准"这条约定有明确落点，而不是散在 loadTool 里。
 */
function resolveFields(name: string, schema: unknown): FormField[] {
  const fromSchema = schemaToFields(schema);
  return fromSchema.length > 0 ? fromSchema : (FIELD_PRESETS[name] ?? []);
}

/** 用字段默认值初始化表单 */
function buildDefaults(fields: FormField[]): Record<string, string | number | boolean> {
  const form: Record<string, string | number | boolean> = {};
  for (const f of fields) if (f.default !== undefined) form[f.key] = f.default;
  return form;
}
