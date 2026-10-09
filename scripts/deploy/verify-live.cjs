/**
 * 线上验收：用真实 Chromium 打开 https://qingzhi.wzl136122.cn，证明**页面真的能跑起来**。
 *
 * 为什么不能只看 curl 200：
 *   接口返回 200 只说明"文件送到了"，不说明"前端 JS 执行成功"。
 *   SPA 的典型故障是 index.html 200、assets 200，但运行时报错 → 白屏。
 *   这类问题 curl 一个都发现不了。
 *
 * ⚠️ 本机（开发机）的 ISP DNS 仍缓存着 NXDOMAIN，所以用
 *   `--host-resolver-rules` 把域名强制指向服务器 IP。
 *   **刻意不设 ignoreHTTPSErrors** —— 证书有问题必须当场暴露。
 *
 * 跑法：
 *   NODE_PATH=<managed node workspace>/node_modules node scripts/deploy/verify-live.cjs
 */
const path = require('node:path');

const SITE = 'https://qingzhi.wzl136122.cn';
const IP = '101.35.46.146';

const { chromium } = require('playwright-core');

function findChrome() {
  const base = path.join(process.env.USERPROFILE || process.env.HOME, 'AppData', 'Local', 'ms-playwright');
  const fs = require('node:fs');
  for (const d of fs.readdirSync(base).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    const p = path.join(base, d, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('未找到 chromium');
}

(async () => {
  const browser = await chromium.launch({
    executablePath: findChrome(),
    args: [`--host-resolver-rules=MAP qingzhi.wzl136122.cn ${IP}`, '--no-sandbox'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const failed = [];
  const external = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('requestfailed', (r) => failed.push(`${r.url()} :: ${r.failure()?.errorText}`));
  page.on('request', (r) => { if (!r.url().startsWith(SITE) && !r.url().startsWith('data:')) external.push(r.url()); });

  console.log('打开', SITE, '…');
  const resp = await page.goto(SITE, { waitUntil: 'networkidle', timeout: 45000 });
  console.log('主文档状态码 =', resp.status(), '（HTTPS 校验通过，否则 goto 会抛错）');
  console.log('页面标题 =', JSON.stringify(await page.title()));

  // 等 React 挂载：看 #root 有没有真的长出内容
  await page.waitForTimeout(2500);
  const rootHtml = await page.evaluate(() => document.querySelector('#root')?.innerHTML || '');
  const bodyText = (await page.evaluate(() => document.body.innerText || '')).trim();

  console.log('\n--- 渲染结果 ---');
  console.log('#root 子节点数 =', await page.evaluate(() => document.querySelector('#root')?.children.length ?? -1));
  console.log('#root HTML 长度 =', rootHtml.length);
  console.log('可见文本（前 400 字）:\n' + bodyText.slice(0, 400));

  console.log('\n--- 错误与请求 ---');
  console.log('pageerror   :', pageErrors.length ? pageErrors : '无 ✓');
  console.log('console err :', consoleErrors.length ? consoleErrors.slice(0, 5) : '无 ✓');
  console.log('请求失败    :', failed.length ? failed : '无 ✓');
  console.log('外部域请求  :', external.length ? external.slice(0, 5) : '无 ✓（零外部依赖）');

  // 表单是否可用（登录页应该有输入框）
  const inputs = await page.locator('input').count();
  const buttons = await page.locator('button').count();
  console.log(`可交互元素：input=${inputs} button=${buttons}`);

  await page.screenshot({ path: path.join(__dirname, 'live-admin-login.png'), fullPage: true });
  console.log('\n登录页截图 → scripts/deploy/live-admin-login.png');

  // ---------- 真正走一遍登录（"接口 200" ≠ "用户能完成这个动作"） ----------
  const ADMIN_USER = process.env.QZ_ADMIN_USER || 'admin';
  const ADMIN_PASS = process.env.QZ_ADMIN_PASS;
  let loggedIn = false;
  if (ADMIN_PASS) {
    console.log('\n--- 用真实账号走登录流程 ---');
    await page.fill('input[type="text"], input:not([type="password"])', ADMIN_USER);
    await page.fill('input[type="password"]', ADMIN_PASS);
    await page.click('button');
    await page.waitForTimeout(4000);
    const after = (await page.evaluate(() => document.body.innerText || '')).trim();
    loggedIn = !/密码|登录/.test(after.slice(0, 40)) && after.length > 100;
    console.log('登录后 URL =', page.url());
    console.log('登录后可见文本（前 700 字）:\n' + after.slice(0, 700));
    await page.screenshot({ path: path.join(__dirname, 'live-admin-dashboard.png'), fullPage: true });
    console.log('\n后台截图 → scripts/deploy/live-admin-dashboard.png');
    console.log('登录结论：', loggedIn ? '✅ 已进入后台' : '⚠ 未确认进入后台（看上方文本）');
  } else {
    console.log('\n（未提供 QZ_ADMIN_PASS，跳过登录流程）');
  }

  const ok =
    rootHtml.length > 200 && pageErrors.length === 0 && failed.length === 0 && (!ADMIN_PASS || loggedIn);
  console.log('\n结论：', ok ? '✅ 页面真实渲染成功' : '❌ 渲染有问题，见上方输出');
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
