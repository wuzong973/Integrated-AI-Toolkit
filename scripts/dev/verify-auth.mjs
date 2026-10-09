#!/usr/bin/env node
/**
 * 微信登录链路验证（任务清单 M0-16 / 排查报告 P1-6）
 *
 * ## 这个脚本解决什么问题
 *
 * 「真实微信登录是否接通」在**没有真实 code** 的情况下也能验，关键是用对判据：
 *
 * | 配置状态 | 用一个非法 code 请求登录，正确表现是 | 说明 |
 * |---|---|---|
 * | 未配 `WECHAT_SECRET`，或 `WECHAT_DEV_LOGIN=true` | **登录成功**（返回 `dev_` 开头的伪 openid） | 开发模式降级 |
 * | 已配 `WECHAT_SECRET` 且开关为 false | **登录失败**（微信回 `40029 invalid code`） | 真实链路已接通 |
 *
 * 也就是说：**"非法 code 也能登录成功"恰恰证明真实链路没接通。**
 * 这是本项目最容易自欺的一个点 —— 开发模式下登录永远成功，
 * 于是"能登录"被当成"微信登录已接通"，直到上线换真 AppSecret 才发现账号全对不上。
 *
 * ⚠️ 本脚本**刻意不用** `qz-dev:` 夹具 code（`scripts/dev/dev-login.mjs`）：
 * 第 ② 步的意义就是拿一个真 code 形状的值去撞微信，被拒才算数。
 *
 * ## 用法
 *
 *   node scripts/dev/verify-auth.mjs [baseUrl]
 *
 * 退出码非 0 表示发现需要处理的问题（降级未标记 / 真实链路异常）。
 */
import { resolveBaseUrl } from './base-url.mjs';

const BASE = resolveBaseUrl(process.argv[2]);
const results = [];
const check = (ok, label, extra = '') => {
  results.push({ ok, label, extra });
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? `（${extra}）` : ''}`);
};
const info = (msg) => console.log(`   · ${msg}`);

async function call(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应（如网关 HTML） */
  }
  return { status: res.status, headers: res.headers, json, text };
}

/** 读取 /health，拿到服务端自报的降级面 */
async function readHealth() {
  const h = await call('GET', '/health');
  const d = h.json?.data ?? {};
  return {
    status: d.status,
    degradations: d.degradations ?? [],
    mockProviders: d.mockProviders ?? [],
  };
}

/** 用一个**必然非法**的 code 请求登录；返回 { ok, openid, message } */
async function loginWithInvalidCode() {
  const res = await call('POST', '/auth/login', { code: 'verify-auth-invalid-code' });
  const openid = res.json?.data?.user?.openid ?? res.json?.data?.openid;
  return { httpStatus: res.status, code: res.json?.code, openid, message: res.json?.message };
}

function reportHealth(health) {
  console.log('① 服务端自报的降级面');
  info(`/health status = ${health.status}`);
  info(`degradations = ${health.degradations.map((d) => d.name).join(', ') || '(无)'}`);
  info(`mockProviders 共 ${health.mockProviders.length} 个`);
  const wechatDegraded = health.degradations.some((d) => d.name === 'wechat-login');
  check(
    wechatDegraded || health.degradations.length === 0,
    '微信登录降级状态已如实暴露在 /health（红线 10）',
    wechatDegraded ? '当前为开发模式' : '',
  );
  return wechatDegraded;
}

function reportLogin(login, degraded) {
  console.log('\n② 非法 code 登录（判据：开发模式该成功，真实模式该失败）');
  info(`HTTP ${login.httpStatus} code=${login.code} openid=${login.openid ?? '(无)'}`);

  if (degraded) {
    check(
      login.httpStatus < 300 && String(login.openid ?? '').startsWith('dev_'),
      '开发模式下返回伪 openid（dev_ 前缀）—— 符合预期',
    );
    info('⚠️ 这一条"成功"不代表微信登录可用，只代表开发降级路径正常。');
    info('   要让下面第 ③ 步有意义，请在 .env 填入真实 WECHAT_SECRET 后重跑。');
    return;
  }

  // 配了真实 AppSecret：非法 code **必须**被拒绝。
  // 若这里仍然 200，说明 secret 没生效（或请求根本没打到微信）。
  check(
    login.httpStatus >= 400,
    '已配 AppSecret，非法 code 被拒绝 —— 证明真实链路已接通',
    `HTTP ${login.httpStatus}`,
  );
  check(
    typeof login.message === 'string' && !/^Cannot\s/.test(login.message),
    '失败文案是用户可读的，未外泄框架原话',
    login.message ?? '',
  );
}

function reportRealCodeExchange(degraded) {
  console.log('\n③ 真机验收（需人工，脚本无法代做）');
  info('本脚本只能验"链路接通"，无法验"真机登录成功"—— 那需要真实 code。');
  info('');
  info('判据**不是**首页的"演示模式"角标：那个角标按"装配里有没有任一 mock Provider"打，');
  info('本项目还有 mock-pay / mock-sms / mock-moderation 等 6 个，登录接通后它照样亮。');
  info('登录真不真，只看 ① 的 degradations 里还有没有 `wechat-login`。');
  info('');
  info('真机验收步骤：');
  info('  1. apps/mp/config/endpoints.ts 的 LOCAL_API_BASE 改成局域网 IP（可跑 npm run check:api-base）；');
  info('  2. 微信开发者工具 → 预览 → 手机上打开；');
  info('  3. 观察启动日志 [env] 基址是否为局域网 IP；');
  info('  4. ⚠️ 局域网 `http://IP:PORT` 不是微信允许的 request 合法域名，');
  info('     需在开发者工具"详情 → 本地设置"勾上"不校验合法域名"再预览，');
  info('     否则真机上请求会被微信拦掉，表现为"点了登录没反应"；');
  info('  5. 登录后查 db 的 `user` 表：openid 应是微信返回的真值（**不带 `dev_` 前缀**），');
  info('     且重复登录不新增行（openid 唯一约束）—— 这两条才是"真实登录"的证据。');
  if (degraded) {
    info('');
    info('⚠️ 当前仍是开发模式，真机也会"登录成功"但用的是伪 openid —— 上面第 5 步一定不通过。');
  }
}

function summarize() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(74)}`);
  if (failed.length === 0) {
    console.log('🎉 通过：登录链路行为与当前配置相符，且降级状态可见');
  } else {
    console.log(`❌ 发现 ${failed.length} 处问题：`);
    for (const f of failed) console.log(`   · ${f.label}${f.extra ? `（${f.extra}）` : ''}`);
  }
  console.log('='.repeat(74));
  process.exitCode = failed.length === 0 ? 0 : 1;
}

console.log(`验证目标：${BASE}\n`);
const health = await readHealth();
const degraded = reportHealth(health);
const login = await loginWithInvalidCode();
reportLogin(login, degraded);
reportRealCodeExchange(degraded);
summarize();
