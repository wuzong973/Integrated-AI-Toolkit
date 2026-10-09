import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokenService } from './token.service';
import { WechatService } from './wechat.service';

/** 认证模块（任务清单 M0-16） */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, WechatService, TokenService, JwtAuthGuard],
  exports: [AuthService, TokenService, WechatService, JwtAuthGuard],
})
export class AuthModule {}
