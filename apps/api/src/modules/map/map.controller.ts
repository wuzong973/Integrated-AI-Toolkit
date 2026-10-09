import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { GeoPoint, Providers } from '@qz/core';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PROVIDERS } from '../../infra/providers/providers.module';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { MapPlacesQuerySchema, MapRouteQuerySchema, type MapPlacesQueryDto, type MapRouteQueryDto } from './map.schema';

/**
 * 地图 / 位置服务（高德 Web 服务）
 *
 * ## 为什么要有这一层，而不是让调用方直接用 Provider
 *
 * Provider 是**进程内**的能力抽象（红线 9），小程序够不着。而路线估算必须由服务端算：
 * 高德的 key 只在服务端（前端明文会被嗅探），且服务端调用能缓存、能限流、能换服务商。
 *
 * ## 认证：**刻意不豁免**
 *
 * 每次调用都消耗高德配额，公开出去等于把配额送人。
 * （对比 `/health` 用 `@Public()` 豁免 —— 那是无副作用的只读接口，没有刷的价值。）
 *
 * ⚠️ 认证靠**本类上的 `@UseGuards(JwtAuthGuard)`**，而不是全局守卫 ——
 * 本项目唯一的全局 guard 是 `ThrottlerGuard`（限流），登录校验由各 controller 自己挂。
 * **漏挂不会有任何报错**：接口照常返回 200，只是任何人都能调
 * （2026-09-20 首次验证时实测踩到，是 `verify:map` 的"未登录应 401"一条把它抓出来的）。
 *
 * ## 单位与坐标系（调用方最容易搞错的两件事）
 *
 * · 入参与出参坐标一律 **GCJ-02**（高德/腾讯返回的就是它）；混入 GPS 原始坐标
 *   会有几十到上百米偏移，而**界面上看不出来**；
 * · `distanceMeters` 是**米**、`durationSeconds` 是**秒**（不是分、不是公里）。
 */
@ApiTags('map')
@Controller('map')
@UseGuards(JwtAuthGuard)
export class MapController {
  constructor(@Inject(PROVIDERS) private readonly providers: Providers) {}

  @Get('places')
  @ApiOperation({ summary: '关键词搜索地点（返回坐标、地址、评分、营业时间）' })
  async places(@Query(new ZodValidationPipe(MapPlacesQuerySchema)) query: MapPlacesQueryDto) {
    const places = await this.providers.map.searchPlaces(query.keyword, {
      city: query.city,
      limit: query.limit,
    });
    return { provider: this.providers.map.name, places };
  }

  @Get('route')
  @ApiOperation({ summary: '批量估算「一个起点 → 多个终点」的距离与耗时（GCJ-02，米/秒）' })
  async route(@Query(new ZodValidationPipe(MapRouteQuerySchema)) query: MapRouteQueryDto) {
    const origin = parseCoord(query.origin);
    const destinations = query.destinations.split('|').map(parseCoord);

    const estimates = await this.providers.map.estimateRoutes(origin, destinations, query.mode);

    return {
      /**
       * 实际生效的 Provider 名。
       *
       * 调用方（与验证脚本）据此判断这次拿到的**是不是演示数据** ——
       * 名字以 `mock-` 开头即表示走的是演示实现（红线 10），
       * 界面必须亮"演示模式"角标。不靠"猜服务端配了哪个驱动"。
       */
      provider: this.providers.map.name,
      mode: query.mode,
      /**
       * 与入参 `destinations` **一一对应**；`null` 表示这一条算不出来。
       *
       * ⚠️ 调用方必须**如实处理 `null`**（显示"算不出"），
       * 不能填 0、也不能拿上一条的值顶替 —— 那会让用户看到一段根本不存在的路程。
       */
      estimates,
    };
  }
}

/** `"lng,lat"` → 坐标（格式已由 Zod 校验过，这里只做转换） */
function parseCoord(text: string): GeoPoint {
  const [lng, lat] = text.split(',').map(Number);
  return { lng, lat };
}
