import { Controller, Get, Inject, Param, Put, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { BizException, ErrorCode, type Providers } from '@qz/core';
import type { Request, Response } from 'express';

import type { AppConfig } from '../../common/config/configuration';
import { PROVIDERS } from '../../infra/providers/providers.module';
import {
  LocalStorageProvider,
  verifyLocalToken,
} from '../../infra/providers/storage/local-storage.provider';

/**
 * 本地对象存储的直传端点（仅 `STORAGE_DRIVER=local` 时可用）
 *
 * 为什么需要它：本地驱动下后端就是存储本身，客户端没有别的地址可以直传。
 * 端点用**带 HMAC 签名的短时效令牌**鉴权（与 S3 presign 语义一致），
 * 而不是开放的上传地址 —— 令牌里绑定了对象键、操作类型与过期时间，不可伪造、会过期。
 *
 * ⚠️ 切到 COS 后这些端点不再被签发（presign 会返回对象存储的真实地址），
 * 保留它们不影响生产安全：令牌密钥来自 JWT_SECRET，且驱动非 local 时直接 404。
 *
 * 注意：`@Res()` 用于下载是因为要回**原始字节流**（前端当图片/文件地址用），
 * 不能套统一响应体；上传则返回统一响应体以便前端确认结果。
 */
@ApiExcludeController()
@Controller('files/local')
export class LocalStorageController {
  constructor(
    private readonly config: ConfigService,
    @Inject(PROVIDERS) private readonly providers: Providers,
  ) {}

  @Put(':token')
  async upload(
    @Param('token') token: string,
    @Req() req: Request,
  ): Promise<{ objectKey: string; size: number }> {
    const storage = this.requireLocal();
    const payload = verifyLocalToken(token, this.secret());
    if (!payload || payload.op !== 'put') {
      throw new BizException(ErrorCode.NoPermission, undefined, '上传地址无效或已过期');
    }

    // 直传流：边收边落盘，不把整个文件读进内存
    const size = await storage.putObjectStream(payload.k, req);
    return { objectKey: payload.k, size };
  }

  @Get(':token')
  async download(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const storage = this.requireLocal();
    const payload = verifyLocalToken(token, this.secret());
    if (!payload || payload.op !== 'get') {
      throw new BizException(ErrorCode.NoPermission, undefined, '下载地址无效或已过期');
    }
    if (!(await storage.exists(payload.k))) {
      throw new BizException(ErrorCode.NotFound, undefined, '文件不存在或已被删除');
    }

    res.setHeader('Content-Type', contentTypeOfKey(payload.k));
    // 对象键里带 uuid，内容不可变，可放心长缓存
    res.setHeader('Cache-Control', 'private, max-age=3600');
    storage.createReadStream(payload.k).pipe(res);
  }

  /** 非 local 驱动时端点不可用（避免生产环境暴露无意义的入口） */
  private requireLocal(): LocalStorageProvider {
    const storage = this.providers.storage;
    if (!(storage instanceof LocalStorageProvider)) {
      throw new BizException(ErrorCode.NotFound, undefined, '当前存储驱动不支持本地直传');
    }
    return storage;
  }

  private secret(): string {
    return this.config.get<AppConfig>('app')!.jwt.secret;
  }
}

/**
 * 按对象键的扩展名回 Content-Type。
 *
 * ## 为什么这里必须给对
 *
 * 原先写死 `application/octet-stream`。对"下载一个文件"没问题，但头像是
 * `<image src>` **直接指向这个地址**（`apps/mp/utils/api.ts` 的 `avatarPublicUrl`
 * 302 过来的目标就是这里），那时候"靠客户端嗅探才出图"是一个不能依赖的前提 ——
 * 本项目此前没有任何页面渲染过远端图片（文件预览一律"下载到本地再打开"），
 * 没有先例证明 octet-stream 在真机上一定出图。
 *
 * 扩展名一定在：objectKey 由 `buildObjectKey` 生成，形状是
 * `{scene}/{userId}/{yyyyMM}/{uuid}.{ext}`。认不出的回 octet-stream，
 * 也就是维持原行为，不会因为这张小表变得更差。
 *
 * ⚠️ 只列图片：本地驱动目前唯一需要正确 MIME 的直连渲染场景就是头像。
 * 以后要让 `<video>` / `<audio>` 也直连，得把这张表补全 —— 或者改成把
 * contentType 落到 `file_asset` 表里（更正确，但要加列 + 迁移）。
 */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  heic: 'image/heic',
};

function contentTypeOfKey(objectKey: string): string {
  const dot = objectKey.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME_BY_EXT[objectKey.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}
