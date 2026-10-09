/**
 * Mock 地图 Provider（红线 10：演示数据必须能被认出来）
 *
 * ## 为什么演示实现"敢"返回估算值
 *
 * 因为整条链路都带着标记：`name` 是 `mock-map`（`isMockProvider` 据此判定），
 * 响应会带 `X-Provider: mock`、界面会亮"演示模式"角标。
 * 用户看到距离数字时，角标已经告诉他"这是演示数据"。
 *
 * ## 两条刻意的"不假装"
 *
 * 1. **`geocode` 返回 `null`**，不编一个"看起来对"的坐标 ——
 *    演示数据一旦看起来像真的，排查时就会被当成真的（项目踩过：
 *    `matchScore: Math.max(60, 95 - i * 7)` 内联假数据，界面上毫无异样）。
 * 2. **搜索结果的坐标是 `(0, 0)`**（几内亚湾），任何真实场景下都不可能命中 ——
 *    谁把它当真实坐标用，结果会立刻错得很明显，而不是错得看不出来。
 */
import type {
  GeoPoint,
  MapProvider,
  PlaceHit,
  PlaceSearchOptions,
  RouteEstimate,
  TravelMode,
} from '../map.types';

/** 地球平均半径（米） */
const EARTH_RADIUS_M = 6371000;

/** 演示用的平均速度（米/秒）：步行 1.2；驾车 8.3（约 30km/h，含路口等待） */
const SPEED: Record<TravelMode, number> = { walking: 1.2, driving: 8.3 };

/** 绕行系数：真实路线总比直线长，用它让演示数据不至于离谱（**仍是估算，不是路线**） */
const DETOUR = 1.4;

/** 两点球面距离（米） */
function haversine(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export class MockMapProvider implements MapProvider {
  readonly name = 'mock-map';

  async searchPlaces(keyword: string, opts?: PlaceSearchOptions): Promise<PlaceHit[]> {
    const kw = String(keyword ?? '').trim() || '地点';
    const limit = Math.max(1, Math.min(opts?.limit ?? 1, 10));
    return Array.from({ length: limit }, (_, i) => ({
      id: `mock-${i + 1}`,
      name: `${kw}（演示）`,
      address: '演示数据，不是真实地点',
      location: { lng: 0, lat: 0 },
      type: '',
      rating: '',
      openTime: '',
    }));
  }

  /** 演示实现**不猜坐标** —— 编一个"看起来对"的坐标比返回 null 更糟（见文件头） */
  async geocode(): Promise<GeoPoint | null> {
    return null;
  }

  async estimateRoutes(
    origin: GeoPoint,
    destinations: GeoPoint[],
    mode: TravelMode,
  ): Promise<(RouteEstimate | null)[]> {
    const speed = SPEED[mode];
    return destinations.map((dest) => {
      const straight = haversine(origin, dest);
      if (!Number.isFinite(straight) || straight <= 0) return null;
      const distanceMeters = Math.round(straight * DETOUR);
      return { distanceMeters, durationSeconds: Math.round(distanceMeters / speed) };
    });
  }
}
