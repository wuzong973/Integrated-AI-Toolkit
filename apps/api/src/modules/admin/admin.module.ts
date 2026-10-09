import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { JobModule } from '../job/job.module';
import { OrderModule } from '../order/order.module';
import { ProviderModule } from '../provider/provider.module';

import { AdminAccountController } from './admin-account.controller';
import { AdminAccountService } from './admin-account.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminContentController } from './admin-content.controller';
import { AdminContentService } from './admin-content.service';
import { AdminAuditController, AdminDashboardController } from './admin-dashboard.controller';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminJobController } from './admin-job.controller';
import { AdminJobService } from './admin-job.service';
import { AdminOrderController } from './admin-order.controller';
import { AdminOrderService } from './admin-order.service';
import { AdminPermissionGuard } from './admin-permission.guard';
import { AdminUserController } from './admin-user.controller';
import { AdminUserService } from './admin-user.service';
import { PasswordService } from './password.service';

/**
 * 管理后台模块（任务清单 M0-23）
 *
 * ## 依赖方向
 *
 * ```
 *   AdminModule ──→ JobModule / OrderModule / ProviderModule   （复用业务实现）
 *        │                  ↑
 *        └──→ AuthModule ───┘  （JwtAuthGuard 需要 TokenService）
 * ```
 *
 * 方向是**单向的**：管理域可以依赖业务域，业务域**不得**依赖管理域。
 * 之所以强调：审核接口最早落在 `ProviderModule`（那时后台还没开工），
 * 本模块的门面是转发到 `ProviderService` —— 若反过来让 ProviderModule
 * 依赖 AdminModule 拿守卫，就会形成 import 环，Nest 启动直接失败。
 *
 * ## 为什么复用而不是各写一份
 *
 *   · 放款 / 退款 → `OrderPayService`（唯一一份资金实现，见 `AdminOrderService` 注释）
 *   · 审核        → `ProviderService.review`（带乐观锁，会授予 provider 角色）
 *   · 重跑作业    → `JobRetryService`（会**重新预扣积分**，不能自己建作业绕过计费）
 *
 * ## PrismaModule / ModerationModule 为何不在这里 import
 *
 * 两者都是 `@Global`（见 `prisma.module.ts`）。重复 import 不会报错，
 * 但会给人一种"依赖是显式声明的"的错觉 —— 实际上漏了也不会失败。
 *
 * ## 导出
 *
 * `AdminAuditService` / `AdminPermissionGuard` / `PasswordService` 导出给
 * 其它模块复用（例如将来某个业务模块想给自己的管理员接口挂权限守卫）。
 */
@Module({
  imports: [AuthModule, JobModule, OrderModule, ProviderModule],
  controllers: [
    AdminAuthController,
    AdminAccountController,
    AdminUserController,
    AdminContentController,
    AdminJobController,
    AdminOrderController,
    AdminDashboardController,
    AdminAuditController,
  ],
  providers: [
    PasswordService,
    AdminAuditService,
    AdminPermissionGuard,
    AdminAuthService,
    AdminAccountService,
    AdminUserService,
    AdminContentService,
    AdminJobService,
    AdminOrderService,
    AdminDashboardService,
  ],
  exports: [PasswordService, AdminAuditService, AdminPermissionGuard],
})
export class AdminModule {}
