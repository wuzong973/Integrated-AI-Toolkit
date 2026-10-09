/**
 * Base64 / URL 编解码（纯函数，不依赖 wx API）
 *
 * ## 为什么手写 Base64，而不用 btoa / TextEncoder
 *
 * 小程序 JS 环境对 `btoa` / `atob` / `TextEncoder` 的支持**因机型与基础库而异**，
 * 用了就是在真机上埋雷。所以这里把 UTF-8 → 字节 → Base64 的两步都手写
 * （各约 20 行，纯函数可单测），任何环境都能跑。
 *
 * ## 口径
 *
 *   · Base64 用标准字母表（`+/`，带 `=` 补位）；解码时容忍空白字符（用户常从
 *     文档里粘出带换行的串），其余非法字符判失败；
 *   · URL 编解码 = `encodeURIComponent` / `decodeURIComponent`；解码失败
 *     （半截 `%E4` 之类）返回错误而不是抛异常。
 */

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 文本 → UTF-8 字节（`for...of` 按码点迭代，代理对天然正确） */
export function utf8Encode(text: string): number[] {
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

/** UTF-8 字节 → 文本；遇到非法序列返回 null（不静默出乱码） */
export function utf8Decode(bytes: number[]): string | null {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i];
    if (lead < 0x80) {
      out += String.fromCodePoint(lead);
      i += 1;
      continue;
    }
    const rest = lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : 3;
    const code = readMultiByte(bytes, i, rest);
    if (code === null) return null;
    out += String.fromCodePoint(code);
    i += rest + 1;
  }
  return out;
}

/** 读一个多字节序列的码点；缺续字节 / 续字节不合法返回 null */
function readMultiByte(bytes: number[], start: number, rest: number): number | null {
  const lead = bytes[start];
  let code = lead < 0xe0 ? lead & 0x1f : lead < 0xf0 ? lead & 0x0f : lead & 0x07;
  for (let k = 1; k <= rest; k += 1) {
    const b = bytes[start + k];
    if (b === undefined || (b & 0xc0) !== 0x80) return null;
    code = (code << 6) | (b & 0x3f);
  }
  return code;
}

/** 字节 → 标准 Base64（带 `=` 补位）：余 1 字节补 `==`，余 2 字节补 `=` */
export function base64Encode(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) out += B64_CHARS[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== undefined) out += B64_CHARS[b2 & 0x3f];
  }
  return out + '='.repeat(padCount(out.length));
}

/** 需要补几个 `=`（合法输出长度只可能余 0/2/3，余 2 补两个、余 3 补一个） */
function padCount(len: number): number {
  return (4 - (len % 4)) % 4;
}

/**
 * Base64 → 字节；非法返回 null。
 *
 * 位缓冲法：每凑满 8 bit 就吐一个字节，末尾不足 8 bit 的余数正是 `=`
 * 代表的补位零 —— 自然丢弃，不用按余数特判。
 */
export function base64Decode(text: string): number[] | null {
  const clean = text.replace(/\s+/g, '');
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  const body = clean.replace(/=+$/, '');
  if (body.length % 4 === 1) return null; // 这种补位本身就是错的
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < body.length; i += 1) {
    const v = B64_CHARS.indexOf(body[i]);
    if (v < 0) return null;
    // 最多保留 3 字节 = 24 bit，长串下 buffer 不会溢出 32 位
    buffer = ((buffer << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

export type CodecMode = 'b64enc' | 'b64dec' | 'urlenc' | 'urldec';

export interface CodecResult {
  ok: boolean;
  output: string;
  error: string;
}

/** 四种模式统一入口；解码失败给一句人话，不抛异常 */
export function runCodec(mode: CodecMode, input: string): CodecResult {
  if (!input) return { ok: true, output: '', error: '' };
  if (mode === 'urlenc') return { ok: true, output: encodeURIComponent(input), error: '' };
  if (mode === 'urldec') {
    try {
      return { ok: true, output: decodeURIComponent(input), error: '' };
    } catch {
      return { ok: false, output: '', error: 'URL 解码失败：% 转义序列不完整或非法' };
    }
  }
  if (mode === 'b64enc') {
    return { ok: true, output: base64Encode(utf8Encode(input)), error: '' };
  }
  const bytes = base64Decode(input);
  if (bytes === null) {
    return { ok: false, output: '', error: '不是合法的 Base64：字符集或长度不对' };
  }
  const text = utf8Decode(bytes);
  if (text === null) {
    return { ok: false, output: '', error: 'Base64 能解开，但内容不是合法的 UTF-8 文本' };
  }
  return { ok: true, output: text, error: '' };
}
