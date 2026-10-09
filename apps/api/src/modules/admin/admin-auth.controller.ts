import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, seconds } from '@nestjs/throttler';
import type { Request } from 'express';
import { AdminLoginSchema, type AdminLoginDto } from '@qz/core';

import { CurrentUser, Public, type AuthUser } from '../../common/decorators';
import { currentTraceId } from '../../common/logger/trace.context';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { AdminPermissionGuard } from './admin-permission.guard';
import { AdminAuthService, type AdminLoginResult, type AdminProfile } from './admin-auth.service';

/**
 * 后台登录态（任务清单 M0-23）
 *
 * 路径前缀 `/admin`，与 C 端接口分开：这样在网关 / 日志 / 限流上可以整体
 * 按前缀区分优先级（后台的 `GET /admin/users` 与可能出现的小程序同名接口
 * 不会互相干扰），也让"哪些接口是后台的"一眼可查。
 *
 * ## 登录限流比 C 端登录更紧（10/分钟 vs 30/分钟）
 *
 * C 端登录来自校园网 NAT，几百人共享一个出口 IP，卡太紧会误伤整栋楼
 * （见 `auth.controller.ts` 的说明）。后台不同：**管理员的公网 IP 是个位数量级**，
 * 10/分钟对正常使用绰绰有余，却能显著抬高密码爆破成本。这两个数字不一样是有意的，
 * 不是抄漏了。
 */
const ADMIN_LOGIN_THROTTLE_LIMIT = 10;
const ADMIN_LOGIN_THROTTLE_TTL_SECONDS = 60;

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/auth')
@UseGuards(JwtAuthGuard, AdminPermissionGuard)
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Public()
  @Post('login')
  @Throttle({
    default: { limit: ADMIN_LOGIN_THROTTLE_LIMIT, ttl: seconds(ADMIN_LOGIN_THROTTLE_TTL_SECONDS) },
  })
  @ApiOperation({ summary: '后台登录：用户名 + 密码 → token' })
  login(
    @Body(new ZodValidationPipe(AdminLoginSchema)) dto: AdminLoginDto,
    @Req() req: Request,
  ): Promise<AdminLoginResult> {
    return this.auth.login(dto.username, dto.password, {
      ip: req.ip,
      traceId: currentTraceId(),
    });
  }

  @Get('me')
  @ApiOperation({ summary: '当前管理员资料与权限点（前端据此渲染菜单）' })
  me(@CurrentUser() user: AuthUser): Promise<AdminProfile> {
    return this.auth.profile(user.id);
  }

  /**
   * 退出登录。
   *
   * ⚠️ 这是**客户端行为**：JWT 无状态，服务端不保存会话，所以本接口不吊销 token
   * （前端清掉本地存储即视为退出）。这对后台是个已知弱点 —— 被窃取的 token
   * 在过期前仍然有效。
   *
   * 之所以敢这样取舍：本设计里**每次请求都会回查 `admin_account`**，
   * 所以真正需要的控制手段（禁用账号、降权）是**立刻生效**的，
   * 不依赖"退出登录"来兜底。真正的 token 吊销需要引入服务端黑名单或
   * 短生命周期 + refresh 轮转，属于后续独立工作，不在这里假装做到了。
   */
  @Post('logout')
  @ApiOperation({ summary: '退出登录（客户端丢弃 token；服务端不吊销）' })
  logout(): { ok: true } {
    return { ok: true };
  }
}
