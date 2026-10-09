import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BizException,
  ErrorCode,
  FileScene,
  checkFileSize,
  extOf,
  kindOf,
  safeFilename,
  type ConfirmFileDto,
  type PresignDto,
  type Providers,
} from '@qz/core';

import type { AppConfig } from '../../common/config/configuration';
import { AppLogger } from '../../common/logger/logger.service';
import { PROVIDERS } from '../../infra/providers/providers.module';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** 文件条目（对齐 apps/mp/utils/api.ts 的 FileItem） */
export interface FileItem {
  id: string;
  name: string;
  /** 文件类别：image | video | audio | document（对应小程序图标映射） */
  type: string;
  size: number;
  scene: string;
  createdAt: string;
}

/** 列表查询条件 */
export interface FileListQuery {
  scene?: string;
  /** 是否只看回收站；默认 false（只看正常文件） */
  trashed?: boolean;
}

/**
 * 头像 302 目标地址的时效。
 *
 * 与 `STORAGE_PRESIGN_EXPIRE`（默认 900 秒，给"下载"用）刻意不同：
 * 头像会被列表、聊天、评价区反复渲染，900 秒意味着同一张图在页面上闪断。
 * 30 天足够长到没人察觉，又仍是**会过期**的签名地址 —— 不签永久公开读，
 * 是为了换 COS 驱动时不用改代码，也让泄露的链接有自然失效的一天。
 */
const AVATAR_URL_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * 文件资产服务（任务清单 M0-12）
 *
 * 架构纪律（ADR-04）：**后端只签发与确认，不中转二进制**。
 *   ① presign —— 校验大小与类型，生成 objectKey，向对象存储签发上传 URL
 *   ② 客户端 → 对象存储直传（不经过本服务）
 *   ③ confirm —— 校验对象确实存在，落 file_asset 记录
 * 只有服务端自产文件（工具产出的 PPT 等）才走 storage.putObject。
 *
 * objectKey 规则：`{scene}/{userId}/{yyyyMM}/{uuid}.{ext}`
 *   · 按 scene 分目录便于按业务批量清理与生命周期策略
 *   · 带 userId 前缀，天然支持"按用户统计存储用量"
 *   · 用 uuid 而非原文件名，避免中文/特殊字符与重名覆盖
 */
@Injectable()
export class FileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
    @Inject(PROVIDERS) private readonly providers: Providers,
  ) {}

  /** ① 获取直传签名（含大小与类型校验） */
  async presign(
    userId: string,
    dto: PresignDto,
  ): Promise<{
    uploadUrl: string;
    headers: Record<string, string>;
    objectKey: string;
    expiresIn: number;
  }> {
    assertSizeAllowed(dto.filename, dto.size);

    const storage = this.providers.storage;
    const objectKey = buildObjectKey(dto.scene, userId, dto.filename);
    const result = await this.withStorage(
      () => storage.presignPut(objectKey, dto.contentType, this.presignExpire),
      '签发上传地址',
    );

    return {
      uploadUrl: result.uploadUrl,
      headers: result.headers,
      objectKey: result.objectKey,
      expiresIn: result.expiresIn,
    };
  }

  /** ③ 确认上传：对象存在才落库，避免产生"有记录没文件"的脏数据 */
  async confirm(userId: string, dto: ConfirmFileDto): Promise<FileItem> {
    assertSizeAllowed(dto.filename, dto.size);

    const exists = await this.withStorage(
      () => this.providers.storage.exists(dto.objectKey),
      '确认上传对象',
    );
    if (!exists) {
      throw new BizException(ErrorCode.FileCorrupted, undefined, '未找到已上传的文件，请重新上传');
    }

    const asset = await this.prisma.fileAsset.create({
      data: {
        userId,
        name: safeFilename(dto.filename),
        type: kindOf(dto.filename) ?? 'document',
        size: dto.size,
        objectKey: dto.objectKey,
        hash: dto.hash ?? null,
        scene: dto.scene,
      },
    });

    return toFileItem(asset);
  }

  /**
   * 服务端自产文件落库（工具产出、缩略图等）
   *
   * 与 confirm 的区别：这条路径**二进制经后端**（服务端生成的 Buffer 没法"直传"），
   * 所以直接 putObject 再建记录，不做 presign/confirm 两步。
   * 用户上传主链路不走这里（ADR-04：后端不中转用户上传的二进制）。
   */
  async saveGenerated(
    userId: string,
    input: {
      name: string;
      buffer: Buffer;
      contentType: string;
      scene?: string;
      /** 产出它的工具名，便于溯源 */
      source?: string;
    },
  ): Promise<FileItem> {
    const scene = input.scene ?? 'ai_generated';
    const objectKey = buildObjectKey(scene, userId, input.name);

    await this.withStorage(
      () => this.providers.storage.putObject(objectKey, input.buffer, input.contentType),
      '写入产出文件',
    );

    const asset = await this.prisma.fileAsset.create({
      data: {
        userId,
        name: safeFilename(input.name),
        type: kindOf(input.name) ?? 'document',
        size: input.buffer.length,
        objectKey,
        scene,
        source: input.source ?? null,
      },
    });
    return toFileItem(asset);
  }

  /** 按 id 取对象内容（工具执行需要读入参文件）；归属校验后走存储 getObject */
  async readObject(userId: string, fileId: string): Promise<{ buffer: Buffer; name: string }> {
    const asset = await this.findOwned(userId, fileId);
    const buffer = await this.withStorage(
      () => this.providers.storage.getObject(asset.objectKey),
      '读取入参文件',
    );
    return { buffer, name: asset.name };
  }

  /** 我的文件列表（默认不含回收站） */
  async list(userId: string, query: FileListQuery): Promise<FileItem[]> {
    const assets = await this.prisma.fileAsset.findMany({
      where: {
        userId,
        deletedAt: query.trashed ? { not: null } : null,
        ...(query.scene ? { scene: query.scene } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return assets.map(toFileItem);
  }

  /** 文件详情（归属校验） */
  async detail(userId: string, id: string): Promise<FileItem & { downloadCount: number }> {
    const asset = await this.findOwned(userId, id);
    return { ...toFileItem(asset), downloadCount: asset.downloadCount };
  }

  /** 生成下载地址（归属校验，并累计下载次数） */
  async downloadUrl(userId: string, id: string): Promise<{ url: string; expiresIn: number }> {
    const asset = await this.findOwned(userId, id);
    const url = await this.withStorage(
      () => this.providers.storage.presignGet(asset.objectKey, this.presignExpire),
      '签发下载地址',
    );

    await this.prisma.fileAsset.update({
      where: { id },
      data: { downloadCount: { increment: 1 } },
    });

    return { url, expiresIn: this.presignExpire };
  }

  /**
   * 头像的**永久**公开地址（`GET /files/public/:id`）指向这里。
   *
   * ## 为什么需要它
   *
   * 直接把 presign 出来的 URL 存进 `user.avatar` 的话，时效是
   * `STORAGE_PRESIGN_EXPIRE`（默认 900 秒）—— 头像会在 15 分钟后变灰，
   * 而 `<image>` 标签带不了 `Authorization` 头，也走不了"每次现签"的老路。
   * 所以给一个**不变**的地址，由它去签发短期地址。
   *
   * ## 为什么是 302 而不是回字节
   *
   * ADR-04 定了"后端只签发与确认，不中转二进制"。头像是小图，破例代价不大，
   * 但破例一次就会有第二次；302 到对象存储的签名地址能同时满足
   * "地址永久"和"不中转"，且换到 COS 时行为一致。
   *
   * ## 为什么只放行 avatar 场景
   *
   * 头像是天然公开的（昵称旁边就要展示）；`verification`（学生证照片）与
   * `order_delivery`（订单交付物）绝不能被公开取到。
   * id 是 uuid **不等于**安全 —— 链接会被转发、会进访问日志。
   */
  async publicAvatarUrl(id: string): Promise<string> {
    const asset = await this.prisma.fileAsset.findUnique({ where: { id } });
    if (!asset || asset.deletedAt || asset.scene !== FileScene.Avatar) {
      throw new BizException(ErrorCode.NotFound, undefined, '头像不存在');
    }
    return this.withStorage(
      () => this.providers.storage.presignGet(asset.objectKey, AVATAR_URL_TTL_SECONDS),
      '签发头像地址',
    );
  }

  /** 删除（进回收站，软删） */  async remove(userId: string, id: string): Promise<void> {
    await this.findOwned(userId, id);
    await this.prisma.fileAsset.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  /** 从回收站恢复 */
  async restore(userId: string, id: string): Promise<void> {
    const asset = await this.findOwned(userId, id, true);
    if (!asset.deletedAt) return;
    await this.prisma.fileAsset.update({ where: { id }, data: { deletedAt: null } });
  }

  /** 存储用量（仅统计未删除文件） */
  async storageUsage(userId: string): Promise<{
    usedBytes: number;
    fileCount: number;
    trashedCount: number;
  }> {
    const [agg, fileCount, trashedCount] = await Promise.all([
      this.prisma.fileAsset.aggregate({
        where: { userId, deletedAt: null },
        _sum: { size: true },
      }),
      this.prisma.fileAsset.count({ where: { userId, deletedAt: null } }),
      this.prisma.fileAsset.count({ where: { userId, deletedAt: { not: null } } }),
    ]);

    return { usedBytes: agg._sum.size ?? 0, fileCount, trashedCount };
  }

  private get presignExpire(): number {
    return this.config.get<AppConfig>('app')!.storage.presignExpire;
  }

  /**
   * 统一收口对象存储的调用错误。
   *
   * 为什么需要：真实存储 Provider 只要配了凭证就会被装配（哪怕 MinIO/OSS 没在跑），
   * 此时连接类异常会被全局过滤器兜成笼统的 500，前端无法区分
   * "服务崩了"与"存储不可用"。这里映射为 StorageUnavailable（503 + 50363），
   * 与数据库不可用时的处理保持一致；业务异常（如归属校验失败）原样透传。
   */
  private async withStorage<T>(op: () => Promise<T>, action: string): Promise<T> {
    try {
      return await op();
    } catch (e) {
      if (e instanceof BizException) throw e;
      const reason = (e as Error).message;
      this.logger.error(`对象存储调用失败（${action}）：${reason}`, undefined, 'File');
      throw new BizException(
        ErrorCode.StorageUnavailable,
        undefined,
        '对象存储暂时不可用，请稍后重试',
      );
    }
  }

  /**
   * 取文件并校验归属。
   * 越权访问统一抛 NoPermission 而不是 NotFound —— 但注意这里**故意用 NotFound 语义之外**的错误码，
   * 是为了让排查日志能区分"文件不存在"与"不是你的文件"。
   */
  private async findOwned(userId: string, id: string, allowTrashed = false) {
    const asset = await this.prisma.fileAsset.findUnique({ where: { id } });
    if (!asset) throw new BizException(ErrorCode.NotFound, undefined, '文件不存在或已被删除');
    if (asset.userId !== userId) {
      throw new BizException(ErrorCode.NoPermission, undefined, '无权访问该文件');
    }
    if (!allowTrashed && asset.deletedAt) {
      throw new BizException(ErrorCode.NotFound, undefined, '文件已在回收站中');
    }
    return asset;
  }
}

/** 大小与类型校验：不支持的类型或不合法的大小都在这里挡掉 */
function assertSizeAllowed(filename: string, size: number): void {
  if (!kindOf(filename)) {
    throw new BizException(
      ErrorCode.FileFormatUnsupported,
      undefined,
      `不支持的文件类型：.${extOf(filename)}`,
    );
  }
  const err = checkFileSize(filename, size);
  if (err) throw new BizException(ErrorCode.FileTooLarge, undefined, err);
}

/** `{scene}/{userId}/{yyyyMM}/{uuid}.{ext}` */
export function buildObjectKey(scene: string, userId: string, filename: string): string {
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const ext = extOf(filename) || 'bin';
  return `${scene}/${userId}/${ym}/${randomUUID()}.${ext}`;
}

function toFileItem(a: {
  id: string;
  name: string;
  type: string;
  size: number;
  scene: string;
  createdAt: Date;
}): FileItem {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    size: a.size,
    scene: a.scene,
    createdAt: a.createdAt.toISOString(),
  };
}
