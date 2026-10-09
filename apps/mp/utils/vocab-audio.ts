/**
 * 单词发音的播放器（记单词 M4-15）
 *
 * ## 为什么要"落临时文件"这一步
 *
 * 后端返回的是 **base64**（全局 `TransformInterceptor` 会把所有响应包成
 * `{code,message,data,traceId}`，二进制流经它会被序列化成乱码 —— 项目里没有
 * 任何 `StreamableFile` 用法）。而 `InnerAudioContext.src` 只吃**文件路径或 URL**，
 * 不认 data URI。所以先 `writeFile({encoding:'base64'})` 落到沙箱，
 * 再交给播放器 —— 这一步不能省。
 *
 * ## 缓存
 *
 * 同一个单词（同音色）反复听是常态。命中缓存时**不重复写盘**，
 * 直接把已有文件路径交给播放器。缓存只活在本次小程序生命周期里，
 * 且按 key 覆盖写同一个路径 —— 不会越攒越多（沙箱容量有限）。
 *
 * ## 与文件转发页的区别
 *
 * `file-transfer.ts` 播的是**用户自己的产物**（有文件名、可转发）；
 * 这里播的是即时合成的一小段发音，属于界面反馈，不落"我的文件"、
 * 也不进转发面板。
 */

/** key（`wordId:voice`）→ 沙箱内路径 */
const fileCache = new Map<string, string>();

let player: WechatMiniprogram.InnerAudioContext | null = null;
/** 正在播放的 key；再点一次同一个词 = 停止（与文件页的试听同一套交互） */
let playingKey = '';

export function stopWordAudio(): void {
  playingKey = '';
  if (!player) return;
  player.stop();
  player.destroy();
  player = null;
}

/**
 * 播放一段单词发音。
 *
 * @param key    去重键，建议 `wordId:voice` —— 同一个词不同音色要分别缓存
 * @param base64 后端给的音频数据
 * @param format `mp3` / `wav`：决定落盘扩展名。**必须用后端返回的**，
 *               猜错会让播放器打不开文件（Mock 产出 WAV、真实链路产出 mp3）
 */
export async function playWordAudio(key: string, base64: string, format: string): Promise<void> {
  // 再点一次同一个词 = 停止，而不是从头再播一遍
  if (playingKey === key) {
    stopWordAudio();
    return;
  }
  stopWordAudio();

  const path = await ensureFile(key, base64, format);
  await new Promise<void>((resolve, reject) => {
    const ctx = wx.createInnerAudioContext();
    // iOS 静音物理键不该让"点喇叭"变成静默失败（失败还会误报"打不开"）
    ctx.obeyMuteSwitch = false;
    ctx.src = path;

    ctx.onPlay(() => {
      player = ctx;
      playingKey = key;
      resolve();
    });
    const fail = (msg: string) => {
      stopWordAudio();
      // 文件可能被系统清理掉了：清掉缓存让下一次重新写盘，而不是一直播不出来
      fileCache.delete(key);
      reject(new Error(msg));
    };
    ctx.onError((e) => fail(e.errMsg || '播放失败'));
  });
}

/** 命中缓存直接用；否则写盘（同一 key 永远写同一个路径） */
function ensureFile(key: string, base64: string, format: string): Promise<string> {
  const hit = fileCache.get(key);
  if (hit) return Promise.resolve(hit);

  const path = `${wx.env.USER_DATA_PATH}/vocab-tts-${safeName(key)}.${format}`;
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({
      filePath: path,
      data: base64,
      encoding: 'base64',
      success: () => {
        fileCache.set(key, path);
        resolve(path);
      },
      fail: (e) => reject(new Error(e.errMsg || '发音文件写入失败')),
    });
  });
}

/** key 里出现 `/` 或 `:` 会让路径变成子目录（写盘直接失败），统一替换掉 */
function safeName(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '_');
}