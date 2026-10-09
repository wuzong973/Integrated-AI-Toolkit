/**
 * 地图 / 位置服务（类型 + 调用表）
 *
 * ## 为什么类型和调用一起放这里，而不是把类型放进 `api-types.ts`
 *
 * 与消息域（`notification-api.ts`）同样的理由：这组契约**要成对读才说得清** ——
 * "坐标是什么坐标系""单位是米还是公里""算不出的那一条怎么表示"，
 * 都是调用方最容易搞错、而类型定义本身表达不了的东西。
 *
 * 另一个现实原因：`api-types.ts` 已经贴着 300 行上限，再塞 40 行会直接超。
 *
 * ## 三条必须记住的约定
 *
 * 1. **坐标一律 GCJ-02**（高德/腾讯返回的就是它）—— 混入 GPS 原始坐标会有
 *    几十到上百米偏移，而**界面上完全看不出来**；
 * 2. **单位一律米 / 秒**（字段名把单位写死，不给"猜"的机会）；
 * 3. **`estimates` 与入参 `destinations` 一一对应**，算不出的位置是 `null` ——
 *    调用方必须如实显示"算不出"，**不能填 0、也不能拿上一条顶替**，
 *    那会让用户看到一段根本不存在的路程。
 *
 * ## 两个接口都需要登录
 *
 * 每次调用消耗高德配额，公开等于把配额送人。所以未登录时调用会 401 并自动跳登录页 ——
 * **这是刻意的**。行程页因此把它做成"用户主动点"的动作，而不是进页面就自动算。
 */
import { http } from './request';

/** 坐标点（**GCJ-02**） */
export interface MapGeoPoint {
  lng: number;
  lat: number;
}

/** 地点（对应后端 `GET /map/places`） */
export interface MapPlaceHit {
  id: string;
  name: string;
  address: string;
  location: MapGeoPoint;
  /** 分类，如「风景名胜;公园广场」；没有则空串 */
  type: string;
  /** 评分（服务商原样返回的字符串，如 `"4.8"`）；没有则空串 */
  rating: string;
  /** 营业时间；没有则空串 */
  openTime: string;
}

/** 一段路的估算 */
export interface MapRouteEstimate {
  /** 距离（**米**） */
  distanceMeters: number;
  /** 预计耗时（**秒**） */
  durationSeconds: number;
}

/** 路线估算结果（对应后端 `GET /map/route`） */
export interface MapRouteResult {
  /** 实际生效的 Provider 名；以 `mock-` 开头即表示演示数据（红线 10） */
  provider: string;
  mode: 'walking' | 'driving';
  /** 与请求里的 `destinations` **一一对应**；`null` 表示这一条算不出来 */
  estimates: (MapRouteEstimate | null)[];
}

export const mapApi = {
  /** 关键词搜地点（返回坐标、地址、评分、营业时间） */
  places: (keyword: string, opts?: { city?: string; limit?: number }) =>
    http.get<MapPlaceHit[]>('/map/places', { params: { keyword, ...opts } }),

  /** 批量估算「一个起点 → 多个终点」，返回顺序与 `destinations` 一致 */
  route: (origin: string, destinations: string[], mode: 'walking' | 'driving' = 'walking') =>
    http.get<MapRouteResult>('/map/route', {
      params: { origin, destinations: destinations.join('|'), mode },
    }),
};
