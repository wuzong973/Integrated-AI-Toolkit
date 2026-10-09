import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ServiceCreateSchema,
  ServiceListQuerySchema,
  type ServiceCreateDto,
  type ServiceListQueryDto,
} from '@qz/core';

import { CurrentUser, Public, type AuthUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import type { ServiceItemDto } from './dto/service.dto';
import { ServiceMarketQuerySchema, type ServiceMarketQueryDto } from './dto/service-query.dto';
import { ServiceWriteService } from './service-write.service';
import { ServiceService, type ServicePage } from './service.service';

/**
 * 服务商品（任务清单 M3-04）
 *
 * 路径前缀 `/services`（对外全路径带全局前缀与版本：`/api/v1/services`）。
 *
 * ## 类上挂了 `JwtAuthGuard`，但浏览类接口标了 `@Public()`
 *
 * 与驿站同一套语义：`@Public()` 的接口**有 token 也解析** `req.user`。
 * 详情接口因此能区分"下架的商品——本人打得开、别人 404"；
 * 不挂守卫则 `req.user` 恒为 undefined，这个判定根本做不出来。
 *
 * ## 路由顺序（⚠️ 改动时别调）
 *
 * `GET mine` 必须声明在 `GET :id` **之前**。两者段数相同，
 * 若把 `:id` 放前面，`/services/mine` 会被当成 id="mine" 去查库 ——
 * 结果是 404「服务不存在」，而真实原因是路由被误捕（`/tools/categories` 踩过，M1-01）。
 *
 * ## 两条列表路由刻意用**不同**的查询 schema
 *
 * `GET`（市场）用 `ServiceMarketQuerySchema`（core 公共口径 + `providerId`），
 * `GET mine` 用 core 的 `ServiceListQuerySchema`（**不含** `providerId`）：
 * 「我的」这一侧的服务者身份只认 token。少这一道区分，查询串里塞一个别人的 id
 * 就能把"我的下架商品"变成"任何人的下架商品"。
 */
@ApiTags('service')
@Controller('services')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class ServiceController {
  constructor(
    private readonly services: ServiceService,
    private readonly writes: ServiceWriteService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: '服务市场列表（只出已上架；分类 / 关键词 / 服务者 / 分页）' })
  list(
    @Query(new ZodValidationPipe(ServiceMarketQuerySchema)) query: ServiceMarketQueryDto,
  ): Promise<ServicePage> {
    return this.services.listServices(query);
  }

  @Get('mine')
  @ApiOperation({ summary: '我上架的服务（含已下架，仅本人）' })
  mine(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(ServiceListQuerySchema)) query: ServiceListQueryDto,
  ): Promise<ServicePage> {
    return this.services.listMine(user.id, query);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: '服务详情（公开；已下架仅本人可见）' })
  detail(@Param('id') id: string, @CurrentUser() user?: AuthUser): Promise<ServiceItemDto> {
    return this.services.getService(id, user?.id);
  }

  @Post()
  @ApiOperation({ summary: '上架服务（仅认证服务者，文本先过内容安全）' })
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ServiceCreateSchema)) dto: ServiceCreateDto,
  ): Promise<ServiceItemDto> {
    return this.writes.create(user.id, dto);
  }

  @Post(':id/off')
  @ApiOperation({ summary: '下架（仅本人）' })
  off(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ id: string; status: string }> {
    return this.writes.off(user.id, id);
  }

  @Post(':id/on')
  @ApiOperation({ summary: '重新上架（仅本人）' })
  on(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ id: string; status: string }> {
    return this.writes.on(user.id, id);
  }
}
