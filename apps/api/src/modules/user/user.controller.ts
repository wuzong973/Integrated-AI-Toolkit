import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UpdateProfileSchema, type UpdateProfileDto } from '@qz/core';

import { CurrentUser, type AuthUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { UserService, type UserDetail } from './user.service';

@ApiTags('user')
@ApiBearerAuth()
@Controller('user')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get('me')
  @ApiOperation({ summary: '我的资料（含画像与统计）' })
  me(@CurrentUser() user: AuthUser): Promise<UserDetail> {
    return this.users.getMe(user.id);
  }

  @Put('me')
  @ApiOperation({ summary: '更新我的资料' })
  update(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(UpdateProfileSchema)) dto: UpdateProfileDto,
  ): Promise<UserDetail> {
    return this.users.updateMe(user.id, dto);
  }

  @Get('roles')
  @ApiOperation({ summary: '我的身份列表（一账号多身份）' })
  roles(@CurrentUser() user: AuthUser) {
    return this.users.listRoles(user.id);
  }

  @Get('credit')
  @ApiOperation({ summary: '我的信用分与流水' })
  credit(@CurrentUser() user: AuthUser) {
    return this.users.getCredit(user.id);
  }

  @Get('points')
  @ApiOperation({ summary: '我的积分与流水' })
  points(@CurrentUser() user: AuthUser) {
    return this.users.getPoints(user.id);
  }

  @Get('wallet')
  @ApiOperation({ summary: '我的钱包与资金流水' })
  wallet(@CurrentUser() user: AuthUser) {
    return this.users.getWallet(user.id);
  }
}
