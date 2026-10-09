import { z } from 'zod';

/** 坐标字符串：`lng,lat`（GCJ-02） */
const COORD_RE = /^-?\d{1,3}(\.\d+)?,-?\d{1,2}(\.\d+)?$/;

/** 单次请求最多几个终点 —— 防止一次传上千个把配额刷掉 */
const MAX_DESTINATIONS = 100;

/**
 * 路线估算查询参数。
 *
 * ⚠️ `destinations` 是 `lng,lat|lng,lat` 形式的**一整串**，所以必须**逐段**校验
 * （只校验整串非空的话，`"116.4,39.9|乱码"` 会通过，然后在解析处变成 `NaN` 坐标 ——
 * 而 `NaN` 传给地图服务只会得到一个语焉不详的失败）。
 */
export const MapRouteQuerySchema = z.object({
  origin: z.string().regex(COORD_RE, '起点坐标格式应为 `lng,lat`'),
  destinations: z
    .string()
    .min(1, '至少要给一个终点')
    .refine(
      (s) => s.split('|').every((c) => COORD_RE.test(c)),
      '每个终点都要是 `lng,lat` 格式，多个终点用 `|` 分隔',
    )
    .refine(
      (s) => s.split('|').length <= MAX_DESTINATIONS,
      `一次最多 ${MAX_DESTINATIONS} 个终点`,
    ),
  mode: z.enum(['walking', 'driving']).default('walking'),
});

export type MapRouteQueryDto = z.infer<typeof MapRouteQuerySchema>;

/**
 * 地点搜索查询参数。
 *
 * `limit` 上限 25 是**服务商的硬限制**（高德 `offset` 最大 25）——
 * 这里就夹住，而不是让请求发出去再由服务商报错：
 * 服务商报错时用户看到的是"搜索失败"，而真正的原因是"要得太多了"。
 */
export const MapPlacesQuerySchema = z.object({
  keyword: z.string().trim().min(1, '请输入要搜索的地点').max(60),
  city: z.string().trim().max(30).optional(),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

export type MapPlacesQueryDto = z.infer<typeof MapPlacesQuerySchema>;
