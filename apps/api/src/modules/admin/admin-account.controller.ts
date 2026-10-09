import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AdminAccountCreateSchema,
  AdminAccountListQuerySchema,
  AdminAccountUpdateSchema,
  AdminChangePasswordSchema,
  AdminPermission,
  AdminResetPasswordSchema,
  type AdminAccountCreateDto,
  type AdminAccountListQueryDto,
  type AdminAccountUpdateDto,
  type AdminChangePasswordDto,
  type AdminResetPasswordDto,
} from '@qz/core';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { AdminAccountService } from './admin-account.service';
import type { AdminAccountDetail, AdminAccountItem } from './admin-account.service';
import { CurrentAdmin, RequirePermission, type AdminContext } from './admin.decorators';
import { AdminPermissionGuard } from './admin-permission.guard';

/**
 * 管理员账号管理（任务清单 M0-23）
 *
 * 权限点分两档：`AdminView` 看列表与详情，`AdminManage` 做增删改。
 * 只给"看"的账号可以进页面查同事，但动不了任何人 —— 这对"交接排查"有用，
 * 而不必为了看一眼列表就把管理权交出去。
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/admins')
@UseGuards(JwtAuthGuard, AdminPermissionGuard)
export class AdminAccountController {
  constructor(private readonly accounts: AdminAccountService) {}

  @Get()
  @RequirePermission(AdminPermission.AdminView)
  @ApiOperation({ summary: '管理员列表' })
  list(
    @Query(new ZodValidationPipe(AdminAccountListQuerySchema)) query: AdminAccountListQueryDto,
  ): Promise<{ list: AdminAccountItem[]; total: number }> {
    return this.accounts.list(query);
  }

  @Get(':id')
  @RequirePermission(AdminPermission.AdminView)
  @ApiOperation({ summary: '管理员详情（含该角色的权限点）' })
  detail(@Param('id') id: string): Promise<AdminAccountDetail> {
    return this.accounts.detail(id);
  }

  @Post()
  @RequirePermission(AdminPermission.AdminManage)
  @ApiOperation({ summary: '新建管理员' })
  create(
    @CurrentAdmin() admin: AdminContext,
    @Body(new ZodValidationPipe(AdminAccountCreateSchema)) dto: AdminAccountCreateDto,
  ): Promise<AdminAccountDetail> {
    return this.accounts.create(dto, { userId: admin.userId, accountId: admin.accountId });
  }

  @Put(':id')
  @RequirePermission(AdminPermission.AdminManage)
  @ApiOperation({ summary: '编辑管理员（显示名 / 角色 / 状态）' })
  update(
    @CurrentAdmin() admin: AdminContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AdminAccountUpdateSchema)) dto: AdminAccountUpdateDto,
  ): Promise<AdminAccountDetail> {
    return this.accounts.update(id, dto, { userId: admin.userId, accountId: admin.accountId });
  }

  @Delete(':id')
  @RequirePermission(AdminPermission.AdminManage)
  @ApiOperation({ summary: '删除管理员（摘掉后台身份，保留用户）' })
  remove(
    @CurrentAdmin() admin: AdminContext,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    return this.accounts.remove(id, { userId: admin.userId, accountId: admin.accountId });
  }

  @Post(':id/reset-password')
  @RequirePermission(AdminPermission.AdminManage)
  @ApiOperation({ summary: '重置某管理员的密码' })
  resetPassword(
    @CurrentAdmin() admin: AdminContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AdminResetPasswordSchema)) dto: AdminResetPasswordDto,
  ): Promise<{ ok: true }> {
    return this.accounts.resetPassword(id, dto.newPassword, {
      userId: admin.userId,
      accountId: admin.accountId,
    });
  }

  /**
   * 修改**自己**的密码（需验旧密码）。
   *
   * 刻意不挂 `@RequirePermission`：任何在职管理员都应当能改自己的密码，
   * 给它挂一个权限点会变成"只有超管能改自己的密码"这种荒唐结果。
   * 没挂权限点时，`AdminPermissionGuard` 仍会强制"是状态正常的管理员"，
   * 所以它不是匿名接口。
   *
   * 路由放在 `:id` 之前不会有歧义（`me/password` 与 `:id/reset-password`
   * 第二段不同），但仍显式用 `me` 而不是把当前账号 id 拼进 URL ——
   * 后者会让"改别人密码"和"改自己密码"共用一条路径，只差一个参数，
   * 一旦鉴权写错就是越权改他人密码。
   */
  @Post('me/password')
  @ApiOperation({ summary: '修改自己的密码（需提供当前密码）' })
  changeOwnPassword(
    @CurrentAdmin() admin: AdminContext,
    @Body(new ZodValidationPipe(AdminChangePasswordSchema)) dto: AdminChangePasswordDto,
  ): Promise<{ ok: true }> {
    return this.accounts.changeOwnPassword(admin.userId, dto.oldPassword, dto.newPassword);
  }
}
