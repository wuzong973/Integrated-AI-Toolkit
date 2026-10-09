import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AdminPermission,
  AdminUserListQuerySchema,
  AdminUserUpdateSchema,
  type AdminUserListQueryDto,
  type AdminUserUpdateDto,
} from '@qz/core';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { CurrentAdmin, RequirePermission, type AdminContext } from './admin.decorators';
import { AdminPermissionGuard } from './admin-permission.guard';
import { AdminUserService } from './admin-user.service';
import type { AdminUserDetail, AdminUserItem } from './admin-user.service';

/**
 * 用户管理（任务清单 M0-23）
 *
 * 这里只有"看"与"改"，**没有"建"和"删"** —— 这是有意的：
 *   · 用户是微信注册产生的（`openid` 来自 `code2Session`），后台凭空建不出微信身份；
 *   · 删除用户会连带删掉订单、作业、审计等所有关联（Cascade），
 *     在担保交易系统里等于销毁证据。要让人不能用，用 `status = banned/disabled`。
 * 需求里的"增删改查"在这个实体上落到"查 + 改"是正确的形态，
 * 而不是为了凑齐四个动词去实现两个会毁数据的接口。
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/users')
@UseGuards(JwtAuthGuard, AdminPermissionGuard)
export class AdminUserController {
  constructor(private readonly users: AdminUserService) {}

  @Get()
  @RequirePermission(AdminPermission.UserView)
  @ApiOperation({ summary: '用户列表（昵称 / 手机号 / 真实姓名模糊搜索）' })
  list(
    @Query(new ZodValidationPipe(AdminUserListQuerySchema)) query: AdminUserListQueryDto,
  ): Promise<{ list: AdminUserItem[]; total: number }> {
    return this.users.list(query);
  }

  @Get(':id')
  @RequirePermission(AdminPermission.UserView)
  @ApiOperation({ summary: '用户详情（含认证、订单与作业统计）' })
  detail(@Param('id') id: string): Promise<AdminUserDetail> {
    return this.users.detail(id);
  }

  @Put(':id')
  @RequirePermission(AdminPermission.UserManage)
  @ApiOperation({ summary: '修改用户状态 / 角色（写入审计日志）' })
  update(
    @CurrentAdmin() admin: AdminContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AdminUserUpdateSchema)) dto: AdminUserUpdateDto,
  ): Promise<AdminUserDetail> {
    return this.users.update(id, dto, { userId: admin.userId });
  }
}
