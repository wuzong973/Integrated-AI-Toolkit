import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, seconds } from '@nestjs/throttler';
import { LoginSchema, RefreshSchema, type LoginDto, type RefreshDto } from '@qz/core';

import { CurrentUser, Public, type AuthUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

import { AuthService, type LoginResult, type MeResult } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * 登录接口的独立限流（排查报告 P2-5）。
 *
 * ## 为什么要比全局更紧
 *
 * 全局是 `THROTTLE_LIMIT=120`/分钟，对登录这种**每次调用都会打到微信上游**
 * （`code2Session`）的接口太宽松 —— 被刷时会连带消耗微信侧的调用配额。
 *
 * ## 为什么是 30 而不是 10
 *
 * 登录限流是**按 IP** 的，而校园网 / 宿舍出口普遍是 NAT：
 * 一栋楼几百个学生共享同一个公网 IP。按 10/分钟卡，**开学首日会误伤整栋楼**
 * —— 这是比被刷更严重的可用性事故。
 * 30/分钟既能把刷接口的成本抬高 4 倍，又留出了 NAT 共享的余量。
 *
 * ## 为什么写死在装饰器里而不是读 .env
 *
 * 装饰器在**类定义时**求值，早于 DI 容器建立，拿不到 `ConfigService`。
 * 要让它可配置，得改成自定义 Guard（用 `Reflector` + 配置读取），
 * 对一个"保守常量"来说是过度设计。真要调，改这里的数字即可。
 *
 * ## 为什么只收紧 login、不收紧 refresh
 *
 * `refresh` 是**客户端自动触发**的（401 后静默重放），用户无感。
 * 给它设紧上限会把"token 刚好过期"这种正常场景变成登录失败。
 */
const LOGIN_THROTTLE_LIMIT = 30;
const LOGIN_THROTTLE_TTL_SECONDS = 60;

@ApiTags('auth')
@Controller('auth')
@UseGuards(JwtAuthGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @Throttle({ default: { limit: LOGIN_THROTTLE_LIMIT, ttl: seconds(LOGIN_THROTTLE_TTL_SECONDS) } })
  @ApiOperation({ summary: '微信登录：code 换 token' })
  login(@Body(new ZodValidationPipe(LoginSchema)) dto: LoginDto): Promise<LoginResult> {
    return this.auth.login(dto.code);
  }

  @Public()
  @Post('refresh')
  @ApiOperation({ summary: '刷新 accessToken' })
  refresh(@Body(new ZodValidationPipe(RefreshSchema)) dto: RefreshDto): Promise<LoginResult> {
    return this.auth.refresh(dto.refreshToken);
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: '获取当前用户态（登录态冷启动恢复）' })
  me(@CurrentUser() user: AuthUser): Promise<MeResult> {
    return this.auth.buildMe(user.id);
  }
}
