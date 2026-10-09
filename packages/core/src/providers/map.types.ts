/**
 * 地图 / 位置服务 Provider（红线 9：业务代码只依赖接口，不直接依赖第三方 SDK）
 *
 * ## ⚠️ 坐标系：一律 GCJ-02（火星坐标）
 *
 * 中国境内**必须**用 GCJ-02。高德 / 腾讯 / 百度返回的都是它（百度是 BD-09，需要转换）。
 * 若把 GPS 原始坐标（WGS-84）直接当 GCJ-02 用，会有**几十到上百米**的偏移 ——
 * 这个错**看起来完全正常**（地图能画出来、路线也能算），只有实地走一遍才发现偏了一条街。
 * 所以本接口的 `GeoPoint` 一律是 GCJ-02，转换责任在实现侧，不在调用方。
 *
 * ## ⚠️ 单位：米 / 秒
 *
 * `distanceMeters` 是**米**、`durationSeconds` 是**秒**（不是分、不是公里）。
 * 项目有过"金额单位混用差 100 倍"的前车之鉴 —— 距离与时间同样会踩，
 * 所以字段名直接把单位写进去，不给"猜"的机会。
 *
 * ## 合规红线（不可协商）
 *
 * 地图与路线服务**只能用腾讯、高德、百度、天地图**。
 * Google Maps / Apple Maps / Bing 海外版 / Mapbox / OpenStreetMap 直连均不合规。
 * 本接口是抽象层，具体实现必须落在白名单服务商上。
 *
 * ## 为什么 `estimateRoutes` 返回 `(X | null)[]` 而不是过滤掉失败项
 *
 * 调用方拿到的是**与入参一一对应**的数组，算不出的位置是 `null`。
 * 若实现里把失败项过滤掉，调用方就只能按下标"猜"哪个对应哪个 ——
 * 猜错的表现是"这段路的距离显示成了下一段的"，而界面上看不出任何异常。
 * **宁可返回 null 让调用方如实处理，也不要让对应关系变得不可知。**
 */

/** 坐标点（**GCJ-02 火星坐标**，见文件头） */
export interface GeoPoint {
  /** 经度 */
  lng: number;
  /** 纬度 */
  lat: number;
}

/**
 * 出行方式。
 *
 * ⚠️ 刻意只有两种：这两种是所有合规服务商都支持**批量**估算的。
 * 骑行 / 公交要逐个调路径规划接口（配额消耗是批量接口的 N 倍），
 * 在真正需要之前不写进接口 —— 声明了却给不出结果，比不声明更糟。
 */
export type TravelMode = 'walking' | 'driving';

/** 两点之间的通行估算 */
export interface RouteEstimate {
  /** 距离（**米**） */
  distanceMeters: number;
  /** 预计耗时（**秒**） */
  durationSeconds: number;
}

/** 地点（POI） */
export interface PlaceHit {
  /** 服务商侧的 POI id */
  id: string;
  name: string;
  /** 完整地址；服务商没给时为空串 */
  address: string;
  location: GeoPoint;
  /** 分类，如「风景名胜;公园广场」；没有则为空串 */
  type: string;
  /** 评分（字符串，服务商原样返回，如 "4.8"）；没有则为空串 */
  rating: string;
  /** 营业时间；没有则为空串 */
  openTime: string;
}

export interface PlaceSearchOptions {
  /** 限定城市（城市名或 adcode）；不传则全国搜 */
  city?: string;
  /** 最多返回几条，默认 10 */
  limit?: number;
}

export interface MapProvider {
  readonly name: string;

  /** 关键词搜地点（用户输入"武侯祠"→ 拿到坐标与地址） */
  searchPlaces(keyword: string, opts?: PlaceSearchOptions): Promise<PlaceHit[]>;

  /** 地址 → 坐标；解析不出返回 `null`（**不返回一个"大概差不多"的坐标**） */
  geocode(address: string, city?: string): Promise<GeoPoint | null>;

  /**
   * 批量估算「一个起点 → 多个终点」的距离与耗时。
   *
   * 返回数组与 `destinations` **一一对应**，算不出的位置是 `null`（见文件头说明）。
   */
  estimateRoutes(
    origin: GeoPoint,
    destinations: GeoPoint[],
    mode: TravelMode,
  ): Promise<(RouteEstimate | null)[]>;
}
