import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { OrderPayController } from './order-pay.controller';
import { OrderPayService } from './order-pay.service';
import { OrderReviewService } from './order-review.service';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';

/**
 * 订单模块（任务清单 M3-11 / M3-12 / M3-14 / M3-15 / M3-16）
 *
 * ## 为什么现在才补上
 *
 * 小程序端 7 个 `orderApi` 方法的契约早已冻结、页面也早已写好，
 * 但后端一条路由都没注册（`GET /orders` 实测 404），
 * 导致订单列表恒空、详情页是孤岛，且详情页一度出现"假成功"文案。
 *
 * ## 依赖
 *
 * imports: AuthModule —— `JwtAuthGuard` 依赖 `TokenService`，不 import 会在启动时报
 *   "Nest can't resolve dependencies of the JwtAuthGuard"（与 FileModule 同理）。
 * 另依赖全局的 ProvidersModule（支付 Provider）与 PrismaModule，无需显式 import。
 *
 * ## controllers 顺序不是随意的
 *
 * `OrderPayController` 必须排在 `OrderController` **之前** ——
 * 它承担 `POST /orders/pay/notify`，而 OrderController 里有 `POST /orders/:id/deliver`。
 * 虽然第三段字面量不同（notify ≠ deliver）理论上不会误捕，
 * 但把"更具体的路径"先注册是不依赖这种巧合的稳妥做法。
 *
 * ## 评价为什么**不另开一个 controller**
 *
 * M3-16 的读接口是 `/orders/reviews/*`，路径前缀仍属订单，
 * 放进 `OrderController` 就复用了它的 `JwtAuthGuard` 与路由顺序纪律（见其文件头），
 * 也不必动 `app.module.ts` 的注册表。写入端是 `recordAcceptRating()` 这个**函数**
 * 而不是 service —— 它必须跑在 `accept` 已经开启的事务里，做成可注入的服务反而
 * 容易让人在事务外调用它（那时评价与放款就不原子了）。
 */
@Module({
  imports: [AuthModule],
  controllers: [OrderPayController, OrderController],
  providers: [OrderService, OrderPayService, OrderReviewService],
  exports: [OrderService, OrderPayService, OrderReviewService],
})
export class OrderModule {}
