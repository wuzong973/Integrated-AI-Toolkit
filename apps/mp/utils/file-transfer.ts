/**
 * 文件上传 / 下载（文件资产中心的客户端通道，任务清单 M1-13）
 *
 * ## 为什么需要这个模块
 *
 * 后端的整条链路**其实早就实现了**：
 *   · 上传：`POST /files/presign` → 直传 → `POST /files/confirm`（`FileService`）
 *   · 直传端点：`PUT /files/local/:token`（本地驱动，`LocalStorageController`）
 *   · 下载：`GET /files/:id/download` 签发短时效地址
 * 缺的只是小程序这一侧 —— 所以界面上的"上传 / 下载"以前只能弹一句
 * "待接入 M1-13"，用户看到的是一个永远不会做事的按钮。本模块把这一侧补齐。
 *
 * ## 上传为什么用 `wx.request`(PUT) 而不是 `wx.uploadFile`
 *
 * 直传地址要求 **PUT**（本地驱动是 `/files/local/:token`，切到 COS 后是对象存储的
 * `PUT` 地址），而 `wx.uploadFile` 只会发 POST + multipart。因此这里把文件读成
 * ArrayBuffer 后用 `wx.request` 发原始字节。
 *
 * 代价是文件必须整个读进内存，所以设了 `DIRECT_UPLOAD_LIMIT`（10MB）：
 * 超限时**明确告知暂不支持**，而不是让用户等到内存爆掉或卡死。
 * 这是**传输能力**限制，不是业务规则 —— 业务上的类型/大小上限（图片 20MB、
 * 视频 500MB 等）在服务端 `checkFileSize` 校验，前端不重复实现一份，
 * 免得两处规则漂移。
 *
 * ## 下载：签名 URL → 小程序本地文件系统
 *
 * 小程序没有"另存为"，能落地的位置只有本地文件系统（`wx.env.USER_DATA_PATH`）。
 * 流程：签发地址 → `wx.downloadFile` 到临时目录 → `saveFile` 到用户目录 → 打开。
 * 存下来之后**不再依赖签名地址的有效期**，同一次会话内可反复打开。
 */

import type { FileItem, UploadScene } from './api';
import { fileApi } from './api';

/** 可选文件的来源 */
export type PickKind = 'file' | 'image' | 'camera';

/** 用户选中的本地文件 */
export interface PickedFile {
  /** 本地临时路径 */
  path: string;
  name: string;
  size: number;
}

/**
 * 直传上限。
 *
 * 不是"业务允许的最大文件"，而是"能塞进一次 `wx.request` 的字节数"。
 * 超过这个体积应当走分片上传（尚未实现），这里如实拒绝而不是假装成功。
 */
const DIRECT_UPLOAD_LIMIT = 10 * 1024 * 1024;

/** 扩展名 → MIME（只覆盖平台允许的类型，见 packages/core 的 EXT_TO_KIND） */
const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
};

/** 能直接预览的图片格式 */
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'];
/** 音频（人声分离/音频工具的产物）：沙箱内用 InnerAudioContext 直接播 */
const AUDIO_EXTS = ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg'];
/** 视频：previewMedia 支持本地路径 */
const VIDEO_EXTS = ['mp4', 'mov', 'webm'];

/** 系统预览器打不开、但可以当文本读出来的格式 */
const TEXT_EXTS = ['txt', 'md', 'csv', 'json'];

/** 这个文件是"播"的还是"看"的？给入口文案用（音频/视频 → 播放） */
export function isPlayableMedia(name: string): boolean {
  const ext = extOf(name);
  return AUDIO_EXTS.includes(ext) || VIDEO_EXTS.includes(ext);
}

/* ------------------------------ 选择文件 ------------------------------ */

/**
 * 调起系统选择器。
 *
 * 用户主动取消时返回 `null`（而不是抛错）—— 取消是正常操作，
 * 弹一个"选择失败"的红字提示才是真的打扰人。
 */
export function pickFile(kind: PickKind): Promise<PickedFile | null> {
  return new Promise((resolve, reject) => {
    const onFail = (e: { errMsg?: string }) => {
      if (isCancel(e)) resolve(null);
      else reject(new Error(e.errMsg || '打开选择器失败'));
    };

    if (kind === 'file') {
      // 「文件」= 从聊天记录里选（小程序唯一能拿到"任意文件"的入口）
      wx.chooseMessageFile({
        count: 1,
        type: 'file',
        success: (res) => {
          const f = res.tempFiles[0];
          resolve(f ? { path: f.path, name: f.name, size: f.size } : null);
        },
        fail: onFail,
      });
      return;
    }

    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      // 「相机」直出、「图片」走相册，是两个不同的按钮而不是同一个
      sourceType: [kind === 'camera' ? 'camera' : 'album'],
      // 上传素材要原图：压缩版会丢细节，且用户没法感知"被压过"
      sizeType: ['original'],
      success: (res) => {
        const f = res.tempFiles[0];
        if (!f) {
          resolve(null);
          return;
        }
        resolve({ path: f.tempFilePath, name: nameFromPath(f.tempFilePath), size: f.size });
      },
      fail: onFail,
    });
  });
}

/* ------------------------------ 上传 ------------------------------ */

/** 上传一个本地文件，返回落库后的文件记录 */
export async function uploadFile(
  picked: PickedFile,
  scene: UploadScene = 'uploaded',
): Promise<FileItem> {
  if (picked.size > DIRECT_UPLOAD_LIMIT) {
    throw new Error(
      `超过 ${DIRECT_UPLOAD_LIMIT / 1024 / 1024}MB 的文件暂不支持直接上传，请先压缩`,
    );
  }

  const contentType = mimeOf(picked.name);
  const presign = await fileApi.presign({
    filename: picked.name,
    size: picked.size,
    contentType,
    scene,
  });

  await putBinary(presign.uploadUrl, await readArrayBuffer(picked.path), contentType);

  // 确认后才产生记录：对象没落盘就不会出现"有记录没文件"的脏数据
  return fileApi.confirm({
    objectKey: presign.objectKey,
    filename: picked.name,
    size: picked.size,
    scene,
  });
}

/**
 * 从**微信给的临时路径**上传（头像昵称填写能力 `open-type="chooseAvatar"` 只给路径）。
 *
 * 与 `pickFile` 的区别：`chooseAvatar` 不经过系统选择器，回调里既没有文件名也没有大小，
 * 只能自己去 stat 一次 —— size 必须先拿到，因为 `presign` 要它做大小与配额校验，
 * 少了这一步会变成"文件传上去了、库里没记录"。
 * 文件名沿用 `nameFromPath` 的兜底规则（取不到扩展名时按 jpg 处理）。
 */
export async function uploadFromTempPath(
  tempPath: string,
  scene: UploadScene,
): Promise<FileItem> {
  const size = await statTempFile(tempPath);
  return uploadFile({ path: tempPath, name: nameFromPath(tempPath), size }, scene);
}

function statTempFile(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().getFileInfo({
      filePath,
      success: (res) => resolve(res.size),
      fail: (e) => reject(new Error(e.errMsg || '读取所选图片失败，请重新选一张')),
    });
  });
}

/* ------------------------------ 下载 ------------------------------ */

/**
 * 把文件下载到小程序本地文件系统。
 *
 * @returns 本地绝对路径（`wx.env.USER_DATA_PATH` 下）
 */
export async function downloadToLocal(fileId: string, name: string): Promise<string> {
  const { url } = await fileApi.download(fileId);
  const tempFilePath = await downloadFile(url);
  return saveToUserDir(tempFilePath, name);
}

/**
 * 打开已保存在本地的文件。
 *
 * 分流规则（按"系统能不能直接打开"来定）：
 *   · 图片 → `previewImage`，长按可存相册
 *   · 文本（md / txt / csv / json）→ 跳**文本预览页**。
 *     系统预览器打不开这些格式，以前只弹一句"内容已复制到剪贴板" ——
 *     用户既看不到内容，也不知道文件到底存哪了。
 *   · 其余文档 → `openDocument`（右上角"…"里可转发 / 用其他应用打开）
 *
 * ⚠️ 预览页在 `pkg-toolbox` 分包内，因此本函数目前只服务于该分包下的页面。
 *
 * @returns 需要额外告知用户的说明；`null` 表示已打开或已跳转，不必再提示
 */
export async function openLocalFile(filePath: string, name: string): Promise<string | null> {
  const ext = extOf(name);

  if (IMAGE_EXTS.includes(ext)) {
    wx.previewImage({ urls: [filePath] });
    return null;
  }

  if (VIDEO_EXTS.includes(ext)) {
    wx.previewMedia({ sources: [{ url: filePath, type: 'video' }] });
    return null;
  }

  if (AUDIO_EXTS.includes(ext)) return playAudio(filePath, name);

  if (TEXT_EXTS.includes(ext)) {
    wx.navigateTo({
      url: `/pkg-toolbox/text/index?path=${encodeURIComponent(filePath)}&name=${encodeURIComponent(name)}`,
    });
    return null;
  }

  if (await tryOpenDocument(filePath)) return null;
  return '该格式无法直接预览，可用「转发文件」导出';
}

/**
 * 沙箱内播放音频。同一文件**再点一次 = 停止**。
 *
 * 用 InnerAudioContext 而不是 BackgroundAudioManager：后者要求声明
 * `requiredBackgroundModes` 且 src 需为网络地址，为一个"试听一下"的场景
 * 拉全局后台播放权限不值得。代价是切后台/退出小程序即停 —— 用户要长时间
 * 听请「转发文件」到聊天里用系统播放器，这是如实的能力边界。
 */
let audioPlayer: WechatMiniprogram.InnerAudioContext | null = null;
let playingPath = '';

function playAudio(filePath: string, name: string): Promise<string> {
  if (playingPath === filePath && audioPlayer) {
    stopAudio();
    return Promise.resolve(`已停止播放「${name}」`);
  }
  stopAudio();
  return new Promise((resolve) => {
    const ctx = wx.createInnerAudioContext();
    // iOS 静音物理键不该让"点击播放"变成静默失败（失败还会误报"打不开"）
    ctx.obeyMuteSwitch = false;
    ctx.src = filePath;
    ctx.onPlay(() => {
      audioPlayer = ctx;
      playingPath = filePath;
      resolve(`正在播放「${name}」，再点一次停止`);
    });
    const done = (msg: string) => {
      stopAudio();
      resolve(msg);
    };
    ctx.onEnded(() => done(`「${name}」播放完毕`));
    ctx.onError(() => done('播放器无法打开该音频，请用「转发文件」导出后播放'));
    ctx.play();
  });
}

function stopAudio(): void {
  if (audioPlayer) {
    audioPlayer.destroy();
    audioPlayer = null;
    playingPath = '';
  }
}
/** 页面 onUnload/onHide 调用：离开当前页就停掉试听，别留一段幽灵音在后台 */
export { stopAudio };

/**
 * 把文件转发给微信好友。
 *
 * ## 为什么需要它
 *
 * 小程序**没有**"另存为 / 选择本地文件夹"这种能力 —— 文件只能落在自己的沙箱
 *（`wx.env.USER_DATA_PATH`）。转发到聊天是唯一能把文件真正"带出去"的正路：
 * 对方（或自己）在微信里可以"用其他应用打开"，在电脑上收下就是普通文件。
 *
 * 所以界面上的「下载」= 存进沙箱 + 打开预览，「转发文件」= 导出到微信。
 * 两者配合才构成一个完整的"保存"体验。
 */
export function shareLocalFile(filePath: string, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.shareFileMessage({
      filePath,
      fileName: name,
      success: () => resolve(),
      // 用户在转发面板点返回不算失败，不该弹红字
      fail: (e) => (isCancel(e) ? resolve() : reject(new Error(e.errMsg || '转发失败'))),
    });
  });
}

/** 读取本地文本文件（文本预览页用）。超大文件只取前一段，避免把界面卡死 */
export function readLocalText(filePath: string, maxBytes = 200 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: 'utf-8',
      success: (res) => {
        const text = String(res.data ?? '');
        resolve(text.length > maxBytes ? `${text.slice(0, maxBytes)}\n\n…（内容过长，仅显示前 ${Math.round(maxBytes / 1024)}KB）` : text);
      },
      fail: (e) => reject(new Error(e.errMsg || '读取文件失败')),
    });
  });
}

/* ------------------------------ 展示辅助 ------------------------------ */

/** 人类可读体积（文件列表与上传回执共用同一份口径） */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/* ------------------------------ 内部实现 ------------------------------ */

/** 取消选择：各端 errMsg 文案不一致，统一按关键字判定 */
function isCancel(e: { errMsg?: string }): boolean {
  return /cancel/i.test(e?.errMsg ?? '');
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

function mimeOf(name: string): string {
  return MIME[extOf(name)] ?? 'application/octet-stream';
}

/** 拍照/相册的临时文件没有文件名，从路径里取；取不到就按时间戳造一个 */
function nameFromPath(path: string): string {
  const seg = path.split('/').pop() ?? '';
  if (seg && seg.includes('.')) return seg;
  return `图片_${Date.now()}.jpg`;
}

function readArrayBuffer(filePath: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      success: (res) => resolve(res.data as ArrayBuffer),
      fail: (e) => reject(new Error(e.errMsg || '读取文件失败')),
    });
  });
}

/** 直传：PUT 原始字节。签名在 URL 里，所以**不带** Authorization */
function putBinary(url: string, body: ArrayBuffer, contentType: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method: 'PUT',
      data: body,
      header: { 'Content-Type': contentType },
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`上传失败（${res.statusCode}），请稍后重试`));
      },
      fail: (e) => reject(new Error(e.errMsg || '上传失败，请检查网络')),
    });
  });
}

function downloadFile(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.tempFilePath);
        else reject(new Error(`下载失败（${res.statusCode}），请稍后重试`));
      },
      fail: (e) => reject(new Error(e.errMsg || '下载失败，请检查网络')),
    });
  });
}

/** 从临时目录搬进用户目录：临时文件会被系统回收，用户目录的不会 */
function saveToUserDir(tempFilePath: string, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().saveFile({
      tempFilePath,
      filePath: uniquePath(name),
      success: (res) => resolve(res.savedFilePath),
      fail: (e) => reject(new Error(e.errMsg || '保存到本地失败')),
    });
  });
}

/** 重名时加序号，避免覆盖上一次下载的同一文件 */
function uniquePath(name: string): string {
  // 连字符表外还要拦 `;` 与空白：`;` 是 URI 的参数分隔符，音频/文档引擎
  // 解析 `wxfile://.../T-T;陈艺之;xx.wav` 这类路径会在分号处截断（实测
  // InnerAudioContext 直接 onError）。文件名里它们只是装饰，换成 `_` 无损语义。
  const safe = name.replace(/[\\/:*?"<>|;\s]/g, '_').slice(0, 100) || 'file';
  const dot = safe.lastIndexOf('.');
  const base = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : '';
  const dir = wx.env.USER_DATA_PATH;

  let candidate = `${dir}/${safe}`;
  let i = 1;
  while (fileExists(candidate)) candidate = `${dir}/${base}(${i++})${ext}`;
  return candidate;
}

function fileExists(path: string): boolean {
  try {
    wx.getFileSystemManager().accessSync(path);
    return true;
  } catch {
    return false;
  }
}

/** 系统预览器；不支持的格式会走 fail，因此这里把失败当成"没打开"而不是错误 */
function tryOpenDocument(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    wx.openDocument({
      filePath,
      // 右上角"…"里可以转发/另存，比只让用户看一眼有用
      showMenu: true,
      success: () => resolve(true),
      fail: () => resolve(false),
    });
  });
}
