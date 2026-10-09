import type { Socket } from 'node:net';

/**
 * 测试替身用的 RESP 编解码与 id 工具
 *
 * 与 `fake-redis-stream-server.ts` 拆开，一是为了满足仓库 300 行/文件的红线，
 * 二是这两组工具职责完全不同：这里是**协议层**，那里是**命令语义层**。
 */

/** 写回数据（socket 已销毁时静默丢弃，避免测试收尾时抛错） */
export function write(socket: Socket, data: string): void {
  if (!socket.destroyed) socket.write(data);
}

/** RESP 批量字符串。长度必须按**字节数**而不是字符数算（ioredis 按 Buffer 长度校验） */
export function bulk(value: string): string {
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

/** RESP 整数 */
export function integer(value: number): string {
  return `:${value}\r\n`;
}

/**
 * 解析一条 RESP 请求。
 * @returns 已解析出完整命令时返回 args 与剩余缓冲；数据不完整时返回 null（等待更多数据）
 */
export function parseRequest(buffer: Buffer): { args: string[]; rest: Buffer } | null {
  let offset = 0;
  const args: string[] = [];

  const readLine = (): string | null => {
    const idx = buffer.indexOf('\r\n', offset);
    if (idx < 0) return null;
    const line = buffer.toString('utf8', offset, idx);
    offset = idx + 2;
    return line;
  };

  const header = readLine();
  if (header === null) return null;
  if (!header.startsWith('*')) return null;

  const count = Number(header.slice(1));
  for (let i = 0; i < count; i++) {
    const lenLine = readLine();
    if (lenLine === null) return null;
    if (!lenLine.startsWith('$')) return null;
    const len = Number(lenLine.slice(1));
    if (buffer.length < offset + len + 2) return null;
    args.push(buffer.toString('utf8', offset, offset + len));
    offset += len + 2;
  }

  return { args, rest: buffer.subarray(offset) };
}

/** 流消息 id `ms-seq` 的比较。不能按字典序（"10-0" < "9-0"） */
export function compareId(a: string, b: string): number {
  const [aMs, aSeq] = a.split('-').map(Number);
  const [bMs, bSeq] = b.split('-').map(Number);
  if (aMs !== bMs) return aMs - bMs;
  return (aSeq || 0) - (bSeq || 0);
}

/** id 是否落在 [start, end] 内；`-` / `+` 表示无穷 */
export function idInRange(id: string, start: string, end: string): boolean {
  const lo = start === '-' ? true : compareId(id, start) >= 0;
  const hi = end === '+' ? true : compareId(id, end) <= 0;
  return lo && hi;
}

/** 字段对象 → 扁平数组 `[k1, v1, k2, v2]` */
export function flatten(fields: Record<string, string>): string[] {
  return Object.entries(fields).flat();
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ioredis 建连后会读 INFO 判断服务端能力。
 * 若不回一段像样的 INFO，ioredis 的版本探测会失败。
 */
export const INFO_REPLY = [
  '# Server',
  'redis_version:7.2.0',
  'redis_mode:standalone',
  'os:Linux',
  'arch_bits:64',
  '',
].join('\r\n');
