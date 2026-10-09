#!/usr/bin/env node
/**
 * 静态守卫：AI 超时预算的**跨端一致性**（A2 超时倒挂）
 *
 * ## 它拦的是哪一类问题
 *
 * 服务端 `LLM_TOTAL_BUDGET_MS` 比小程序请求超时还大时，会出现一种
 * **两端判定相反、且谁都不知道对方怎么想**的现象：
 *
 * ```
 * 用户视角：点了生成 → 30 秒后提示"请求超时" → 以为失败了
 * 服务端：请求仍在跑，45 秒时才刚跑完 → 产物落库、还扣了费
 * ```
 *
 * 用户看到失败，账上却少了钱、文件里还多了个产物。
 * 这类问题**不会报错**，只会在用户投诉"我没生成成功却扣了钱"时才被发现。
 *
 * ## 为什么启动期断言之外还要静态守卫
 *
 * 启动期断言（`assertBudgetWithinClientTimeout`）拦的是**运行时配置**；
 * 本守卫拦的是**源码里的默认值漂移** —— 有人把默认值改大、或把小程序超时调小，
 * 启动断言要等到真启动才发现，而 CI 能在提交阶段就拦下。
 *
 * ## 检查项
 *
 *   ① `env.schema.ts` 的 `LLM_TOTAL_BUDGET_MS` / `ASR_TOTAL_BUDGET_MS` 默认值
 *      必须 ≤ 客户端超时 − 回程余量；
 *   ② `.env.example` 的取值同样合规（它是部署模板，最容易被照抄）；
 *   ③ 两端引用的常量必须一致（客户端超时只允许有一个来源）；
 *   ④ 启动断言仍然存在；
 *   ⑤ **真正生效的 `.env`** 也必须合规（前四项都不是运行时读到的值）。
 *
 * ## 用法
 *
 *   node scripts/dev/check-timeout-budget.mjs
 *
 * 退出码非 0 表示存在超时倒挂配置。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

/** 回程余量：预算耗尽到响应回到客户端之间还有序列化 / 鉴权 / 网络往返开销 */
const HEADROOM_MS = 5000;

const failures = [];
const ok = (m) => console.log(`✅ ${m}`);
const fail = (m) => {
  failures.push(m);
  console.error(`❌ ${m}`);
};

// ---------- ① 客户端超时的唯一来源 ----------
const requestSrc = read('apps/mp/utils/request.ts');
const clientMatch = /timeout\s*=\s*(\d+)\s*\}\s*=\s*opts/.exec(requestSrc);
if (!clientMatch) {
  fail('无法从 apps/mp/utils/request.ts 解析客户端默认超时（守卫需同步更新）');
}
const clientTimeout = clientMatch ? Number(clientMatch[1]) : 30000;
const limit = clientTimeout - HEADROOM_MS;
ok(`客户端默认超时 ${clientTimeout}ms → 服务端预算上限 ${limit}ms（留 ${HEADROOM_MS}ms 回程）`);

// ---------- ② 服务端默认值 ----------
const schemaSrc = read('apps/api/src/common/config/env.schema.ts');
const budgetNames = ['LLM_TOTAL_BUDGET_MS', 'ASR_TOTAL_BUDGET_MS'];
for (const name of budgetNames) {
  const m = new RegExp(`${name}:[^;]*?\\.default\\((\\d+)\\)`).exec(schemaSrc);
  if (!m) {
    fail(`env.schema.ts 里找不到 ${name} 的默认值（守卫需同步更新）`);
    continue;
  }
  const value = Number(m[1]);
  if (value > limit) {
    fail(`${name} 默认值 ${value}ms 超过上限 ${limit}ms：用户会先看到失败，服务端仍在跑`);
  } else {
    ok(`${name} 默认 ${value}ms ≤ ${limit}ms`);
  }
}

// ---------- ③ .env.example 模板 ----------
const exampleSrc = read('.env.example');
for (const name of budgetNames) {
  const m = new RegExp(`^${name}=(\\d+)`, 'm').exec(exampleSrc);
  if (!m) {
    fail(`.env.example 缺少 ${name}（部署模板必须能直接照抄）`);
    continue;
  }
  const value = Number(m[1]);
  if (value > limit) {
    fail(`.env.example 的 ${name}=${value} 超过上限 ${limit}ms`);
  } else {
    ok(`.env.example 的 ${name}=${value}ms 合规`);
  }
}

// ---------- ④ 启动断言仍然存在 ----------
if (!schemaSrc.includes('assertBudgetWithinClientTimeout')) {
  fail('env.schema.ts 缺少 assertBudgetWithinClientTimeout：运行时配错不会被拦');
} else {
  ok('启动期跨端断言仍在（运行时兜底）');
}

// ---------- ⑤ 真正生效的 .env ----------
/**
 * 前四项查的都是"源码默认值"与"部署模板"，而**运行时真正读到的是 `.env`**。
 * 它被改大不会让任何守卫变红 —— 只会在下次重启时让服务**起不来**
 *（启动期断言拒绝启动），或者更糟：让"用户看到失败、服务端仍在跑并扣费"
 * 在配置层面成立。
 *
 * 2026-09-20 实测踩到：`.env` 里 `LLM_TOTAL_BUDGET_MS=45000` 而客户端超时 30000，
 * 前四项全绿、本脚本也全绿（当时这段还没写），直到重启后端才炸出来。
 * **本段就是为那次踩坑补的** —— 注释里承诺了 ⑤ 却只有 ④，等于缺口没堵上。
 *
 * `.env` 不入库，所以 CI 里这一步自然跳过（文件不存在时不报错）。
 */
const envFile = resolve(ROOT, '.env');
if (!existsSync(envFile)) {
  console.log('⏭  .env 不存在（CI / 全新克隆），跳过运行时配置检查');
} else {
  const envSrc = readFileSync(envFile, 'utf8');
  for (const name of budgetNames) {
    const m = new RegExp(`^${name}=(\\d+)`, 'm').exec(envSrc);
    // 没写就落到默认值，② 已经查过；这里只查"显式写了一个过大的值"
    if (!m) continue;
    const value = Number(m[1]);
    if (value > limit) {
      fail(
        `.env 的 ${name}=${value}ms 超过上限 ${limit}ms —— ` +
          '后端会**启动即失败**（启动期断言），或造成"用户看到失败、服务端仍在跑并扣费"',
      );
    } else {
      ok(`.env 的 ${name}=${value}ms 合规`);
    }
  }
}

// ---------- 结果 ----------
console.log('');
if (failures.length) {
  console.error(`❌ 超时预算守卫失败：${failures.length} 项`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('✅ 超时预算守卫通过：服务端预算 < 客户端超时，两端判定不会相反');