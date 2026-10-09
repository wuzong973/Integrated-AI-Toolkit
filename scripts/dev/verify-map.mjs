/**
 * 端到端验证：地图 / 位置服务（高德 Web 服务）
 *
 * ## 为什么需要它
 *
 * "Provider 写了、env 配了、单测过了"**不等于**它能用 —— 项目为此踩过两次
 * （M4-05 内容审核、`search_knowledge`）：实现与配置都齐，但**零调用方**，
 * 而单测直接 `new` 一个 Provider，永远暴露不出"没人调它"。
 * 本脚本走真实 HTTP，钉住四件事：
 *
 *   ① **真的接上了** —— 响应的 `provider` 必须是 `amap-map`，不是 `mock-map`；
 *   ② **走的是真实路网** —— 真实路线一定比直线长，且**驾车与步行的距离通常不同**
 *      （mock 实现里两者距离**完全一样**，只差速度；见 `MockMapProvider`）；
 *   ③ **单位对** —— 米 / 秒。用"步行速度落在人走路的区间"反查单位，
 *      比逐字读代码可靠：单位写成公里或分钟，这条会立刻崩；
 *   ④ **边界不误伤** —— 一对多、非法参数、未登录都给出正确响应。
 *
 * ## 本脚本自己抓出过两个真问题（都值得记住）
 *
 *   · **漏挂 `@UseGuards(JwtAuthGuard)`** —— 未登录也返回 200。本项目唯一的全局
 *     guard 是限流，登录校验靠各 controller 自己挂，**漏挂不会有任何报错**；
 *   · **响应多了一层包装** —— 所有接口都套 `{ code, message, data }`，
 *     第一版直接读 `body.places` 导致断言全红，看起来像"接口坏了"。
 *
 * ## 前置
 *
 *   后端已在 `http://127.0.0.1:3000` 运行；
 *   `.env` 里 `MAP_DRIVER=amap` 且 `AMAP_WEB_KEY` 非空（否则本脚本直接判失败 ——
 *   拿演示数据过验收比不验收更糟）。
 *
 * ## 用法
 *
 *   npm run verify:map
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveBaseUrl, ROOT } from './base-url.mjs';

const require = createRequire(resolve(ROOT, 'apps/api/package.json'));
const jwt = require('jsonwebtoken');

const BASE = resolveBaseUrl(process.argv[2]);
let failures = 0;

const check = (ok, label, extra = '') => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? '  → ' + extra : ''}`);
};

/** 环境变量：以根 .env 为准，缺的从 apps/api/.env 补 */
function loadEnv() {
  const out = {};
  for (const file of [resolve(ROOT, '.env'), resolve(ROOT, 'apps/api/.env')]) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !out[m[1]]) out[m[1]] = m[2].trim();
    }
  }
  return out;
}

function signToken(env) {
  return jwt.sign(
    { sub: 'verify-map', openid: 'verify-map', roles: [], isAdmin: false },
    env.JWT_SECRET,
    { expiresIn: '10m' },
  );
}

function makeApi(token) {
  return async (path, init = {}) => {
    const headers = { 'content-type': 'application/json', ...(init.headers ?? {}) };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(BASE + path, { ...init, headers });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };
}

/**
 * 项目所有接口都套了一层统一响应包装 `{ code, message, data }`。
 *
 * ⚠️ 验证脚本**必须**走这一层 —— 本脚本第一版直接读了 `body.places`，
 * 于是所有断言全红，看起来像"接口坏了"，实际只是少剥了一层壳。
 */
const data = (res) => res?.body?.data ?? {};

/** 两点球面直线距离（米）—— 用来对比"真实路线 vs 直线" */
function haversine(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const coord = (p) => `${p.lng},${p.lat}`;

/** 搜一个地点并返回第一条 */
async function firstPlace(api, keyword) {
  const res = await api(
    `/map/places?keyword=${encodeURIComponent(keyword)}&city=${encodeURIComponent('成都')}&limit=1`,
  );
  return { res, place: data(res).places?.[0] };
}

/* ---------- 各段检查 ---------- */

async function checkAuth() {
  const anon = await makeApi(null)('/map/places?keyword=%E6%AD%A6%E4%BE%AF%E7%A5%A0');
  check(anon.status === 401, '未登录被拒（401）', `实际 ${anon.status}`);
}

async function checkPlaces(api) {
  const { res: p1, place: a } = await firstPlace(api, '武侯祠');
  check(p1.status === 200, '地点搜索返回 200', `实际 ${p1.status}`);
  check(data(p1).provider === 'amap-map', 'provider 是 amap-map（不是 mock）', String(data(p1).provider));
  check(!!a, '搜到「武侯祠」', a ? a.name : '无结果');
  check(!!a?.location?.lng && !!a?.location?.lat, '结果带坐标');
  check(!!a?.address, '结果带地址', a?.address ?? '');
  check(!!a?.rating, '结果带评分（extensions=all 生效）', a?.rating ?? '空');

  const { place: b } = await firstPlace(api, '杜甫草堂');
  check(!!b, '搜到「杜甫草堂」', b ? b.name : '无结果');
  return { a, b };
}

async function checkRoute(api, a, b) {
  const straight = haversine(a.location, b.location);
  const walk = await api(
    `/map/route?origin=${coord(a.location)}&destinations=${coord(b.location)}&mode=walking`,
  );
  const drive = await api(
    `/map/route?origin=${coord(a.location)}&destinations=${coord(b.location)}&mode=driving`,
  );
  const w = data(walk).estimates?.[0];
  const d = data(drive).estimates?.[0];

  check(walk.status === 200 && !!w, '步行路线返回 200 且有结果');
  check(drive.status === 200 && !!d, '驾车路线返回 200 且有结果');
  check(!!w?.distanceMeters && !!w?.durationSeconds, '步行给出距离与耗时');
  if (!w || !d) return;

  check(
    w.distanceMeters > straight,
    '⭐ 步行距离 > 直线距离（走的是真实路网，不是直线估算）',
    `步行 ${w.distanceMeters}m vs 直线 ${Math.round(straight)}m`,
  );
  check(
    d.durationSeconds < w.durationSeconds,
    '⭐ 驾车耗时 < 步行耗时（单位与换算正确）',
    `驾车 ${d.durationSeconds}s vs 步行 ${w.durationSeconds}s`,
  );

  const speed = w.distanceMeters / w.durationSeconds;
  check(speed > 0.5 && speed < 3, '步行速度落在人走路的区间（反查单位：米/秒）', `${speed.toFixed(2)} m/s`);

  /**
   * 辅证：mock 实现里驾车与步行的距离**完全相同**（同一个直线 × 1.4），
   * 真实路网下两者通常不同。这条不单独作为判据（真有可能碰巧相等），
   * 主判据是 `provider === 'amap-map'`。
   */
  check(
    w.distanceMeters !== d.distanceMeters,
    '驾车与步行的距离不同（排除"同一套直线估算"的演示实现）',
    `步行 ${w.distanceMeters}m / 驾车 ${d.distanceMeters}m`,
  );
}

async function checkEdgeCases(api, a, b) {
  const multi = await api(
    `/map/route?origin=${coord(a.location)}&destinations=${coord(b.location)}|${coord(a.location)}&mode=walking`,
  );
  const est = data(multi).estimates;
  check(multi.status === 200, '一对多返回 200');
  check(Array.isArray(est) && est.length === 2, '返回条数与终点数一一对应', `实际 ${est?.length}`);

  /**
   * 用「起点到自身」验证**对应关系没串位**。
   *
   * ⚠️ 不能断言它等于 0 —— 高德对同一个点返回的是 **1 米**（服务商有最小距离），
   * 第一版断言写 0 因此红了一条。改成"自身那条远小于到景点那条"，
   * 既表达了"顺序没错"，也不依赖服务商的最小值约定。
   */
  check(
    (est?.[1]?.distanceMeters ?? -1) < 100 && (est?.[0]?.distanceMeters ?? 0) > 1000,
    '两条结果的对应关系正确（自身那条远小于到景点那条）',
    `自身 ${est?.[1]?.distanceMeters}m / 到景点 ${est?.[0]?.distanceMeters}m`,
  );

  const bad = await api('/map/route?origin=abc&destinations=1,2&mode=walking');
  check(bad.status === 400, '非法坐标被拒（400）', `实际 ${bad.status}`);
  const badMode = await api(
    `/map/route?origin=${coord(a.location)}&destinations=${coord(b.location)}&mode=flying`,
  );
  check(badMode.status === 400, '非法出行方式被拒（400）', `实际 ${badMode.status}`);
}

async function main() {
  console.log(`\n地图服务端到端验证  ${BASE}\n`);

  const env = loadEnv();
  if (env.MAP_DRIVER !== 'amap' || !env.AMAP_WEB_KEY) {
    console.log('❌ 前置不满足：`.env` 需要 MAP_DRIVER=amap 且 AMAP_WEB_KEY 非空');
    console.log('   （用演示数据跑验收比不验收更糟，故直接判失败）\n');
    process.exit(1);
  }

  const api = makeApi(signToken(env));
  await checkAuth();

  const { a, b } = await checkPlaces(api);
  if (!a?.location || !b?.location) {
    console.log('\n⚠️ 拿不到两个地点坐标，后续路线断言无法进行\n');
    process.exit(1);
  }

  await checkRoute(api, a, b);
  await checkEdgeCases(api, a, b);

  console.log('');
  if (failures === 0) {
    console.log('✅ 地图服务端到端验证通过\n');
  } else {
    console.log(`❌ ${failures} 项未通过\n`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n脚本异常：', err);
  process.exit(1);
});
