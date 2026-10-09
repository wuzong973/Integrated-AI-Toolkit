import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, type AuthUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import {
  NotificationListQuerySchema,
  type NotificationListQueryDto,
  type NotificationPageDto,
} from './dto/notification.dto';
import { NotificationService } from './notification.service';

/**
 * 站内信（任务清单 M3-19）
 *
 * 路由与 `apps/mp/utils/api.ts` 的 `messageApi` 一一对应（`audit:api` 会核对）。
 * 全部需要登录：通知是纯私有数据，没有任何一条可以匿名读。
 *
 * ## 路由顺序
 *
 * `POST /notifications/read-all`（两段）与 `POST /notifications/:id/read`（三段）
 * 段数不同，理论上不会互相误捕；但仍把**字面量在前**写下来 ——
 * 本项目在 `/tools/categories`、`/orders/reviews/*` 上反复为这类巧合付过学费
 * （一旦以后有人把 `:id/read` 改成 `:id/*`，靠段数侥幸的写法会立刻变成"点了已读却 404"）。
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  @ApiOperation({ summary: '我的通知（分页 + 未读数 unreadCount；type=order|task|system 可筛）' })
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(NotificationListQuerySchema)) query: NotificationListQueryDto,
  ): Promise<NotificationPageDto> {
    return this.notifications.list(user.id, query);
  }

  @Post('read-all')
  @ApiOperation({ summary: '全部标记已读（返回真正变化的条数，供前端清零角标）' })
  readAll(@CurrentUser() user: AuthUser): Promise<{ updated: number }> {
    return this.notifications.markAllRead(user.id);
  }

  @Post(':id/read')
  @ApiOperation({ summary: '标记单条已读（重复调用仍成功；不是本人的一律 404）' })
  read(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ id: string; read: boolean }> {
    return this.notifications.markRead(user.id, id);
  }
}
