/**
 * 二进制类型的魔数嗅探。
 *
 * ## 为什么必须嗅探而不是信文件名
 *
 * 侧车的入参只有 `Buffer` —— 文件名一路传下来早已丢失（`ToolRunContext` 里
 * 只有字节）。而 ffmpeg / rembg 都**按扩展名选解复用器**：
 * 一份 .mov 被当成 .mp4 送去，某些解复用器会给出与真实原因毫无关系的报错。
 *
 * 所以落盘前统一按魔数判断真实类型，给出正确扩展名与 MIME。
 * 判据只认文件头字节，不认任何调用方传进来的字符串 ——
 * 那正是"文件被改名后仍能正确处理"的前提。
 */

export interface SniffedType {
  /** 不含点的扩展名，如 `png` / `mp4` */
  ext: string;
  contentType: string;
}

interface Signature {
  type: SniffedType;
  test: (buf: Buffer) => boolean;
}

const PNG: SniffedType = { ext: 'png', contentType: 'image/png' };
const MP4: SniffedType = { ext: 'mp4', contentType: 'video/mp4' };

const at = (buf: Buffer, offset: number, text: string): boolean =>
  buf.length >= offset + text.length &&
  buf.toString('ascii', offset, offset + text.length) === text;

/** 4 字节序列比较。用于无法用 ASCII 表达的文件头（TIFF 的字节序标记里含 NUL） */
const bytes = (buf: Buffer, ...expected: number[]): boolean =>
  buf.length >= expected.length && expected.every((b, i) => buf[i] === b);

const IMAGE_SIGNATURES: readonly Signature[] = [
  { type: PNG, test: (b) => bytes(b, 0x89, 0x50, 0x4e, 0x47) },
  { type: { ext: 'jpg', contentType: 'image/jpeg' }, test: (b) => bytes(b, 0xff, 0xd8, 0xff) },
  { type: { ext: 'webp', contentType: 'image/webp' }, test: (b) => at(b, 0, 'RIFF') && at(b, 8, 'WEBP') },
  { type: { ext: 'gif', contentType: 'image/gif' }, test: (b) => at(b, 0, 'GIF8') },
  { type: { ext: 'bmp', contentType: 'image/bmp' }, test: (b) => at(b, 0, 'BM') },
  // TIFF 两种字节序：小端 49 49 2A 00 / 大端 4D 4D 00 2A。
  // 用数值比较而不是字符串字面量 —— 在字符串里写 NUL 会把**真的 NUL 字节**写进源码，
  // 文件随即被 git / 编辑器判为二进制，diff 与逐行审查全部失效。
  { type: { ext: 'tiff', contentType: 'image/tiff' },
    test: (b) => bytes(b, 0x49, 0x49, 0x2a, 0x00) || bytes(b, 0x4d, 0x4d, 0x00, 0x2a) },
  { type: { ext: 'heic', contentType: 'image/heic' },
    test: (b) => at(b, 4, 'ftyp') && (at(b, 8, 'heic') || at(b, 8, 'mif1')) },
];

/** 音视频魔数表。命中顺序有意义：mov / mp4 共用 ftyp，先判定的优先 */
const MEDIA_SIGNATURES: readonly Signature[] = [
  { type: { ext: 'webm', contentType: 'video/webm' }, test: (b) => bytes(b, 0x1a, 0x45, 0xdf, 0xa3) },
  { type: { ext: 'avi', contentType: 'video/x-msvideo' }, test: (b) => at(b, 0, 'RIFF') && at(b, 8, 'AVI ') },
  { type: { ext: 'wav', contentType: 'audio/wav' }, test: (b) => at(b, 0, 'RIFF') && at(b, 8, 'WAVE') },
  { type: { ext: 'gif', contentType: 'image/gif' }, test: (b) => at(b, 0, 'GIF8') },
  { type: { ext: 'flv', contentType: 'video/x-flv' }, test: (b) => at(b, 0, 'FLV') },
  { type: { ext: 'ogg', contentType: 'audio/ogg' }, test: (b) => at(b, 0, 'OggS') },
  { type: { ext: 'mp3', contentType: 'audio/mpeg' },
    test: (b) => at(b, 0, 'ID3') || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  { type: MP4, test: (b) => at(b, 4, 'ftyp') },
];

/** 默认按 PNG 处理：抠图的输入绝大多数是图片，且 PNG 是唯一能承载 alpha 的常见格式 */
export function sniffImage(buf: Buffer): SniffedType {
  return IMAGE_SIGNATURES.find((s) => s.test(buf))?.type ?? PNG;
}

/** 默认按 MP4 处理：媒体侧车的五个能力里四个面向视频 */
export function sniffMedia(buf: Buffer): SniffedType {
  return MEDIA_SIGNATURES.find((s) => s.test(buf))?.type ?? MP4;
}
