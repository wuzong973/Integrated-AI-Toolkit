import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

import type { PresignResult, StorageProvider } from '@qz/core';

/** 本地存储的装配参数 */
export interface LocalStorageOptions {
  /** 文件落盘根目录（相对仓库根或绝对路径） */
  baseDir: string;
  /** 生成签名 URL 用的对外基址，如 http://localhost:3000/api/v1 */
  baseUrl: string;
  /** 签名密钥（复用 JWT_SECRET 即可，避免再引入一个必填变量） */
  secret: string;
  /** 签名有效期（秒） */
  presignExpire: number;
}

/** 签名载荷 */
interface TokenPayload {
  /** 对象键 */
  k: string;
  /** 操作：put 上传 / get 下载 */
  op: 'put' | 'get';
  /** 过期时间戳（毫秒） */
  exp: number;
}

/**
 * 本地文件系统对象存储（STORAGE_DRIVER=local）
 *
 * 用途：本地开发与自测。**不依赖任何外部对象存储**，
 * 因此在 MinIO 已停止分发、COS 尚未接入的当下，这是唯一能让上传/产物落盘链路跑通的方案。
 *
 * 与 ADR-04 的关系（必须知道）：
 *   ADR-04 要求"后端只签发不中转二进制"，那是针对**生产**（客户端直传对象存储）。
 *   本地驱动下后端**就是**存储本身，二进制必然经后端 —— 这是 local 驱动固有的取舍，
 *   仅限开发环境。切到 COS 后 presign 会返回对象存储的真实直传地址，回到 ADR-04 的正轨。
 *
 * 安全设计：URL 不是开放的上传/下载端点，而是**带 HMAC 签名的短时效令牌**，
 * 与 S3 presign 的语义一致（谁拿到 URL 谁就能传，但 URL 会过期且不可伪造）。
 */
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local-storage';

  private readonly root: string;
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly defaultExpire: number;

  constructor(opts: LocalStorageOptions) {
    this.root = resolve(opts.baseDir);
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.secret = opts.secret;
    this.defaultExpire = opts.presignExpire;
  }

  async presignPut(
    objectKey: string,
    contentType: string,
    expiresIn?: number,
  ): Promise<PresignResult> {
    const expire = expiresIn ?? this.defaultExpire;
    const token = signLocalToken(
      { k: objectKey, op: 'put', exp: Date.now() + expire * 1000 },
      this.secret,
    );
    return {
      uploadUrl: `${this.baseUrl}/files/local/${token}`,
      headers: { 'Content-Type': contentType },
      objectKey,
      expiresIn: expire,
    };
  }

  async presignGet(objectKey: string, expiresIn?: number): Promise<string> {
    const expire = expiresIn ?? this.defaultExpire;
    const token = signLocalToken(
      { k: objectKey, op: 'get', exp: Date.now() + expire * 1000 },
      this.secret,
    );
    return `${this.baseUrl}/files/local/${token}`;
  }

  async putObject(objectKey: string, body: Buffer): Promise<void> {
    const full = this.resolveKey(objectKey);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }

  async getObject(objectKey: string): Promise<Buffer> {
    return readFile(this.resolveKey(objectKey));
  }

  /**
   * 流式写入（直传端点用）。
   * 为什么不复用 putObject：它接收 Buffer，而视频上限 500MB，
   * 全量读进内存既浪费又可能 OOM。这里边收边落盘，返回实际字节数。
   */
  async putObjectStream(objectKey: string, stream: Readable): Promise<number> {
    const full = this.resolveKey(objectKey);
    await mkdir(dirname(full), { recursive: true });
    await pipeline(stream, createWriteStream(full));
    return (await stat(full)).size;
  }

  /** 流式读取（下载端点用） */
  createReadStream(objectKey: string): Readable {
    return createReadStream(this.resolveKey(objectKey));
  }

  async deleteObject(objectKey: string): Promise<void> {
    await rm(this.resolveKey(objectKey), { force: true });
  }

  async exists(objectKey: string): Promise<boolean> {
    try {
      const s = await stat(this.resolveKey(objectKey));
      return s.isFile();
    } catch {
      return false;
    }
  }

  /**
   * 把对象键映射为磁盘路径，并阻断路径穿越。
   *
   * 采用**拒绝**而不是"静默清洗"：清洗（如剥掉前导 `../`）虽然也安全，
   * 但会把 `../../etc/passwd` 悄悄变成一个合法键，掩盖了调用方的错误；
   * 这里选择 fail-closed —— 越界就抛错，让问题立刻暴露。
   *
   * 对象键由后端生成（见 file.service 的 buildObjectKey），理论上不含 `..`；
   * 但上传端点会直接收到外部传入的键，因此必须再校验一次（纵深防御）。
   */
  private resolveKey(objectKey: string): string {
    const full = resolve(this.root, objectKey);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`非法的对象键（越出存储根目录）：${objectKey}`);
    }
    return full;
  }
}

/** 生成签名令牌：base64url(payload).base64url(hmac) */
export function signLocalToken(payload: TokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * 校验签名令牌。
 * @returns 合法返回载荷，非法/过期返回 null（调用方据此回 403，不泄漏具体原因）
 */
export function verifyLocalToken(
  token: string,
  secret: string,
  now = Date.now(),
): TokenPayload | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');

  // 定长比较，避免时序侧信道
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (typeof payload?.k !== 'string' || typeof payload?.exp !== 'number') return null;
    if (payload.op !== 'put' && payload.op !== 'get') return null;
    if (payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}
