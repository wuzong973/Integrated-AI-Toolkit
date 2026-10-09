/** 文件工具（文档 6.5 / 6.4.4 上传限制） */

export const MB = 1024 * 1024;

/** 按业务场景的大小上限（MB），与 .env 默认值一致 */
export const FILE_SIZE_LIMITS = {
  image: 20,
  video: 500,
  audio: 200,
  document: 100,
} as const;

export type FileKind = keyof typeof FILE_SIZE_LIMITS;

const EXT_TO_KIND: Record<string, FileKind> = {
  // 图片
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  webp: 'image',
  gif: 'image',
  heic: 'image',
  bmp: 'image',
  // 视频
  mp4: 'video',
  mov: 'video',
  avi: 'video',
  mkv: 'video',
  flv: 'video',
  webm: 'video',
  // 音频
  mp3: 'audio',
  wav: 'audio',
  aac: 'audio',
  flac: 'audio',
  m4a: 'audio',
  ogg: 'audio',
  // 文档
  pdf: 'document',
  doc: 'document',
  docx: 'document',
  ppt: 'document',
  pptx: 'document',
  xls: 'document',
  xlsx: 'document',
  txt: 'document',
  md: 'document',
  csv: 'document',
};

/** 取扩展名（小写，不含点） */
export function extOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i < 0 ? '' : filename.slice(i + 1).toLowerCase();
}

/** 判断文件类别 */
export function kindOf(filename: string): FileKind | null {
  return EXT_TO_KIND[extOf(filename)] ?? null;
}

/** 校验文件大小；超限返回错误信息，通过返回 null */
export function checkFileSize(filename: string, bytes: number): string | null {
  const kind = kindOf(filename);
  if (!kind) return `不支持的文件类型：.${extOf(filename)}`;
  const limit = FILE_SIZE_LIMITS[kind] * MB;
  if (bytes > limit) return `文件超过 ${FILE_SIZE_LIMITS[kind]}MB，请压缩后再试`;
  return null;
}

/** 人类可读体积 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / (1024 * MB)).toFixed(2)} GB`;
}

/** 生成安全文件名（去除路径与危险字符） */
export function safeFilename(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.\./g, '_')
    .slice(0, 120);
}
