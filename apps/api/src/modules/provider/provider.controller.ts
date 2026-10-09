import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ProviderApplySchema,
  ReviewVerificationSchema,
  Role,
  VerificationListQuerySchema,
  type ProviderApplyDto,
  type ReviewVerificationDto,
  type VerificationListQueryDto,
} from '@qz/core';

import { CurrentUser, Public, Roles, type AuthUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { ProviderService, type ProviderProfileDto, type VerificationItemDto } from './provider.service';

/**
 * 服务者入驻与认证（任务清单 M3-02）
 *
 * ## 权限划分
 *
 * · `POST /provider/apply`、`GET /provider/profile` —— 登录即可（申请自己的认证、看自己的状态）；
 * · `GET /provider/verifications`、`POST /provider/verifications/:id/review` —— **仅管理员**。
 *   审核接口会**授予 provider 角色**，等于发接单权限；不设 RBAC 的话任何用户
 *   都能给自己发一个服务者身份，而"未认证账号无法接单"这条验收标准会当场失效。
 *
 * ## 审核接口为什么现在就有（管理后台还没开工）
 *
 * 没有它，申请提交后**永远停在 pending** —— 用户看到"审核中"等到天荒地老。
 * 接口先落地，管理后台（M0-23）接上去即可；本轮由 `npm run verify:provider`
 * 端到端验证"提交 → 审核通过 → 能接单"整条链路。
 */
@ApiTags('provider')
@Controller('provider')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class ProviderController {
  constructor(private readonly providers: ProviderService) {}

  @Public()
  @Get('schools')
  @ApiOperation({ summary: '学校列表（入驻表单的学校选择器）' })
  schools(): Promise<{ id: string; name: string; city?: string }[]> {
    return this.providers.schools();
  }

  @Post('apply')
  @ApiOperation({ summary: '提交服务者入驻申请（M3-02）' })
  apply(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ProviderApplySchema)) dto: ProviderApplyDto,
  ): Promise<{ verificationId: string; status: string }> {
    return this.providers.apply(user.id, dto);
  }

  @Get('profile')
  @ApiOperation({ summary: '我的服务者资料与认证状态' })
  profile(@CurrentUser() user: AuthUser): Promise<ProviderProfileDto> {
    return this.providers.profile(user.id);
  }

  @Get('verifications')
  @Roles(Role.Admin)
  @ApiOperation({ summary: '认证申请列表（仅管理员）' })
  verifications(
    @Query(new ZodValidationPipe(VerificationListQuerySchema)) query: VerificationListQueryDto,
  ): Promise<{ list: VerificationItemDto[]; total: number }> {
    return this.providers.listVerifications(query);
  }

  @Post('verifications/:id/review')
  @Roles(Role.Admin)
  @ApiOperation({ summary: '审核认证申请：通过 / 驳回（仅管理员）' })
  review(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReviewVerificationSchema)) dto: ReviewVerificationDto,
  ): Promise<VerificationItemDto> {
    return this.providers.review(user.id, id, dto);
  }
}
