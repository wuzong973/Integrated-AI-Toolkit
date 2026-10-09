import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { BillingService } from './billing.service';
import { WalletController } from './wallet.controller';
import { WithdrawalService } from './withdrawal.service';

/**
 * 账务模块（任务清单 M1-06 积分计费 + M3-13 钱包提现）
 *
 * BillingService 仍是**纯领域服务**：积分余额与流水的对外出口已存在
 * （`GET /user/points`、`GET /user/wallet`，见 UserModule），不再开同义接口。
 *
 * WalletController 是后加的一半：提现是**资金写操作**，只读接口给不了它语义
 * （`POST /wallet/withdrawals`、`GET /wallet/withdrawals`）。
 * 它只动 `wallet.balance` 与 `wallet_ledger`，**不碰 `wallet.points`** ——
 * 积分那条线的纪律仍然是"除 BillingService 之外禁止写积分"。
 *
 * 依赖：
 *   PrismaModule / LoggerModule 均为全局，无需显式 import；
 *   AuthModule —— WalletController 用了 JwtAuthGuard，而它依赖 AuthModule 的
 *   TokenService。子模块的 imports 不会传递，本模块必须自己 import 一次，
 *   否则启动报 "Nest can't resolve dependencies of the JwtAuthGuard (?, Reflector)"。
 */
@Module({
  imports: [AuthModule],
  controllers: [WalletController],
  providers: [BillingService, WithdrawalService],
  exports: [BillingService, WithdrawalService],
})
export class BillingModule {}
