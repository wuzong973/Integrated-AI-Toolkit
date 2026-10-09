import { Body, Controller, Delete, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ConfirmFileSchema,
  FileListQuerySchema,
  PresignSchema,
  type ConfirmFileDto,
  type FileListQueryDto,
  type PresignDto,
} from '@qz/core';
import type { Response } from 'express';

import { CurrentUser, Public, type AuthUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { FileService, type FileItem } from './file.service';

/**
 * 文件资产（任务清单 M0-12 / 文档 9.2.2）
 *
 * 全部需要登录：文件是私有资产，归属校验依赖 userId。
 * 上传主链路是「presign → 客户端直传对象存储 → confirm」，本控制器不接收二进制。
 */
@ApiTags('file')
@ApiBearerAuth()
@Controller('files')
@UseGuards(JwtAuthGuard)
export class FileController {
  constructor(private readonly files: FileService) {}

  @Post('presign')
  @ApiOperation({ summary: '获取直传签名（含大小与类型校验）' })
  presign(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(PresignSchema)) dto: PresignDto,
  ) {
    return this.files.presign(user.id, dto);
  }

  @Post('confirm')
  @ApiOperation({ summary: '确认上传完成，生成文件记录' })
  confirm(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ConfirmFileSchema)) dto: ConfirmFileDto,
  ): Promise<FileItem> {
    return this.files.confirm(user.id, dto);
  }

  @Get('storage')
  @ApiOperation({ summary: '存储用量统计' })
  storage(@CurrentUser() user: AuthUser) {
    return this.files.storageUsage(user.id);
  }

  /**
   * 头像公开读（`GET /files/public/:id` → 302 到签名地址）。
   *
   * 为什么 `@Public`：小程序的 `<image src>` 带不了 `Authorization` 头，
   * 也没有"先换签名地址再渲染"的时机 —— 头像地址必须是能直接打开的。
   * 服务端只放行 `scene === 'avatar'`，其余场景一律 404，见 `FileService.publicAvatarUrl`。
   *
   * 用 `@Res()` 是为了回 302 而不是统一响应体；抛异常发生在写响应之前，
   * 仍会走 `GlobalExceptionFilter`（与 `LocalStorageController.download` 同一写法）。
   */
  @Public()
  @ApiExcludeEndpoint()
  @Get('public/:id')
  @ApiOperation({ summary: '头像公开访问（仅 avatar 场景，302 到签名地址）' })
  async publicAvatar(@Param('id') id: string, @Res() res: Response): Promise<void> {
    res.redirect(302, await this.files.publicAvatarUrl(id));
  }

  @Get()
  @ApiOperation({ summary: '我的文件列表（支持场景筛选与回收站）' })
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(FileListQuerySchema)) query: FileListQueryDto,
  ): Promise<FileItem[]> {
    return this.files.list(user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: '文件详情' })
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.files.detail(user.id, id);
  }

  @Get(':id/download')
  @ApiOperation({ summary: '获取下载地址（短时效签名 URL）' })
  download(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.files.downloadUrl(user.id, id);
  }

  @Post(':id/restore')
  @ApiOperation({ summary: '从回收站恢复' })
  async restore(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<{ ok: true }> {
    await this.files.restore(user.id, id);
    return { ok: true };
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除文件（进回收站，可恢复）' })
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<{ ok: true }> {
    await this.files.remove(user.id, id);
    return { ok: true };
  }
}
