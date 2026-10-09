/**
 * 录音（练习中心 · 口语跟读 M4-16）
 *
 * ## 为什么单独成文件而不是写在页面里
 *
 * `RecorderManager` **是全局单例**（`wx.getRecorderManager()` 每次返回同一个对象），
 * 一旦 `onStop` 里挂的回调没解绑，下次录音结束会触发**上一次的回调** ——
 * 表现是"录第二句时界面弹的是第一句的结果"，而且刷新页面才好。
 * 把生命周期收在一处（本文件）是唯一能保证"每次录音只被处理一次"的写法。
 *
 * ## 两个必须踩准的点
 *
 * ① **`onStop` 会带 `tempFilePath`，但读文件是异步的**。录音结束后文件还在写盘，
 *    立刻读偶尔会读到不完整的内容 —— 所以读文件失败时**必须报出来**，
 *    不能静默当成"没听清"（那会让用户以为是自己发音的问题）。
 *
 * ② **`readFile({encoding:'base64'})` 返回的字符串不带 `data:` 前缀**
 *    （官方文档没写，实测如此）。后端 `decodeAudio()` 兼容两种形式，
 *    但这里不再手工加前缀 —— 多一层拼接就多一处可能拼错。
 */

/** 录音的最短时长（毫秒）。太短的录音在服务端会被拦（`MIN_AUDIO_BYTES`），先在客户端提示更友好 */
export const MIN_RECORD_MS = 800;

/** 录音的最长时长（毫秒）。60 秒足够读完任何一句，超时自动停 */
export const MAX_RECORD_MS = 60000;

/**
 * 请求的录音容器格式。
 *
 * ⚠️ 必须是常量而不是从 `onStop` 的结果里读：`OnStopListenerResult` 只有
 * `tempFilePath` / `duration` / `fileSize`，**没有 `format`**
 * （读它拿到 undefined，落盘扩展名会变成 `undefined`）。
 * 我们 `start()` 时声明什么，拿到的就是什么。
 */
const FORMAT = 'mp3';

/** 一次录音的结果 */
export interface RecordResult {
  /** base64（**不带 `data:` 前缀**） */
  base64: string;
  /** 时长（毫秒） */
  duration: number;
  /** 落盘扩展名：`mp3` / `aac`。与 `format` 保持一致 */
  format: string;
}

/** 是否支持录音（不支持时界面要**明说**，而不是给一个点了没反应的按钮） */
export function canRecord(): boolean {
  return typeof wx.getRecorderManager === 'function';
}

/**
 * 录音会话。一个实例对应"按住说话"的一次完整交互。
 *
 * 用法：`const s = createRecorder(); s.start(); await s.stop();`
 * `stop()` 之后实例即作废（**不要复用**）——复用会让两段录音的回调互相串。
 */
export interface RecorderSession {
  start(): void;
  stop(): Promise<RecordResult>;
  /** 用户松手前取消（点击取消 / 划走），不产生结果也不报错 */
  cancel(): void;
  /** 录音是否已经开始（`start()` 到 `onStart` 之间有延迟，用这个判断能不能 `stop()`） */
  isStarted(): boolean;
}

/**
 * 一次录音的可变状态。
 *
 * 抽成对象是为了让 `createRecorder` 本身只负责"接线"（挂回调、调 API），
 * 而不是把六个可变变量摊在同一个作用域里 —— 那种写法下任何一处改动
 * 都要通读整段才能确认没碰坏别的分支。
 */
interface RecState {
  started: boolean;
  cancelled: boolean;
  beginAt: number;
  resolve: ((r: RecordResult) => void) | null;
  reject: ((e: Error) => void) | null;
}

export function createRecorder(): RecorderSession {
  const mgr = wx.getRecorderManager();
  const st: RecState = { started: false, cancelled: false, beginAt: 0, resolve: null, reject: null };

  /**
   * 解绑全部回调。
   *
   * ⚠️ RecorderManager 是**全局单例**：不清理就会让上一次录音的回调
   * 在下一次录音结束时再跑一遍（表现是"读第二句时弹的是第一句的结果"）。
   * 微信没有提供"解绑"API，覆盖成空函数是唯一做法。
   */
  const cleanup = () => {
    mgr.onStop(() => undefined);
    mgr.onError(() => undefined);
    mgr.onStart(() => undefined);
    st.started = false;
    st.resolve = null;
    st.reject = null;
  };

  /** 结算：先回调、再清理（顺序反了会拿不到回调） */
  const settle = (fn: (() => void) | null) => {
    if (fn) fn();
    cleanup();
  };

  /** `onStop`：把临时文件读成 base64 再结算 */
  const handleStop = (tempFilePath: string) => {
    const duration = Date.now() - st.beginAt;
    if (st.cancelled) {
      settle(() => st.reject?.(new Error(CANCELLED)));
      return;
    }
    void readAsBase64(tempFilePath)
      .then((base64) => {
        // ⚠️ `OnStopListenerResult` 里**没有** `format` 字段（类型定义如此），
        // 所以格式取 `start()` 时声明的那个。不要写成 `res.format`：
        // 那是 undefined，落盘扩展名会变成 `undefined`，两端都解不开。
        settle(() => st.resolve?.({ base64, duration, format: normalizeFormat(FORMAT) }));
      })
      .catch((err: Error) => settle(() => st.reject?.(err)));
  };

  /** `onError`：权限被拒是最常见的失败，**必须说出来**（否则是"按住没反应"） */
  const handleError = (errMsg: string) => {
    const hint = /auth|permission|deny/i.test(errMsg)
      ? '需要麦克风权限，请在右上角「…」→ 设置里打开'
      : errMsg || '录音失败，请重试';
    settle(() => st.reject?.(new Error(hint)));
  };

  /** 挂回调并开始录音 */
  const begin = () => {
    st.cancelled = false;
    st.beginAt = Date.now();
    mgr.onStart(() => {
      st.started = true;
    });
    mgr.onError((e: { errMsg?: string }) => handleError(e.errMsg ?? ''));
    mgr.onStop((res) => handleStop(res.tempFilePath));
    mgr.start(RECORD_OPTIONS);
  };

  return buildSession(mgr, st, cleanup, begin);
}

/**
 * 录音参数。
 *
 * ⚠️ 用 mp3：后端把音频原样转给 ASR，mp3 是兼容性最好的容器。
 * `duration` 给到上限，超时微信会自动停并照常触发 `onStop`。
 */
const RECORD_OPTIONS: WechatMiniprogram.RecorderManagerStartOption = {
  duration: MAX_RECORD_MS,
  sampleRate: 16000,
  numberOfChannels: 1,
  encodeBitRate: 48000,
  format: FORMAT,
};

/**
 * 组装会话对象。
 *
 * 与 `createRecorder` 分开只是为了让两个函数各自都在 50 行以内
 * （`init` 那半段是"挂回调"，这半段是"暴露三个动作"，本来也是两件事）。
 */
function buildSession(
  mgr: WechatMiniprogram.RecorderManager,
  st: RecState,
  cleanup: () => void,
  begin: () => void,
): RecorderSession {
  return {
    start: begin,

    stop() {
      return new Promise<RecordResult>((resolve, reject) => {
        st.resolve = resolve;
        st.reject = reject;
        if (!st.started) {
          // `start()` 之后 `onStart` 之前就松手（比如一闪而过的点击）：
          // 此时调 `stop()` 在部分机型上不触发 `onStop`，会永久挂住。
          // 直接按"取消"处理，让界面给出可理解的提示。
          cleanup();
          reject(new Error(CANCELLED));
          return;
        }
        mgr.stop();
      });
    },

    cancel() {
      st.cancelled = true;
      if (st.started) mgr.stop();
      else cleanup();
    },

    isStarted() {
      return st.started;
    },
  };
}

/** 用户主动取消（与"录音失败"区分开：取消不该弹错误提示） */
export const CANCELLED = 'CANCELLED';

/** 录音太短（单独一个错误类型，界面要提示"再读长一点"而不是"失败"） */
export const TOO_SHORT = 'TOO_SHORT';

/**
 * 读临时文件为 base64。
 *
 * ⚠️ 返回值**不带 `data:` 前缀**（实测），后端 `decodeAudio()` 两种都认。
 * 这里不做任何拼接 —— 多一层拼接就多一处可能拼错的地方。
 */
function readAsBase64(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!path) {
      reject(new Error('没有拿到录音文件，请重试'));
      return;
    }
    wx.getFileSystemManager().readFile({
      filePath: path,
      encoding: 'base64',
      success: (res) => {
        const data = typeof res.data === 'string' ? res.data : '';
        if (!data) {
          reject(new Error('录音内容为空，请按住按钮再读一次'));
          return;
        }
        resolve(data);
      },
      fail: (e) => reject(new Error(e.errMsg || '录音文件读取失败，请重试')),
    });
  });
}

/** 录音格式归一：少数机型返回 `aac`，扩名要与之一致（猜错会让服务端解不开） */
function normalizeFormat(format: string): string {
  return format === 'aac' ? 'aac' : 'mp3';
}
