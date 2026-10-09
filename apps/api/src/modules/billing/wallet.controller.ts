import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, type AuthUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { CreateWithdrawalSchema, type CreateWithdrawalDto } from './dto/withdrawal.dto';
import { WithdrawalService } from './withdrawal.service';

/**
 * 钱包（任务清单 M3-13 提现部分）
 *
 * 路由前缀 `wallet`，与既有的 `GET /user/wallet`（余额 + 资金流水，UserModule）分工：
 * 只读聚合留在 user 模块，**资金变动的写入口**在这里 —— 避免两处各写一遍余额。
 *
 * 全部需要登录：余额、流水、提现单都是本人财务数据。
 * 金额字段（请求与响应）单位一律「分」，前端负责展示成元。
 *
 * ⚠️ 没有 review 接口：管理后台（M3-20）未开工，提现单停在 pending，
 * 详见 `withdrawal.service.ts` 的类注释（含补接口时要一并处理的两件事）。
 */
@ApiTags('wallet')
@ApiBearerAuth()
@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private readonly withdrawals: WithdrawalService) {}

  @Post('withdrawals')
  @ApiOperation({ summary: '申请提现（10 元起提，实时扣余额，返回 pending 单）' })
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateWithdrawalSchema)) dto: CreateWithdrawalDto,
  ) {
    return this.withdrawals.create(user.id, dto);
  }

  @Get('withdrawals')
  @ApiOperation({ summary: '我的提现记录（按申请时间倒序，最多 50 条）' })
  list(@CurrentUser() user: AuthUser) {
    return this.withdrawals.list(user.id);
  }
}
