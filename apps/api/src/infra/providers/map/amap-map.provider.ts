import {
  BizException,
  ErrorCode,
  type GeoPoint,
  type MapProvider,
  type PlaceHit,
  type PlaceSearchOptions,
  type RouteEstimate,
  type TravelMode,
} from '@qz/core';

import type { AppConfig } from '../../../common/config/configuration';
import type { AppLogger } from '../../../common/logger/logger.service';

/**
 * 地图 / 位置服务 —— 高德 Web 服务实现
 *
 * ## 为什么用裸 fetch，不引官方 SDK
 *
 * 与 LLM / OCR / ASR / Embedding / Qdrant 五个 Provider 保持一致：
 * 这几个接口都是简单的 HTTP GET，SDK 带来的只有体积与版本耦合。
 *
 * ## ⚠️ 三个必须写下来的坑（都实测过）
 *
 * ### 1. 高德用 **HTTP 200 + `status:"0"`** 表示失败
 *
 * key 无效、配额用尽、参数错，HTTP 状态码**全是 200**，失败写在响应体里。
 * 只看 `res.ok` 会把失败当成功，然后拿着一个没有 `pois` 字段的对象往下走 ——
 * 表现是"搜到了 0 个地点"，而真正的原因可能是 key 类型选错了。
 *
 * ### 2. 空值是**空数组 `[]`**，不是空串
 *
 * 高德对"没有这个字段"的表示是 `"address": []`。`String([])` 得到 `""` 看似无害，
 * 但 `[].trim()` 会抛错 —— 所以解析一律走 `text()`，用 `typeof === 'string'` 判定。
 *
 * ### 3. `distance` 接口是「**多起点 → 单终点**」，与我们对外接口方向相反
 *
 * 对外是"一个起点 → 多个终点"（行程里就是"从这一站到后面每一站"）。
 * 距离是对称的，所以实现里翻转调用；耗时在单向路/高峰时段会有差异，
 * 但这个接口的耗时本身就是估算，翻转带来的差异小于它自身的误差。
 * 返回的 `origin_id` 是 **1-based**，据此映射回入参下标。
 *
 * ## 配额
 *
 * 距离接口单次最多 100 个起点，超出自动分批（见 `MAX_ORIGINS`）。
 * 单次调用只消耗一次配额 —— 这也是选它而不是逐个调路径规划的原因。
 */
export class AmapMapProvider implements MapProvider {
  readonly name = 'amap-map';

  constructor(
    private readonly cfg: AppConfig['map'],
    private readonly logger?: AppLogger,
  ) {}

  async searchPlaces(keyword: string, opts?: PlaceSearchOptions): Promise<PlaceHit[]> {
    const kw = String(keyword ?? '').trim();
    // 空关键词不发请求：既浪费配额，高德也会返回一堆无关的热门地点
    if (!kw) return [];

    const limit = Math.min(Math.max(Math.floor(opts?.limit ?? 10), 1), 25);
    const body = await this.call<{ pois?: unknown[] }>('/v3/place/text', {
      keywords: kw,
      ...(opts?.city ? { city: opts.city } : {}),
      offset: String(limit),
      page: '1',
      // ⚠️ 不带 extensions=all 就拿不到评分与营业时间（biz_ext 整个字段都不返回）
      extensions: 'all',
    });

    return (body.pois ?? []).map(toPlaceHit).filter((p): p is PlaceHit => p !== null);
  }

  async geocode(address: string, city?: string): Promise<GeoPoint | null> {
    const addr = String(address ?? '').trim();
    if (!addr) return null;

    const body = await this.call<{ geocodes?: unknown[] }>('/v3/geocode/geo', {
      address: addr,
      ...(city ? { city } : {}),
    });
    const first = body.geocodes?.[0] as { location?: unknown } | undefined;
    // 解析不出就返回 null —— **不返回一个"大概差不多"的坐标**
    return parseLngLat(first?.location);
  }

  async estimateRoutes(
    origin: GeoPoint,
    destinations: GeoPoint[],
    mode: TravelMode,
  ): Promise<(RouteEstimate | null)[]> {
    if (!destinations.length) return [];
    const type = DISTANCE_TYPE[mode];
    const out: (RouteEstimate | null)[] = new Array<RouteEstimate | null>(destinations.length).fill(
      null,
    );

    for (let start = 0; start < destinations.length; start += MAX_ORIGINS) {
      const chunk = destinations.slice(start, start + MAX_ORIGINS);
      const body = await this.call<{ results?: unknown[] }>('/v3/distance', {
        // 翻转：把我们的一批"终点"当高德的 origins（见文件头第 3 条）
        origins: chunk.map(toLngLat).join('|'),
        destination: toLngLat(origin),
        type,
      });

      for (const raw of body.results ?? []) {
        const { origin_id: originId, distance, duration } = raw as {
          origin_id?: unknown;
          distance?: unknown;
          duration?: unknown;
        };
        const idx = Number(originId) - 1; // 高德是 1-based
        if (!Number.isInteger(idx) || idx < 0 || idx >= chunk.length) continue;

        const distanceMeters = Number(distance);
        const durationSeconds = Number(duration);
        // 算不出的位置**保持 null**，不用 0 或上一个结果填充
        if (!Number.isFinite(distanceMeters) || !Number.isFinite(durationSeconds)) continue;
        out[start + idx] = { distanceMeters, durationSeconds };
      }
    }
    return out;
  }

  /**
   * 发一次 GET 并做**业务层**校验（见文件头第 1 条）。
   *
   * 失败一律抛 `MapServiceUnavailable`：对用户来说"key 无效 / 配额用尽 / 超时"
   * 的处置都是"稍后重试"，真正的线索（高德的 `info` / `infocode`）打进日志。
   */
  private async call<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(path, BASE_URL);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('key', this.cfg.key);

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    } catch (err) {
      this.logger?.warn(`高德请求失败（${path}）：${String(err)}`, 'AmapMapProvider');
      throw new BizException(
        ErrorCode.MapServiceUnavailable,
        { path },
        '地图服务连不上或超时，请稍后重试',
      );
    }

    if (!res.ok) {
      this.logger?.warn(`高德返回 HTTP ${res.status}（${path}）`, 'AmapMapProvider');
      throw new BizException(
        ErrorCode.MapServiceUnavailable,
        { path, status: res.status },
        `地图服务返回 HTTP ${res.status}`,
      );
    }

    const body = (await res.json()) as { status?: string; info?: string; infocode?: string } & T;
    if (body.status !== '1') {
      // ⚠️ 关键：HTTP 200 也可能是一次业务失败（文件头第 1 条）
      this.logger?.warn(
        `高德业务失败（${path}）：info=${body.info ?? '?'} infocode=${body.infocode ?? '?'}`,
        'AmapMapProvider',
      );
      throw new BizException(
        ErrorCode.MapServiceUnavailable,
        { path, info: body.info, infocode: body.infocode },
        `地图服务返回：${body.info ?? '未知错误'}`,
      );
    }
    return body;
  }
}

const BASE_URL = 'https://restapi.amap.com';

/** 距离接口单次最多 100 个起点 */
const MAX_ORIGINS = 100;

/** 出行方式 → 高德 `distance` 接口的 `type` 参数（1 驾车 / 3 步行） */
const DISTANCE_TYPE: Record<TravelMode, string> = { driving: '1', walking: '3' };

/** 坐标 → 高德要求的 `lng,lat`（6 位小数，约 0.1 米精度） */
function toLngLat(p: GeoPoint): string {
  return `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;
}

/**
 * 取字符串字段。
 *
 * ⚠️ 高德把"没有值"表示成**空数组 `[]`**，所以不能用 `String(v).trim()`
 * （`String([])` 是 `""` 看着没事，但 `[].trim()` 会抛）。
 */
function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** `"lng,lat"` → 坐标；非法返回 null */
function parseLngLat(raw: unknown): GeoPoint | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',');
  if (parts.length !== 2) return null;
  const lng = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat };
}

/** 高德 POI → `PlaceHit`；缺 id 或坐标的条目直接丢（渲染与去重都要靠它们） */
function toPlaceHit(raw: unknown): PlaceHit | null {
  if (!raw || typeof raw !== 'object') return null;
  const { id, name, address, location, type, biz_ext: bizExt } = raw as Record<string, unknown>;
  const point = parseLngLat(location);
  const poiId = text(id);
  if (!poiId || !point) return null;

  const ext = (bizExt ?? {}) as { rating?: unknown; open_time?: unknown };
  return {
    id: poiId,
    name: text(name) || '未命名地点',
    address: text(address),
    location: point,
    type: text(type),
    rating: text(ext.rating),
    openTime: text(ext.open_time),
  };
}
