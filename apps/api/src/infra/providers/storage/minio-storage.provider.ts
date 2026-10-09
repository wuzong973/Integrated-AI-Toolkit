import type { PresignResult, StorageProvider } from '@qz/core';
import { Client } from 'minio';

/** MinIO / S3 兼容存储的装配参数（来自 AppConfig.storage） */
export interface MinioStorageOptions {
  /** 形如 http://localhost:9000 或 https://oss-cn-hangzhou.aliyuncs.com */
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  /** 预签名有效期（秒） */
  presignExpire: number;
}

/**
 * 对象存储真实实现（任务清单 M0-12）
 *
 * 架构纪律（ADR-04）：**后端只签发与确认，不中转二进制**。
 * 上传走 `presignedPutObject` 让客户端直传对象存储；下载走 `presignedGetObject`。
 * 只有 `putObject` / `getObject` 会经后端，它们服务于服务端自产文件
 * （如工具生成的 PPT、缩略图）与代理下载，不用于用户上传主链路。
 *
 * 为什么用官方 minio 客户端而不是手写 SigV4：
 * 预签名涉及 HMAC-SHA256 的规范化请求串构造，自己实现极易在边界情况（特殊字符、
 * 时间偏移、region 差异）出错，且难以在没有真实服务端时验证。minio 客户端是
 * Apache-2.0，同时兼容 MinIO 与 S3 协议端点。
 *
 * 注意：STORAGE_DRIVER 还声明了 oss / cos，但阿里云 OSS 与腾讯云 COS 的
 * S3 兼容层在分片与签名细节上有差异，未实测前不宣称支持——需要时接各自官方 SDK。
 */
export class MinioStorageProvider implements StorageProvider {
  readonly name = 'minio-storage';

  private readonly client: Client;
  private readonly bucket: string;
  private readonly defaultExpire: number;
  /** 惰性建桶只做一次；用 Promise 缓存避免并发重复创建 */
  private ensured: Promise<void> | null = null;

  constructor(opts: MinioStorageOptions) {
    this.bucket = opts.bucket;
    this.defaultExpire = opts.presignExpire;
    this.client = new Client({
      ...parseEndpoint(opts.endpoint),
      accessKey: opts.accessKey,
      secretKey: opts.secretKey,
      region: opts.region,
      // 强制 path-style：MinIO 默认如此，且能避免自定义域名下的 virtual-host 解析问题
      pathStyle: true,
    });
  }

  async presignPut(
    objectKey: string,
    contentType: string,
    expiresIn?: number,
  ): Promise<PresignResult> {
    await this.ensureBucket();
    const expire = expiresIn ?? this.defaultExpire;
    const uploadUrl = await this.client.presignedPutObject(this.bucket, objectKey, expire);
    return {
      uploadUrl,
      // presignedPutObject 不把 Content-Type 纳入签名，客户端需按此头发送以保持一致
      headers: { 'Content-Type': contentType },
      objectKey,
      expiresIn: expire,
    };
  }

  async presignGet(objectKey: string, expiresIn?: number): Promise<string> {
    await this.ensureBucket();
    return this.client.presignedGetObject(this.bucket, objectKey, expiresIn ?? this.defaultExpire);
  }

  async putObject(objectKey: string, body: Buffer, contentType: string): Promise<void> {
    await this.ensureBucket();
    await this.client.putObject(this.bucket, objectKey, body, body.length, {
      'Content-Type': contentType,
    });
  }

  async getObject(objectKey: string): Promise<Buffer> {
    const stream = await this.client.getObject(this.bucket, objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }

  async deleteObject(objectKey: string): Promise<void> {
    await this.client.removeObject(this.bucket, objectKey);
  }

  async exists(objectKey: string): Promise<boolean> {
    try {
      await this.client.statObject(this.bucket, objectKey);
      return true;
    } catch {
      // statObject 对不存在的对象抛错（NoSuchKey / NotFound）
      return false;
    }
  }

  /** 桶不存在时创建；仅第一次调用真正执行 */
  private ensureBucket(): Promise<void> {
    this.ensured ??= this.createBucketIfAbsent();
    return this.ensured;
  }

  private async createBucketIfAbsent(): Promise<void> {
    if (await this.client.bucketExists(this.bucket)) return;
    await this.client.makeBucket(this.bucket);
  }
}

/**
 * 把 `http(s)://host[:port]` 拆成 minio 客户端要求的 endPoint / port / useSSL。
 * 连接串非法时退回默认的 localhost:9000，避免因配置笔误导致启动失败。
 */
export function parseEndpoint(raw: string): {
  endPoint: string;
  port: number;
  useSSL: boolean;
} {
  try {
    const url = new URL(raw);
    return {
      endPoint: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
      useSSL: url.protocol === 'https:',
    };
  } catch {
    return { endPoint: 'localhost', port: 9000, useSSL: false };
  }
}
