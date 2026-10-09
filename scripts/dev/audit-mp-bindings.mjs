/**
 * 小程序静态体检：把"点了没反应""看不到真东西"变成可查的失败
 *
 * ## 为什么需要它
 *
 * 以下六类问题的共同点是**编译期都不报错**，只能靠静态检查发现：
 *   ① WXML 里 `bindtap="onFoo"` 绑了，但同名页面 TS 里没写 `onFoo`；
 *   ② 用 `wx.navigateTo` 跳 **tabBar 页面** —— 会静默失败（必须 `wx.switchTab`）；
 *   ③ **孤岛页** —— 页面在 app.json 注册了，却没有任何入口，用户永远点不进去；
 *   ④ **假数据没标注** —— 页面声明了 `DEMO_*` 常量却不挂"演示模式"标记（红线 10）；
 *   ⑤ **骨架页误导文案** —— 页面没接任何接口，空态却写"还没…"，
 *      让用户以为是"我还没做"而不是"功能没上线"；
 *   ⑥ **后端地址散落** —— 地址字面量出现在 `utils/env.ts` 里（P0-3），
 *      会导致"切环境要改业务代码"，漏改就把开发地址发上线。
 *   ⑧ **主题类未定义** —— 根节点挂的 `.th-*` 在 `themes.scss` 里没有（或反向：定义了没人用），
 *      整页 CSS 变量静默失效（卡片透明、文字变黑），编译与其他守卫都不报。
 *      （2026-09-20 补，见 ⑧ 段注释）
 *   ⑨ **隐形装饰** —— `qz-rise` / `qz-water` 只带动效不带形状，单独用就是 0×0 隐形元素。
 *      （2026-09-20 补，见 ⑨ 段注释）
 *   ⑪ **组件类名不存在** —— WXML 写了 `qz-card-title`，而 styles 里只有 `.card-title`，
 *      样式整体不生效却毫无报错（⑧⑨ 的同类：写了类名 ≠ 类名存在）。
 *      （2026-09-20 补，见 ⑪ 段注释）
 *   ⑫ **图标没有尺寸来源** —— `.qz-i` 基类不带宽高，裸用就是 0×0 隐形元素。
 *      （2026-09-20 补，见 ⑫ 段注释）
 *   ⑯ **装饰层没接指针视差** —— 只有 `.qz-deco` 没有 `.qz-fx`，光斑和流线纹丝不动，
 *      与同模块其它页观感割裂；模块内一半页接了、一半没接时**没有任何一步报错**。
 *      （2026-10-08 补，见 ⑯ 段注释）
 *   ⑰ **整页没有入场动效** —— 只剩 `.qz-page` 那一级淡入，内容整块同时闪现而不是分区上浮。
 *      （2026-10-08 补，见 ⑰ 段注释）
 *   ⑱ **页面 SCSS 裸色值** —— `#ffffff` / `rgba(255,…)` 现在看着没事，
 *      代价是换肤与深色模式时这些点**不会跟着变**，而那时没人记得它们在哪。
 *      （2026-10-08 补，见 ⑱ 段注释）
 *   ⑲ **图标 data-URI 写坏** —— 内联 SVG 里一处裸 `#`、跨行、或引号不成对，WXSS 会把整条声明丢掉，
 *      屏幕上那一格是空白，而编译与 lint 都不报错。手画新图标（§三）时最容易踩。
 *      （2026-10-08 补，见 ⑲ 段注释）
 *   ⑳ **视差层里的装饰被裁掉** —— `qz-flow` / `qz-water` / `qz-wave` / `qz-curve` 库内不带 `position`，
 *      `qz-topline` 是 `top: 0`；放进外扩 40rpx 的 `.qz-fx` 后整条落到 `.qz-deco` 的
 *      `overflow: hidden` 之外 —— 动画在跑、不报错、屏幕上什么都没有。
 *      （2026-10-08 补，见 ⑳ 段注释）
 *   ㉑ **页面自写 @keyframes** —— §四"动效只在库里"这条纪律长期只写在文档里没人查，
 *      一旦页面私加曲线，同一个"入场"就会长出好几种时长与缓动，全站节奏散掉。
 *      （2026-10-08 补，见 ㉑ 段注释）
 *
 * ③④⑤⑥ 是 2026-09-18 交付可用性排查时补的 —— 当时实测发现：
 * `pkg-station/{service,provider,apply,order-detail}` 入站引用均为 0 处；
 * `pkg-os/plan` 静默用演示数据冒充真实编排结果；7 个骨架页空态文案误导；
 * `utils/env.ts` 把三个环境地址与 `const ENV` 混在一起且用 `example.com` 占位。
 *
 * ## 用法
 *
 *   node scripts/dev/audit-mp-bindings.mjs [--json]
 *
 * 退出码非 0 表示发现问题，可直接接进 CI。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');
const MP = join(ROOT, 'apps/mp');

const problems = [];
const report = (file, msg) => problems.push({ file: relative(ROOT, file), msg });

/** 递归收集匹配的文件 */
function walk(dir, filter, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      walk(p, filter, out);
    } else if (filter(name)) {
      out.push(p);
    }
  }
  return out;
}

// ---------- 读取 app.json：tabBar 页 + 全部已注册页 ----------
const appJson = JSON.parse(readFileSync(join(MP, 'app.json'), 'utf8'));
const tabBarPages = new Set((appJson.tabBar?.list ?? []).map((i) => i.pagePath));
const allPages = new Set(appJson.pages ?? []);
// ⚠️ 微信两种拼写都接受（官方文档写 subPackages，但大量项目用 subpackages），
//    只读其中一个会把分包页全判成"未注册" —— 这是本脚本第一版的真实 bug。
for (const sub of [...(appJson.subPackages ?? []), ...(appJson.subpackages ?? [])]) {
  for (const p of sub.pages ?? []) allPages.add(`${sub.root}/${p}`);
}

// ---------- ① 绑定的事件处理函数是否存在 ----------
const HANDLER_RE = /\b(?:bind|catch|capture-bind|capture-catch)[:a-z]*\s*=\s*"([A-Za-z_$][\w$]*)"/g;

for (const wxml of walk(MP, (n) => n.endsWith('.wxml'))) {
  const tsPath = wxml.replace(/\.wxml$/, '.ts');
  let tsSrc = '';
  try {
    tsSrc = readFileSync(tsPath, 'utf8');
  } catch {
    // 没有同名 ts（可能是纯 WXML 组件）：跳过，避免误报
    continue;
  }
  const wxmlSrc = readFileSync(wxml, 'utf8');

  for (const m of wxmlSrc.matchAll(HANDLER_RE)) {
    const handler = m[1];
    // 页面里方法可能写成 `onFoo(` 或 `onFoo:`（对象属性）
    const defined = new RegExp(`\\b${handler}\\s*[(:]`).test(tsSrc);
    if (!defined) report(wxml, `绑定了 ${handler}，但 ${tsPath.split(/[\\/]/).pop()} 里没有这个方法`);
  }
}

// ---------- ② navigateTo 跳 tabBar 页（静默失败） ----------
const NAV_RE = /wx\.(navigateTo|redirectTo)\s*\(\s*\{[^}]*url\s*:\s*['"`]([^'"`]+)['"`]/g;

for (const ts of walk(MP, (n) => n.endsWith('.ts'))) {
  const src = readFileSync(ts, 'utf8');
  for (const m of src.matchAll(NAV_RE)) {
    const [, api, rawUrl] = m;
    const target = rawUrl.replace(/^\//, '').split('?')[0];
    if (tabBarPages.has(target)) {
      report(ts, `用 wx.${api} 跳 tabBar 页「${target}」—— 会静默失败，应改用 wx.switchTab`);
    }
  }
}

// ---------- ③ 跳转目标是否已注册 ----------
for (const ts of walk(MP, (n) => n.endsWith('.ts'))) {
  const src = readFileSync(ts, 'utf8');
  for (const m of src.matchAll(/wx\.navigateTo\s*\(\s*\{[^}]*url\s*:\s*['"`]([^'"`]+)['"`]/g)) {
    const target = m[1].replace(/^\//, '').split('?')[0];
    if (!allPages.has(target) && !target.startsWith('pages/common/webview')) {
      report(ts, `navigateTo 目标「${target}」未在 app.json 注册（会跳不过去）`);
    }
  }
}

// ---------- ④ 孤岛页：已注册但没有任何入口 ----------
/**
 * 已知"暂时无入口"的页面。
 *
 * ⚠️ 每条必须写清**原因**与**任务编号**，不许为了变绿随手加条目 ——
 *    与 `audit-api-routes.mjs` 的 `KNOWN_MISSING` 同一纪律。
 *    后端/页面就绪后请删掉条目，让守卫重新把它盯起来。
 */
const UNREACHABLE_ALLOWLIST = new Map([
  // 2026-09-19：`pkg-station/service/index` 与 `provider/index` 的豁免已移除 ——
  // 服务市场 Tab 已接 GET /services 真列表（pages/station/index.ts:296 跳详情，
  // 详情页再跳服务者主页）。若这里又需要加回，说明市场入口被误删了。
  // 2026-09-19：`pkg-station/apply` 的豁免已移除 —— 认证中心（`pkg-mine/verify`）
  // 的"开始入驻认证"按钮已指向它（M3-02 落地）。若这里之后又需要加回它，
  // 说明认证中心的入口被误删了。
  // 2026-09-19：`pkg-station/order-detail` 的豁免已移除 —— 订单列表页已接入
  // `GET /orders` 并渲染列表项（可跳详情），该页不再是孤岛。
  // 若这里之后又需要加回它，说明列表页的跳转被误删了。
]);

// 预读全部小程序源码（避免对每个页面重复读盘）
const sourceFiles = walk(MP, (n) => /\.(ts|wxml|json)$/.test(n));
const sourceCache = new Map();
const readSource = (f) => {
  if (!sourceCache.has(f)) sourceCache.set(f, readFileSync(f, 'utf8'));
  return sourceCache.get(f);
};

for (const page of allPages) {
  if (tabBarPages.has(page)) continue;
  if (UNREACHABLE_ALLOWLIST.has(page)) continue;

  // 排除页面自身目录与 app.json —— 只统计"外部"引用
  const referenced = sourceFiles.some((f) => {
    const rel = relative(MP, f).replace(/\\/g, '/');
    if (rel.startsWith(`${page}/`)) return false;
    if (rel === 'app.json') return false;
    return readSource(f).includes(page);
  });

  if (!referenced) {
    report(
      join(MP, page),
      '孤岛页：app.json 已注册，但全项目找不到任何入口（用户永远点不进去）。' +
        '请补跳转，或写进 UNREACHABLE_ALLOWLIST 并说明原因与任务编号',
    );
  }
}

/**
 * 反向检查：豁免清单里"已经有入口"的条目应删掉。
 *
 * 与 `audit-api-routes.mjs` 的 `stale` 检查同一目的 ——
 * **防止清单腐化**：后端/页面补齐后若不删条目，守卫就会永远忽略它，
 * 而下一个真正的孤岛页会被误以为"已经登记过了"。
 */
const staleUnreachable = [...UNREACHABLE_ALLOWLIST.keys()].filter((page) => {
  if (!allPages.has(page)) return true; // 页面已被删除
  return sourceFiles.some((f) => {
    const rel = relative(MP, f).replace(/\\/g, '/');
    if (rel.startsWith(`${page}/`)) return false;
    if (rel === 'app.json') return false;
    return readSource(f).includes(page);
  });
});
if (staleUnreachable.length && !process.argv.includes('--json')) {
  console.log('ℹ️ 以下"无入口"豁免条目已经有入口（或页面已删除），请从 UNREACHABLE_ALLOWLIST 移除：');
  for (const p of staleUnreachable) console.log(`  · ${p}`);
  console.log('');
}

// ---------- ⑤ 演示数据必须显式标注（红线 10）----------
/**
 * 声明了 `DEMO_*` / `MOCK_*` 常量的文件，必须同时引用演示标记。
 *
 * 起因：`pkg-os/plan` 在 catch 里静默换成 `DEMO_PLAN_STAGES`，
 * 而 `/os/runs/:id` 实测 404 —— **只要点进该页看到的一定是假数据**，
 * 界面上却没有任何标记，用户会把「已发布 · 3人报名」当成真实结果。
 *
 * 项目已建好 `demoMode` 机制（utils/request.ts + app.ts），
 * 认可用法：`demoMode` / `isDemoMode` / `data` 里的 `demo:` 字段。
 */
const DEMO_CONST_RE = /\bconst\s+((?:DEMO|MOCK)_[A-Z0-9_]+)\b/g;
const DEMO_MARKER_RE = /demoMode|isDemoMode|\bdemo\s*:/;

for (const ts of walk(MP, (n) => n.endsWith('.ts'))) {
  const src = readSource(ts);
  const names = [...new Set([...src.matchAll(DEMO_CONST_RE)].map((m) => m[1]))];
  if (!names.length) continue;
  if (!DEMO_MARKER_RE.test(src)) {
    report(
      ts,
      `声明了演示常量 ${names.join(', ')}，但没有引用演示标记（demoMode / demo:）` +
        ' —— 红线 10 要求假数据必须显式可辨，不得冒充真实功能',
    );
  }
}

// ---------- ⑥ 骨架页不得使用"你还没做"式空态文案 ----------
/**
 * 判据：页面**没有任何接口调用**（纯骨架）时，空态文案不能说"还没…"。
 *
 * 起因（2026-09-18 实测）：`pkg-station/apply` 是纯骨架，
 * 空态却写「还没开始认证 / 完成学生认证…就能在驿站接单啦」——
 * 页面里根本没有认证入口，用户会以为是"我没做"而不是"功能没上线"。
 *
 * 正确写法参照 `pkg-mine/settings`：「设置项准备中 / 将在这里逐项开放」。
 */
const MISLEADING_EMPTY_RE = /还没|还没有|还没开始|还没提交/;
const HAS_API_CALL_RE = /\b\w+Api\.\w+\(/;
/**
 * ⚠️ **"没调接口"不等于"骨架页"** —— 2026-09-20 补的第二把尺子。
 *
 * 起因：校园小工具（绩点 / AA 分账 / 考试倒计时）是**纯本地工具**，
 * 不调任何接口，数据来自本地存储或本地计算。它们"一场考试都没加"的空态
 * 如果写成"还没有考试"，会被这条守卫误判成"骨架页误导文案"。
 *
 * 判据要问的是"**这个页面有没有数据来源**"，而不是"有没有调接口"：
 * 本地存储同样是真实数据源（用户自己存进去的，不是编的）。
 * 真正要拦的是"既不调接口、也没有本地数据，却把空态写成'你还没做'"。
 */
const HAS_LOCAL_SOURCE_RE = /wx\.(?:get|set|remove)Storage(?:Sync)?\s*\(/;

for (const wxml of walk(MP, (n) => n.endsWith('.wxml'))) {
  const tsPath = wxml.replace(/\.wxml$/, '.ts');
  let tsSrc;
  try {
    tsSrc = readSource(tsPath);
  } catch {
    continue; // 没有同名 ts：纯 WXML 片段，跳过
  }
  if (HAS_API_CALL_RE.test(tsSrc)) continue; // 有接口数据源
  if (HAS_LOCAL_SOURCE_RE.test(tsSrc)) continue; // 有本地存储数据源
  if (!MISLEADING_EMPTY_RE.test(readSource(wxml))) continue;

  report(
    wxml,
    '骨架页（未接任何接口）的空态文案写成了"还没…"，会让用户以为是"我还没做"而不是"功能没上线"。' +
      '请改成"XX 功能开发中 / 将在这里开放"（参照 pkg-mine/settings）',
  );
}

// ---------- ⑦ 后端地址数据只能有一处（排查报告 P0-3）----------
/**
 * 判据：`apps/mp/utils/env.ts` 里**不得出现任何 http(s) 字面量**。
 *
 * 起因（2026-09-18 排查）：三个环境地址与 `const ENV = 'develop'` 原本混在 `env.ts`，
 * 结果"切环境要改业务代码"、"真机要改源码里的地址"，两件事都极易漏改，
 * 而漏改的后果是把 `127.0.0.1` / `example.com` 随正式版发上线 —— 必然连不上。
 *
 * 现在约定：**地址数据只在 `apps/mp/config/endpoints.ts`，`env.ts` 只做选择与校验。**
 * 这条守卫就是防止地址悄悄写回 `env.ts`。
 */
const ENV_TS = 'apps/mp/utils/env.ts';
try {
  const envSrc = readSource(join(ROOT, ENV_TS));
  const urlLiterals = envSrc.match(/https?:\/\/[^\s'"`)]+/g) ?? [];
  if (urlLiterals.length) {
    report(
      ENV_TS,
      `出现 ${urlLiterals.length} 处后端地址字面量（${urlLiterals.slice(0, 3).join(', ')}…）。` +
        '地址数据必须集中在 apps/mp/config/endpoints.ts，本文件只做选择与校验（见 P0-3）',
    );
  }
} catch {
  // env.ts 不存在时跳过（不该发生，但不因此让体检崩掉）
}

// ---------- ⑧ 主题类必须在 themes.scss 里有定义（双向）----------
/**
 * 判据 A：WXML 里挂的每个 `.th-*`，必须在 `apps/mp/styles/themes.scss` 有定义。
 *
 * 起因（2026-09-20 实测）：绩点页根节点写的是 `class="qz-page th-tool gpa"`，
 * 而 `themes.scss` 里只有 `.th-tool-run` / `.th-tool-result` —— **`.th-tool` 根本不存在**。
 * 后果不是报错，而是该页所有 `var(--m1..--m4/--ms/--mt/--sh/--r-card)` **全部未定义**：
 * 卡片背景 `var(--sh)` 失效变透明、文字 `var(--mt)` 回落成默认黑、圆角归零。
 * 整页配色静默失效，编译、tsc、其他守卫**全都不会报**。
 * 这类"少写一个后缀"的错，人眼在 WXML 上几乎看不出来（`th-tool` 看着很合理）。
 *
 * 判据 B（反向）：`themes.scss` 里定义的每个 `.th-*`，至少要有一个页面在用。
 * 否则就是死主题类 —— 与"缺口清单只增不改"同源：定义会越堆越多，
 * 而下一个开发者会照着其中一个"看起来能用"的类去挂。
 */
const THEMES_SCSS = join(MP, 'styles/themes.scss');
const DEFINED_THEME_RE = /^\.(th-[a-z0-9-]+)\s*\{/gm;
const definedThemes = new Set(
  [...readFileSync(THEMES_SCSS, 'utf8').matchAll(DEFINED_THEME_RE)].map((m) => m[1]),
);

const usedThemes = new Map(); // 主题类 → 首个使用它的文件
const CLASS_ATTR_RE = /class\s*=\s*"([^"]*)"/g;
const THEME_TOKEN_RE = /^th-[a-z0-9-]+$/;

for (const wxml of walk(MP, (n) => n.endsWith('.wxml'))) {
  const src = readSource(wxml);
  for (const m of src.matchAll(CLASS_ATTR_RE)) {
    // 跳过动态类名（`class="{{...}}"` 里可能拼出任意主题，静态查不了）
    if (m[1].includes('{{')) continue;
    for (const token of m[1].split(/\s+/)) {
      if (THEME_TOKEN_RE.test(token) && !usedThemes.has(token)) usedThemes.set(token, wxml);
    }
  }
}

for (const [theme, file] of usedThemes) {
  if (!definedThemes.has(theme)) {
    report(
      file,
      `挂了主题类「${theme}」，但 apps/mp/styles/themes.scss 里没有定义它 —— ` +
        '该页 var(--m1/--ms/--mt/--sh/--r-card) 会全部失效（配色静默变透明/黑）。' +
        '要么改用已有主题，要么先在 themes.scss 里补上并登记到 docs/dev/MP-VISUAL-SYSTEM.md 的主题表',
    );
  }
}

for (const theme of definedThemes) {
  if (!usedThemes.has(theme)) {
    report(
      THEMES_SCSS,
      `定义了主题类「${theme}」但没有任何页面在用（死主题类）。` +
        '请删掉它，或把某个页面切过去 —— 留着会让下一个人以为它是"可用的现成选项"',
    );
  }
}

// ---------- ⑨ 只带动效的装饰类必须与形状类同用 ----------
/**
 * 判据：`qz-rise` / `qz-water` **只声明 animation，不带任何尺寸与位置**
 * （见 `styles/deco.scss`；`.qz-water` 的注释里甚至明写了"需要自己给位置与尺寸"）。
 *
 * 所以 `<view class="qz-rise"></view>` 是一个 **0×0 的隐形元素**：
 * 动画在跑、DOM 里有、编译与 tsc 全过，**但屏幕上什么都没有**。
 * 2026-09-20 实测踩到：AA 分账页写了 `class="qz-rise"`，课程表页写了 `class="qz-water"`，
 * 两个装饰都是隐形的 —— 属于"看起来做了、实际没做"。
 *
 * 判据取"类名必须 ≥ 2 个"：所有正确用法都是 `形状类 + qz-rise/qz-water` 的组合
 * （`rise-dot qz-rise`、`tb-water qz-water`…）。这条规则简单、无歧义，
 * 且不会误伤 —— 想用这两个类就必须同时给出形状。
 */
const SHAPE_LESS_DECO = new Set(['qz-rise', 'qz-water']);

for (const wxml of walk(MP, (n) => n.endsWith('.wxml'))) {
  const src = readSource(wxml);
  for (const m of src.matchAll(CLASS_ATTR_RE)) {
    if (m[1].includes('{{')) continue;
    const tokens = m[1].split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      if (!SHAPE_LESS_DECO.has(token) || tokens.length >= 2) continue;
      report(
        wxml,
        `装饰元素只挂了「${token}」—— 这个类**只带动效、不带尺寸与位置**（见 styles/deco.scss），` +
          '单独用等于放了一个 0×0 的隐形元素。请补一个页面内的形状类（如 `rise-dot qz-rise`）',
      );
    }
  }
}

// ---------- ⑩ 语义令牌不能用错属性（--sh / --ms） ----------
/**
 * ⚠️ 扫描前会先剥掉块注释 —— 否则注释里提到这些变量名也会被误判
 *（本段说明自己就写在页面 SCSS 的注释里）。
 *
 * 另一条自证教训：第一版的**自证脚本**用 `String.replace` 造坏数据，
 * 而它只替换第一处（全仓有 5 处同名写法）→ 改到了别的行，目标那行压根没变，
 * 于是"守卫没报错"被我读成了"守卫漏报"。
 * **自证前先确认"改坏"真的改到了目标那一行（打印出来看）。**
 */
/**
 * 剥掉块注释，但**保留换行**（把注释内容换成等长空格）。
 *
 * ⚠️ 不能直接删掉整段注释 —— 那样后面所有行号都会往前移，
 * 报出来的行号对不上文件，人按行号去找会找错地方（第一版实测报 124、实际在 132）。
 */
const stripBlockComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/**
 * 每个主题色板变量都**带着语义**（见 `styles/themes.scss` 的变量说明）：
 *   `--m1..--m4` 主/辅/点缀色；`--ms` 柔和底（背景）；`--mt` 深文本；`--sh` 投影色。
 * 用错属性**不会报错**，只会静默变成"看不见"或"一块色斑"，所以没人会去查。
 *
 * 两类都真实发生过，而且都是"照着上一处抄"复制开的：
 *   · `--sh` 当 `background` —— 3 次，横跨 3 个页面；
 *   · `--ms` 当 `color` —— **39 次，横跨 6 个文件**：副标题与提示文字几乎隐形
 *     （`#FEF8E3` 压在 `#F5F7FA` 上，对比度 1.03:1，等于没写）。
 *
 * 判据：**先回溯到"这条声明"的属性名**，再判断这个令牌能不能用在该属性上。
 * ⚠️ 不能落在"这一行"上 —— 一行可以有多条声明，
 * `background: var(--sh); box-shadow: X;` 会因行内有 `box-shadow` 而被放行（第一版实测漏报）。
 */
const TOKEN_PROPERTY_RULES = [
  {
    token: '--sh',
    why:
      '--sh 是**投影色**（带 alpha 的 rgba），当背景 / 边框用语义是错的，' +
      '且在浅色页面上只是一块半透明色斑',
    fix: '背景请用 $bg-card（白卡）或 var(--ms)（主题浅底）',
    allow: (prop) => /^(?:-webkit-)?(?:box-shadow|text-shadow|filter|drop-shadow)$/.test(prop),
  },
  {
    token: '--ms',
    why: '--ms 是**柔和底**（背景色），当文字色用等于没写（浅底压浅底，对比度约 1:1）',
    fix: '文字请用 var(--mt)（主题深文本）或 $text-3（全局辅助文字）',
    allow: (prop) => prop !== 'color',
  },
];

for (const scss of walk(MP, (n) => n.endsWith('.scss'))) {
  const text = stripBlockComments(readSource(scss));
  for (const rule of TOKEN_PROPERTY_RULES) {
    const needle = `var(${rule.token})`;
    let idx = text.indexOf(needle);
    while (idx !== -1) {
      const before = text.slice(0, idx);
      const start = Math.max(
        before.lastIndexOf(';'),
        before.lastIndexOf('{'),
        before.lastIndexOf('}'),
      );
      const decl = before.slice(start + 1);
      const colon = decl.indexOf(':');
      if (colon !== -1) {
        const prop = decl.slice(0, colon).trim();
        if (!rule.allow(prop)) {
          const line = before.split('\n').length;
          const raw = (text.split(/\r?\n/)[line - 1] ?? '').trim();
          report(
            scss,
            `第 ${line} 行把 var(${rule.token}) 用在了 \`${prop}\` 上：${raw}\n` +
              `     ${rule.why}。${rule.fix}`,
          );
        }
      }
      idx = text.indexOf(needle, idx + 1);
    }
  }
}

// ---------- ⑪ WXML 里用到的 qz-* 组件类必须真的存在 ----------
/**
 * 判据：`class="qz-card-title"` 里的每个 `qz-*`，必须在 `apps/mp/styles/*.scss`
 * （或 `app.scss`）里有对应的 `.qz-*` 定义。
 *
 * 为什么单列一条：**类名写错一个前缀，样式就整体不生效，而没有任何东西会报错**。
 * 2026-09-20 做抽签工具时实测踩到：`pkg-toolkit/split-bill` 的 WXML 写了 **8 处**
 * `qz-card-title`，而它自己的 SCSS 里定义的是 `.card-title` —— 只差一个 `qz-`，
 * 于是那四个卡片标题**从来没吃到过样式**。编译、`tsc`、当时的全部守卫都不报，
 * 界面上只是"朴素了一点"，谁也不会去查。
 *
 * 与 ⑧（主题类未定义）、⑨（隐形装饰）同源：
 * **"写了类名"不等于"类名存在"，更不等于"样式生效"。**
 *
 * 判据刻意宽松，只查 `qz-` 前缀并跳过含 `{{` 的动态片段：
 *   · 页面自定义类（`chip-on`、`rise-particle`）不在范围内，不误伤；
 *   · `class="qz-i {{item.icon}}"` 这类模板语法跳过，不当成类名。
 * 实测全仓误报 0（177 个已定义类 / 全部 WXML 引用均可解析）。
 */
const STYLE_FILES = [
  ...readdirSync(join(MP, 'styles'))
    .filter((n) => n.endsWith('.scss'))
    .map((n) => join(MP, 'styles', n)),
  join(MP, 'app.scss'),
];

const definedQzClasses = new Set();
for (const f of STYLE_FILES) {
  let src = '';
  try {
    src = readFileSync(f, 'utf8');
  } catch {
    continue; // 样式文件缺失由别处负责，这里不重复报
  }
  for (const m of src.matchAll(/\.qz-[a-zA-Z0-9_-]+/g)) definedQzClasses.add(m[0].slice(1));
}

for (const wxml of walk(MP, (n) => n.endsWith('.wxml'))) {
  const src = readSource(wxml);
  for (const m of src.matchAll(CLASS_ATTR_RE)) {
    for (const token of m[1].split(/\s+/)) {
      if (!token.startsWith('qz-') || token.includes('{{')) continue;
      if (definedQzClasses.has(token)) continue;
      report(
        wxml,
        `用了「${token}」，但 apps/mp/styles/ 与 app.scss 里都没有定义这个类 —— ` +
          '样式不会生效，而编译、tsc 与其它守卫都不会报（界面上只是"朴素了一点"）。' +
          '要么改用已存在的类，要么先在 styles/ 里补上定义',
      );
    }
  }
}

// ---------- ⑫ 糖果图标必须真的有尺寸来源 ----------
/**
 * 判据：WXML 里的 `.qz-i` 元素必须有尺寸来源，否则它是 **0×0 的隐形元素**。
 *
 * 背景：`.qz-i` 基类（`styles/icons.scss`）只有 `display:inline-block` + `background-size`，
 * **不带任何宽高** —— 源码注释里也写明"尺寸由 `.qz-ico-*` 或外部样式给定"。
 * 与 ⑨（`qz-rise` 缺形状类）是同一类坑：背景图与动画都在，就是看不见。
 *
 * 三种放行情形（任一满足即可）：
 *   ① 祖先元素挂了 `qz-ico` —— 库内 `.qz-ico > .qz-i { width:100%; height:100% }` 已给足尺寸；
 *   ② 同一 class 里另有**本页 SCSS 中定义了 width/height 的类**（如 `nav-ico`）；
 *   ③ 本页 SCSS 里有给 `.qz-i` 设 width/height 的规则（如 `.cal .qz-i { width: … }`）。
 *
 * 2026-09-20 实测拦下 3 处：`pkg-toolkit/home` 的工具图标、`pages/station` 与
 * `pkg-os/plan` 的"演示模式"铃铛 —— 全是只挂 `qz-i qz-i-xxx` 而没有任何尺寸的裸用法。
 *
 * ⚠️ **必须先剥掉块注释再解析 SCSS**：注释里的 `.qz-press` 会和后面的真实规则
 * "拼接"成一个假匹配，把中间真正的 `.qz-i { … }` 规则吞掉 ——
 * 第一版探针正是这样漏判了 `pkg-toolkit/home`（⑩ 段踩过同一个坑）。
 */
const stripScssComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** 匹配一个标签：捕获 [1] 是否闭合、[3] 属性串、[4] 是否自闭合 */
const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
/** 不带 g，供 exec 用（`CLASS_ATTR_RE` 带 g，会被 lastIndex 影响） */
const CLASS_ATTR_IN = /class\s*=\s*"([^"]*)"/;

for (const wxml of walk(MP, (n) => n.endsWith('.wxml'))) {
  const sizedClasses = new Set();
  try {
    const scss = stripScssComments(readFileSync(wxml.replace(/\.wxml$/, '.scss'), 'utf8'));
    for (const m of scss.matchAll(/\.([a-zA-Z][\w-]*)[^{};]*\{([^{}]*)\}/g)) {
      if (/\b(?:width|height)\s*:/.test(m[2])) sizedClasses.add(m[1]);
    }
  } catch {
    // 没有同名 SCSS 的页面：仍可靠 ① 放行，下面照常判断
  }

  const src = readSource(wxml);
  const stack = [];
  for (const m of src.matchAll(TAG_RE)) {
    if (m[1]) {
      stack.pop();
      continue;
    }
    const cls = CLASS_ATTR_IN.exec(m[3])?.[1];
    if (cls) {
      const tokens = cls.split(/\s+/).filter((t) => t && !t.includes('{{'));
      const icons = tokens.filter((t) => t === 'qz-i' || t.startsWith('qz-i-'));
      if (icons.length) {
        const extras = tokens.filter((t) => !icons.includes(t));
        const wrapped = stack.some((s) => s.includes('qz-ico'));
        const sized = extras.some((t) => sizedClasses.has(t)) || sizedClasses.has('qz-i');
        if (!wrapped && !sized) {
          report(
            wxml,
            `图标「${cls}」没有任何尺寸来源 —— \`.qz-i\` 基类不带宽高（见 styles/icons.scss），` +
              '会渲染成 0×0 的隐形元素（编译、tsc 与其它守卫都不报）。' +
              '请用 `.qz-ico` + `.qz-ico-s/m/l/xl` 包一层，或在本页 SCSS 里给这个类补 width/height',
          );
        }
      }
    }
    if (!m[4]) stack.push(cls ?? '');
  }
}

// ---------- ⑬ wx:else / wx:elif 不能与 wx:for 挂在同一元素上 ----------
/**
 * 判据：同一个标签上不能既写 `wx:else`（或 `wx:elif`）又写 `wx:for`。
 *
 * 为什么单列一条：**这是 WXML 编译期直接报错、整个页面白屏**的一类问题，
 * 而 `npm run lint` / `tsc` / 其它守卫**全都不看 WXML 语法**，只有开发者工具会炸。
 * 2026-09-21 实测踩到：`pkg-vocab/home/index.wxml` 写了
 * `<view wx:else wx:for="{{books}}" …>`，开发者工具报
 * `Bad attr 'wx:else' with message: 'wx:if' not found` —— 首页整页打不开。
 *
 * 根因是**两个指令的作用对象不同**：
 *   · `wx:if/elif/else` 是"这一整块要不要渲染"（配对的是**同级的兄弟节点**）；
 *   · `wx:for` 是"这个节点自身要复制几份"。
 * WXML 解析 `wx:else` 时要往上找配对的 `wx:if`，而挂了 `wx:for` 的节点在
 * 编译期会被当成另一类节点，配对直接失败 —— 于是报"找不到 wx:if"，
 * 报错行号指向的是 `wx:for` 那几行，看起来像是 `wx:for` 写错了，**排查方向是错的**。
 *
 * 正确写法：用 `<block wx:else>` 包一层，`wx:for` 留在里面的真实节点上。
 *
 * 判据刻意宽松：只认"同一标签同时出现这两个指令"，不分析配对是否合法
 * （那需要完整 AST，且真正的配对错误开发者工具已经会给行号）。
 */
const ATTR_ELSE_RE = /\bwx:(?:else|elif)\b/;
const ATTR_FOR_RE = /\bwx:for\b/;
/** 不带 g 的标签正则，逐个 exec 拿行号 */
const TAG_SCAN_RE = /<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

for (const wxml of walk(MP, (n) => n.endsWith('.wxml'))) {
  const src = readSource(wxml);
  for (const m of src.matchAll(TAG_SCAN_RE)) {
    const attrs = m[2];
    if (ATTR_ELSE_RE.test(attrs) && ATTR_FOR_RE.test(attrs)) {
      const line = src.slice(0, m.index).split('\n').length;
      report(
        wxml,
        `第 ${line} 行 <${m[1]}> 同时挂了 wx:else/wx:elif 与 wx:for —— ` +
          'WXML 编译期会报「Bad attr `wx:else` with message: `wx:if` not found」并让整页白屏。' +
          '请用 `<block wx:else>` 包一层，把 wx:for 留在里面的节点上',
      );
    }
  }
}

// ---------- ⑭ 自造 CSS 令牌（var(--xxx) 必须真的定义过）----------
/**
 * 判据：页面 SCSS 里 `var(--xxx)` 的每个名字，必须是
 *   · `themes.scss` 里定义的主题变量（`--m1/--ms/--mt/--sh/--r-card/--tex-o`…），或
 *   · JS 运行时注入的（`--qz-sb`，见 `utils/system.ts`）。
 * 其余一律判失败。
 *
 * ## 为什么这是"静默失效"的重灾区
 *
 * 2026-09-21 实测：`pkg-practice/{home,session,stats}/index.scss` 共 **24 处**
 * 用了 `var(--color-text-primary, #212121)` 这类写法 —— 项目里**根本没有**
 * `--color-text-*` 这套令牌。于是每一处都取到兜底灰（`#212121`/`#616161`/`#9e9e9e`），
 * 与 `.th-practice` 的靛青主题完全不搭。
 *
 * 更隐蔽的是：**带兜底值的 `var()` 看起来像"优雅降级"，实际是"永远取不到主题色"**。
 * 编译不过？不会。`tsc`？不看 SCSS。`lint`？不查 CSS 变量。其他守卫？不管。
 * 界面上只是"颜色有点怪"，而**没有任何一处报错**。
 *
 * ⚠️ **这条规则的判据必须包含"名字里的 `--` 前缀名字本身存在"，
 *    而不是"`var()` 语法对不对"** —— 语法永远是对的，这才是它不报错的原因。
 *
 * ⚠️ `--qz-sb` 是 JS 注入的状态栏高度（自定义导航避让），属于合法例外。
 *    新增这类"运行期注入变量"时，要同时加进 `INJECTED_VARS`，
 *    否则会把正常代码判红 —— 而**假红灯比漏检更糟**（会被当成噪音绕过）。
 */
const INJECTED_VARS = new Set([
  'qz-sb', // 状态栏高度，utils/system.ts 注入
]);

/** themes.scss 里 `--xxx:` 声明过的全部主题变量名 */
const DECLARED_THEME_VARS = new Set(
  [...readFileSync(THEMES_SCSS, 'utf8').matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]),
);
// 主题变量只在 `.th-*` 块里声明；这里再兜上文档规定的那几个，防止解析漏掉
for (const v of ['m1', 'm2', 'm3', 'm4', 'ms', 'mt', 'sh', 'r-card', 'tex-o']) {
  DECLARED_THEME_VARS.add(v);
}

const VAR_USE_RE = /var\(\s*--([a-z0-9-]+)/gi;
/** 页面 SCSS（不含 styles/ 下的公共样式 —— 它们本来就在定义变量） */
const pageScss = walk(MP, (n) => n.endsWith('.scss')).filter(
  (p) => !p.includes(`${join('apps', 'mp', 'styles')}`) && !p.endsWith('app.scss'),
);

const tokenChecked = [];
for (const scss of pageScss) {
  // ⚠️ 必须先剥块注释：注释里的示例代码会被当成真实用法（踩过两遍，见 MEMORY）
  const src = stripBlockComments(readFileSync(scss, 'utf8'));
  for (const m of src.matchAll(VAR_USE_RE)) {
    const name = m[1];
    tokenChecked.push(name);
    if (DECLARED_THEME_VARS.has(name) || INJECTED_VARS.has(name)) continue;
    report(
      scss,
      `用了未定义的 CSS 变量 var(--${name}) —— 它不是 themes.scss 里的主题变量，` +
        '也不是 JS 注入的变量。**带兜底值的 var() 会永远取到兜底值**（看着像降级，实际是配色失效），' +
        '而编译 / tsc / lint 全都不报。中性文字色请用 tokens.scss 的 $text-1/-2/-3，' +
        '模块取色请用 var(--m1..--m4/--ms/--mt/--sh)',
    );
  }
}

/**
 * ⚠️ 判据下限自检（见 MEMORY 与 skill「守卫判据不能为空」）：
 * 解析失败 → 待检查集合为空 → 一条都没查 → 打印绿灯。
 * **假绿灯比误报危险得多**。所以这里必须打印"检查了几个"，并在低于下限时报错。
 */
const TOKEN_MIN_CHECKED = 30;
if (tokenChecked.length < TOKEN_MIN_CHECKED) {
  console.log(
    `❌ CSS 令牌规则的判据几乎为空（只扫到 ${tokenChecked.length} 个 var() 用法，` +
      `少于下限 ${TOKEN_MIN_CHECKED}）——\n` +
      '   说明 SCSS 收集或解析失效了（路径变了？文件被挪走了？）。\n' +
      '   此时"未定义令牌: 0"**不代表没问题**，只代表没查。请先修收集逻辑。\n',
  );
  process.exit(1);
}

// ---------- ⑮ 界面文案里不得混入繁体字 ----------
/**
 * 判据：WXML / TS 的**中文字符串字面量**里不得含繁体专有字。
 * 字表与判定函数来自 `scripts/db/traditional-chars.mjs`（与语料过滤**共用同一张表**）。
 *
 * ## 为什么要单独有一条
 *
 * 繁体混入有两个来源，一个是**数据**（Tatoeba 语料 / 上游词书），
 * 一个是**代码文案**。前者由 `fetch-sentences` / `gen-words` 过滤，
 * 但代码文案漏字没人管 —— 而它的表现和"数据里有繁体"**在界面上长得一模一样**，
 * 排查时会先怀疑数据、翻半天语料，最后发现是某句文案抄了繁体。
 *
 * 这条规则把两个来源分开：**代码里的繁体，就地报错**；
 * 数据里的繁体，由 `npm run check:trad` 那条链负责。
 *
 * ⚠️ 只查**字符串字面量与 WXML 文本节点**，不查注释 ——
 * 注释里出现繁体（引用上游样例、说明繁简差异）是合理的，判红会制造假警报。
 */
const { hasTraditional, findTraditional } = await import(
  pathToFileURL(join(ROOT, 'scripts/db/traditional-chars.mjs')).href
);

/** 收集"用户可见的中文"：WXML 文本 + 模板表达式里的中文，以及 TS 的字符串字面量 */
function userVisibleChunks(wxmlSrc) {
  // 去掉注释（`<!-- ... -->`）与标签属性，只留文本节点 —— 属性里多是类名/事件名
  return wxmlSrc
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .split('\n');
}

const TRAD_STR_RE = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const tradChecked = [];

for (const file of walk(MP, (n) => n.endsWith('.wxml'))) {
  const src = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  for (const m of src.matchAll(TRAD_STR_RE)) {
    const text = m[2];
    if (!/[\u4e00-\u9fff]/.test(text)) continue;
    tradChecked.push(text);
    if (hasTraditional(text)) {
      const line = src.slice(0, m.index).split('\n').length;
      report(
        file,
        `第 ${line} 行文案混入繁体字「${findTraditional(text).join('')}」：${text.slice(0, 40)} —— ` +
          '界面要求统一简体中文。请改成简体（字表见 scripts/db/traditional-chars.mjs）',
      );
    }
  }
  // WXML 文本节点（标签之间、不带引号的中文）
  for (const [i, chunk] of userVisibleChunks(readFileSync(file, 'utf8')).entries()) {
    const text = chunk.replace(/\{\{[^}]*\}\}/g, '').trim();
    if (!/[\u4e00-\u9fff]/.test(text)) continue;
    tradChecked.push(text);
    if (hasTraditional(text)) {
      report(
        file,
        `第 ${i + 1} 行文本节点混入繁体字「${findTraditional(text).join('')}」：${text.slice(0, 40)} —— ` +
          '界面要求统一简体中文',
      );
    }
  }
}

/** JS/TS 里的字符串字面量（注释先剥掉 —— 注释里引用繁体样例是合理的） */
function stripLineComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

for (const file of walk(MP, (n) => n.endsWith('.ts'))) {
  const raw = readFileSync(file, 'utf8');
  const src = stripLineComments(raw);
  for (const m of src.matchAll(TRAD_STR_RE)) {
    const text = m[2];
    if (!/[\u4e00-\u9fff]/.test(text)) continue;
    tradChecked.push(text);
    if (hasTraditional(text)) {
      const line = src.slice(0, m.index).split('\n').length;
      report(
        file,
        `第 ${line} 行文案混入繁体字「${findTraditional(text).join('')}」：${text.slice(0, 40)} —— ` +
          '界面要求统一简体中文',
      );
    }
  }
}

const TRAD_MIN_CHECKED = 200;
if (tradChecked.length < TRAD_MIN_CHECKED) {
  console.log(
    `❌ 繁体字规则的判据几乎为空（只扫到 ${tradChecked.length} 段中文，少于下限 ${TRAD_MIN_CHECKED}）——\n` +
      '   说明中文提取逻辑失效了（正则或文件收集变了？）。\n' +
      '   此时"繁体: 0"**不代表没问题**，只代表没查。请先修提取逻辑。\n',
  );
  process.exit(1);
}

// ---------- ⑯ 装饰层必须接指针视差（规范 §六 的"四步"是否真走完）----------
/**
 * 判据：凡是 WXML 里挂了 `.qz-deco` 的页面，必须同时满足
 *   ① WXML 里有 `.qz-fx` 视差层，且该层绑了 `style="{{fxStyle}}"`；
 *   ② 根节点绑了 `bindtouchmove`（start/end/cancel 与"TS 里有没有这个方法"由 ① 段兜）；
 *   ③ 同名 TS 里 `fxEnableTilt(` 与 `fxDisableTilt(` 都在（开在 onShow、关在 onHide）。
 *
 * ## 为什么这属于"不报错的不一致"
 *
 * 2026-10-08 全站盘点：`pkg-toolkit` 10 页里只有 4 页接了视差 ——
 * 同模块内一半页面的光斑/流线会跟着手指动、另一半纹丝不动。
 * `tsc` 不看 WXML，`lint` 不看装饰层，其余守卫只查"类名存不存在"，
 * 于是它的表现就只是"这一页死板一点"，**没有任何一处报错**，也没人会当回事。
 * 模块内部的一致性不能靠自觉，只能靠断言。
 *
 * ⚠️ 唯一豁免：`pages/common/webview.wxml` 的**降级分支** —— §十一 明确登记
 *    "只留一枚 blob-b，且刻意不接 .qz-fx 视差"（那一屏只有一个返回按钮，装饰跟手会晃眼）。
 *    新增豁免必须同时改 `docs/dev/MP-VISUAL-SYSTEM.md` §十一 的登记行，
 *    别只往这张表里加名字 —— 表和外层的豁免会各自漂移。
 */
const PARALLAX_ALLOWLIST = new Set([join(MP, 'pages/common/webview.wxml')]);
const FX_LAYER_RE = /class\s*=\s*"[^"]*\bqz-fx\b/;
const FX_STYLE_RE = /style\s*=\s*"\{\{fxStyle\}\}"/;
const fxChecked = [];

for (const wxml of walk(MP, (n) => n.endsWith('.wxml'))) {
  const src = readSource(wxml);
  if (!/class\s*=\s*"[^"]*\bqz-deco\b/.test(src)) continue;
  if (PARALLAX_ALLOWLIST.has(wxml)) continue;
  fxChecked.push(wxml);

  const ts = wxml.replace(/\.wxml$/, '.ts');
  const tsSrc = existsSync(ts) ? readFileSync(ts, 'utf8') : '';
  const missing = [];
  if (!FX_LAYER_RE.test(src)) missing.push('WXML 缺 `.qz-fx` 视差层（装饰直接放在 `.qz-deco` 里 = 静态）');
  if (!FX_STYLE_RE.test(src)) missing.push('`.qz-fx` 没绑 `style="{{fxStyle}}"`');
  if (!/\bbindtouchmove\s*=/.test(src)) missing.push('根节点没绑 `bindtouchmove`');
  if (!tsSrc.includes('fxEnableTilt(')) missing.push('TS 没调 `fxEnableTilt(this)`（应挂在 onShow）');
  if (!tsSrc.includes('fxDisableTilt(')) missing.push('TS 没调 `fxDisableTilt()`（应挂在 onHide）');

  if (missing.length) {
    report(
      wxml,
      `装饰层未接指针视差 —— ${missing.join('；')}。` +
        '后果是该页的光斑/流线完全不跟指针动，与同模块其它页观感割裂，且编译与 lint 都不报。' +
        '接入四步见 docs/dev/MP-VISUAL-SYSTEM.md §六',
    );
  }
}

const FX_MIN_CHECKED = 40;
if (fxChecked.length < FX_MIN_CHECKED) {
  console.log(
    `❌ 视差规则的判据几乎为空（只扫到 ${fxChecked.length} 个带 .qz-deco 的页面，少于下限 ${FX_MIN_CHECKED}）——\n` +
      '   说明 WXML 收集或 `.qz-deco` 匹配失效了（类名改了？目录挪了？）。\n' +
      '   此时"未接视差: 0"**不代表没问题**，只代表没查。请先修收集逻辑。\n',
  );
  process.exit(1);
}

// ---------- ⑰ 每页至少一处 `qz-an-*` 入场动效（§四 的"两级层次"）----------
/**
 * 判据：挂了 `.qz-page` 的 WXML 必须至少出现一次 `qz-an-in/-fade/-pop/-left/-right/-drop`。
 *
 * ## 为什么"整页淡入"不够
 *
 * `.qz-page` 自带的 `qzPageIn` 只做透明度（根节点禁止 transform，会成为 fixed 子元素的包含块），
 * 所以规范 §四 要的是**两级**层次：先整页淡入、再分区上浮（`qz-an-in` + `qz-d1..d8` 错位）。
 * 只挂了第一级的页面不是"坏了"，而是**整块内容同时闪现** —— 长列表页尤其显得廉价。
 * 2026-10-08 盘点时 `pkg-toolkit` 有 7 页只有第一级，和 ⑯ 是同一批落后页。
 *
 * ⚠️ 只断言"有没有"，不断言"错位用得对不对"（那需要理解 DOM 层级，误报率高）。
 *    `wx:for` 里的单个条目**不该**逐条带动效类，这是仓库既有惯例（见 unit-convert）。
 */
const ENTRY_ANIM_RE = /\bqz-an-(?:in|fade|pop|spring|left|right|drop)\b/;
const animChecked = [];

for (const wxml of walk(MP, (n) => n.endsWith('.wxml'))) {
  const src = readSource(wxml);
  if (!/\bqz-page\b/.test(src)) continue; // 组件片段不要求
  animChecked.push(wxml);
  if (ENTRY_ANIM_RE.test(src)) continue;
  report(
    wxml,
    '整页没有一处 `qz-an-*` 入场动效 —— 只剩整页淡入那一级，' +
      '内容会整块同时闪现而不是分区上浮。请给页头与每张顶层卡片加 `qz-an-in` + `qz-d1..d8`（§四）',
  );
}

const ANIM_MIN_CHECKED = 40;
if (animChecked.length < ANIM_MIN_CHECKED) {
  console.log(
    `❌ 入场动效规则的判据几乎为空（只扫到 ${animChecked.length} 个页面级 WXML，少于下限 ${ANIM_MIN_CHECKED}）——\n` +
      '   说明收集或 `.qz-page` 匹配失效了。此时"缺动效: 0"只代表没查，不代表没问题。\n',
  );
  process.exit(1);
}

// ---------- ⑱ 页面 SCSS 禁止裸色值（红线 2 的机器版）----------
/**
 * 判据：`apps/mp/styles/**`（令牌定义处）**以外**的每个 SCSS，剥掉注释后
 *   · 不得出现 `#RGB` / `#RRGGBB` 字面量 —— 取色只走 `var(--m1..--m4/--ms/--mt/--sh/--r-card)`
 *     与 `tokens.scss` 令牌；
 *   · 不得出现**数字型** `rgba(255, …)` / `rgb(0 …)` —— 白罩用 `$glass-faint/soft/mid/text/card`，
 *     警示用 `$warning-veil/-line`、`$danger-veil`，主题色阴影用 `var(--sh)` 或 `$shadow-tint-*`。
 *   `rgba($success, .08)` 这种**对令牌取色**的写法是合法的，不判红。
 *
 * ## 为什么这一条必须机器盯
 *
 * 红线写在 §二 和 §九 里，但**没有任何编译期或 lint 规则看 SCSS 的颜色**。
 * 2026-10-08 盘点时 `pkg-practice`（3 页 5 处）与 `pkg-vocab/home`（1 处）
 * 还留着 `color: #ffffff` —— 视觉后果是零（白就是白），所以人也不会去改它。
 * 真正的代价是**换肤/深色模式时这六处不会跟着变**，而那时已经没人记得它们在哪。
 *
 * ⚠️ 剥注释**必须保留行数**：块注释里的换行如果被吃掉，报出来的行号会整体前移，
 *    排查时按行号打开文件会看到完全无关的一行（⑩⑫ 段踩过"没剥注释"的坑，
 *    这次踩到的是它的孪生问题"剥得太狠"）。
 */
const stripCommentsKeepLines = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) || []).length))
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');

const RAW_HEX_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
const RAW_RGB_RE = /\brgba?\(\s*[\d.]/g;
const colorChecked = [];

for (const scss of walk(MP, (n) => n.endsWith('.scss'))) {
  // 只管**页面级** SCSS（pages/** 与 pkg-*/**）—— `styles/**` 是令牌定义处、
  // `app.scss` 是全局入口，二者的字面色值正是令牌该住的地方（§二 红线的原文也是"页面 SCSS"）。
  const rel = relative(MP, scss);
  if (!(rel.startsWith('pages') || rel.startsWith('pkg-'))) continue;
  const src = stripCommentsKeepLines(readFileSync(scss, 'utf8'));
  colorChecked.push(scss);

  for (const m of src.matchAll(RAW_HEX_RE)) {
    const line = src.slice(0, m.index).split('\n').length;
    report(
      scss,
      `第 ${line} 行裸色值「${m[0]}」—— 页面 SCSS 禁止写十六进制色，` +
        '请改用 `var(--m1..--m4/--ms/--mt/--sh/--r-card)` 或 `tokens.scss` 令牌（白字用 `$text-inverse`），见 §二',
    );
  }
  for (const m of src.matchAll(RAW_RGB_RE)) {
    const line = src.slice(0, m.index).split('\n').length;
    const arg = src.slice(m.index + m[0].length, m.index + m[0].length + 26).replace(/\s+/g, ' ');
    report(
      scss,
      `第 ${line} 行裸 rgba()/rgb() 数字字面量「${m[0]}${arg}…」—— ` +
        '白罩用 `$glass-faint/soft/mid/text/card`，' +
        '警示用 `$warning-veil/-line`、`$danger-veil`，主题色投影用 `var(--sh)` 或 `$shadow-tint-*`；' +
        '缺档位就往 tokens.scss 补一个再引用，别在页面里写字面量（§九）',
    );
  }
}

const COLOR_MIN_CHECKED = 40;
if (colorChecked.length < COLOR_MIN_CHECKED) {
  console.log(
    `❌ 裸色值规则的判据几乎为空（只扫到 ${colorChecked.length} 个页面 SCSS，少于下限 ${COLOR_MIN_CHECKED}）——\n` +
      '   说明页面 SCSS 的收集范围变了（`pages/**` 与 `pkg-*/**` 才归 ⑱ 管，styles/ 与 app.scss 不管）。\n' +
      '   此时"裸色值: 0"只代表没查，不代表没问题。请先修收集逻辑。\n',
  );
  process.exit(1);
}

// ---------- ⑲ 糖果图标的 data-URI 必须是完整可用的 SVG ----------
/**
 * 判据：`styles/icons.scss` 里每条 `.qz-i-<名字>` 规则，其 `url("data:image/svg+xml;utf8,…")` 必须
 *   · **整串在同一行**（小程序 WXSS 里跨行的 data-URI 会整条声明失效）；
 *   · 含 `<svg ` 且**恰好一对** `<svg`/`</svg>`；
 *   · **不含裸 `#`**（十六进制必须写成 `%23`，裸 `#` 会让 data-URI 从 `#` 处截断）；
 *   · SVG 体内不含双引号（外层用 `url("…")` 的双引号包裹，内层属性一律单引号）；
 *   · 有底色造型（`fill='%23` 开头的那个形状）与白色图形（`fill='white'` 或 `stroke='white'`）。
 *
 * ## 为什么手画图标需要一条尺子
 *
 * 图标是**一行几百字符的内联 SVG**，写错一处不会报错：WXSS 只当这条声明没解析成功，
 * 界面上那一格就是空白 —— 和 ⑫（图标没尺寸）、③（组件类名不存在）同一族静默失效。
 * 而 §三 的规范是靠人肉遵守的，新增一枚图标（2026-10-08 补的 `.qz-i-calendar`）
 * 恰恰是最容易手滑的一次。
 */
const ICON_RULE_RE = /\.qz-i-([a-z0-9-]+)\s*\{\s*background-image:\s*url\("([^"]*)"\);\s*\}/g;
const iconsSrc = readFileSync(join(MP, 'styles/icons.scss'), 'utf8');
const iconNames = new Set();

for (const m of iconsSrc.matchAll(ICON_RULE_RE)) {
  const [, name, uri] = m;
  iconNames.add(name);
  const line = iconsSrc.slice(0, m.index).split('\n').length;
  const bad = [];
  if (!uri.startsWith('data:image/svg+xml;utf8,')) bad.push('不是 `data:image/svg+xml;utf8,` 前缀');
  if (uri.includes('#')) bad.push('含裸 `#`（必须写成 `%23`，否则 data-URI 会在此处截断）');
  if (uri.includes('\n')) bad.push('整串跨行（WXSS 里这条声明会整条失效）');
  const inner = uri.slice('data:image/svg+xml;utf8,'.length);
  if ((inner.match(/<svg[\s>]/g) || []).length !== 1) bad.push('<svg> 不是恰好一个');
  if ((inner.match(/<\/svg>/g) || []).length !== 1) bad.push('</svg> 不是恰好一个');
  if (/'[^']*"|"[^']*'/.test(inner)) bad.push('属性引号不成对（内层只能用单引号）');
  if (!/fill='white'|stroke='white'/.test(inner)) bad.push('没有白色图形（§三 要求负形挖空用 white）');
  if (!/fill='%23/.test(inner)) bad.push('没有带 %23 转义的识别色底座（§三 要求自带底色造型）');
  if (bad.length) {
    report(
      join(MP, 'styles/icons.scss'),
      `第 ${line} 行 .qz-i-${name} 的 data-URI 有问题 —— ${bad.join('；')}。` +
        '后果是该图标**整条声明静默失效**（屏幕上那一格空白），编译与 lint 都不报错',
    );
  }
}

/** 库里定义过、但没有任何页面用到的图标只允许存在（图标库可留备用位），不判红 */
const ICON_MIN_DEFINED = 40;
if (iconNames.size < ICON_MIN_DEFINED) {
  console.log(
    `❌ 图标 data-URI 规则的判据几乎为空（只解析到 ${iconNames.size} 枚图标，少于下限 ${ICON_MIN_DEFINED}）——\n` +
      '   说明 `ICON_RULE_RE` 与 icons.scss 的书写格式已经对不上了（改成多行写法了？前缀变了？）。\n' +
      '   此时"坏图标: 0"只代表没查，不代表没问题。改图标写法格式时要同步改这条正则。\n',
  );
  process.exit(1);
}

// ---------- ⑳ 视差层里的装饰必须"真看得见"（外扩 40rpx 的裁切坑）----------
/**
 * 判据：装饰子元素放在 `.qz-fx` 里时，若它带的库类**本身不带定位**
 * （`qz-flow` / `qz-water` / `qz-wave` / `qz-curve` —— 见 deco.scss，只有背景与动效），
 * 或带的是 `qz-topline`（库里是 `position:absolute; top:0`），就必须由**本页 SCSS** 给出定位：
 *   · 前者：`position` +（`top` 或 `bottom`）；
 *   · 后者：`top` 且 ≥ 40rpx。
 * 否则该装饰按普通流排在 `.qz-fx` 顶边，而 `.qz-fx` 相对 `.qz-deco` 外扩 40rpx，
 * 于是整条落进 `.qz-deco { overflow: hidden }` 的裁切区之外 —— **动画在跑、编译不报、屏幕上什么都没有**。
 *
 * ## 为什么这一条值得单独有一条尺子
 *
 * 2026-10-08 给 `pkg-toolkit` 补视差时撞出来的：那三页的流线/曲线/顶线包装进 `.qz-fx` 之后
 * 会被裁掉，而"给它补个 top"看着像是已经处理过了（`pkg-practice` 两页的 `.practice-curve`
 * 就**只写了 `top: 300rpx`**，可 `top` 对 `position: static` 的元素完全无效 ——
 * 那条弧十年来一直贴在页面最上沿被削掉一截，谁也没发现）。
 * 这与 ⑨（隐形装饰）、⑫（图标没尺寸）同族：**"写了装饰类"不等于"装饰看得见"。**
 *
 * ⚠️ 类名带 `{{...}}` 的（动态拼类名，如 `pkg-toolkit/home` 的图标）静态判不了，跳过而不是猜。
 */
const POSITION_LESS_DECO = ['qz-flow', 'qz-water', 'qz-wave', 'qz-curve'];
const TOPLINE_CLASS = 'qz-topline';
/** `.qz-fx` 相对 `.qz-deco` 的外扩量（deco.scss 里写死 40rpx） */
const FX_INSET_RPX = 40;

/** 把 SCSS 解析成 `类名 → 该选择器块的全文`（含嵌套子块；不做完整 AST，够用即可） */
function scssClassBlocks(src) {
  const map = new Map();
  for (const m of src.matchAll(/\.(qz-[a-zA-Z0-9_-]+|[a-zA-Z0-9_-]+)\s*\{/g)) {
    let i = src.indexOf('{', m.index) + 1;
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') depth -= 1;
      i += 1;
    }
    map.set(m[1], (map.get(m[1]) || '') + '\n' + src.slice(m.index, i));
  }
  return map;
}

const decoLib = scssClassBlocks(
  readFileSync(join(MP, 'styles/deco.scss'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, ''),
);
const decoChecked = [];

for (const wxml of walk(MP, (n) => n.endsWith('.wxml'))) {
  const src = readSource(wxml);
  const decoBlock = src.match(/<view class="qz-deco">[\s\S]*?<\/view>\s*(?=<view class="qz-content")/);
  if (!decoBlock || !/<view class="qz-fx"/.test(decoBlock[0])) continue;

  const scss = wxml.replace(/\.wxml$/, '.scss');
  const page = scssClassBlocks(
    existsSync(scss)
      ? readFileSync(scss, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      : '',
  );
  const merge = (cls) => `${decoLib.get(cls) || ''}\n${page.get(cls) || ''}`;

  for (const kid of decoBlock[0].matchAll(/<view class="([^"]*)"/g)) {
    const classes = kid[1].trim().split(/\s+/).filter((c) => c && !c.startsWith('qz-fx'));
    if (classes.some((c) => c.includes('{{'))) continue; // 动态类名判不了
    const positionless = POSITION_LESS_DECO.filter((p) => classes.includes(p));
    const isTopline = classes.includes(TOPLINE_CLASS);
    if (!positionless.length && !isTopline) continue;
    decoChecked.push(`${relative(ROOT, wxml)}#${classes.join('.')}`);

    const bad = [];
    if (positionless.length) {
      const blocks = classes.map(merge).join('\n');
      if (!/position:\s*(absolute|fixed|relative)/.test(blocks)) {
        bad.push(`库内 .${positionless.join('/.')} 不带 position，页内也没给 → 按普通流排到 .qz-fx 顶边`);
      } else if (!/\btop:|\bbottom:/.test(blocks)) {
        bad.push('页内给了 position 却没给 top/bottom → 仍然贴在视差层顶边');
      }
    }
    if (isTopline) {
      const blocks = classes.map(merge).join('\n');
      const topVals = [...blocks.matchAll(/\btop:\s*(-?[\d.]+)rpx/g)].map((t) => parseFloat(t[1]));
      if (!topVals.length) {
        if (!/\btop:/.test(blocks)) bad.push(`.${TOPLINE_CLASS} 库内是 top:0，页内没补 top → 整条 6rpx 落在裁切区外`);
      } else if (Math.max(...topVals) < FX_INSET_RPX) {
        bad.push(`.${TOPLINE_CLASS} 的 top=${Math.max(...topVals)}rpx < 外扩量 ${FX_INSET_RPX}rpx → 仍被裁掉`);
      }
    }
    if (bad.length) {
      report(
        wxml,
        `装饰 [${classes.join(' ')}] 在 .qz-fx 里**看不见** —— ${bad.join('；')}。` +
          `补救：给该类在本页 SCSS 里写 position + top/bottom，并把坐标按 .qz-fx 外扩 ${FX_INSET_RPX}rpx 换算` +
          '（样板见 pkg-vocab/home 的 .vocab-curve、pkg-toolkit/home 的 .qz-flow；§六 与 §九）',
      );
    }
  }
}

const DECO_VIS_MIN_CHECKED = 10;
if (decoChecked.length < DECO_VIS_MIN_CHECKED) {
  console.log(
    `❌ 装饰可见性规则的判据几乎为空（只解析到 ${decoChecked.length} 个待查装饰，少于下限 ${DECO_VIS_MIN_CHECKED}）——\n` +
      '   说明 deco.scss 的类名或页面的 .qz-deco 结构变了，静态解析对不上了。\n' +
      '   此时"看不见: 0"只代表没查，不代表没问题。请先修解析逻辑。\n',
  );
  process.exit(1);
}

// ---------- ㉑ 页面 SCSS 不得自写 @keyframes（§四"动效只在库里"）----------
/**
 * 判据：`pages` 目录与 `pkg-` 开头的分包目录里的 SCSS 不得出现 `@keyframes`（动效一律进
 * `styles/motion.scss` / `styles/deco.scss`，页面只做组合）。`styles` 目录与 `app.scss` 是库本体，豁免。
 *
 * ## 为什么这条纪律必须机器盯
 *
 * §四 开头那句话（"别自己写 keyframes"）写了很久，但**没有任何一条断言查它** ——
 * 三个页面的文件头注释甚至都在自我声明"本文件不自造 @keyframes"，而守卫对此一无所知。
 * 一旦有人在页面里私自加一条曲线，全站节奏就散了：同一个"入场"会有五种时长与缓动，
 * 而 §四 统一节奏的意义正是"所有动效看起来是同一套身体做出来的"。
 * 本轮加 `.qz-an-spring`（逐条弹性入场）与升级 `.qz-press`（非对称按压）时，
 * 新原语全部落在库里、页面只挂类名 —— 这条断言就是保证这件事不会靠自觉。
 *
 * ⚠️ **必须先剥注释**：现存 3 处 `@keyframes` 全都在注释里自我声明（notifications/chat/service-new），
 *    不剥注释就是三个假红灯（⑩⑫ 的老坑，这次是它的第三种变体）。
 */
const PAGE_SCSS_RE = /^(pages|pkg-)/;
const kfChecked = [];

for (const scss of walk(MP, (n) => n.endsWith('.scss'))) {
  if (!PAGE_SCSS_RE.test(relative(MP, scss))) continue;
  const src = stripCommentsKeepLines(readFileSync(scss, 'utf8'));
  kfChecked.push(scss);
  for (const m of src.matchAll(/@keyframes/g)) {
    const line = src.slice(0, m.index).split('\n').length;
    report(
      scss,
      `第 ${line} 行自写 @keyframes —— §四 要求动效原语只能进 styles/motion.scss 或 styles/deco.scss，` +
        '页面只组合类名。私自加曲线会让全站"入场"出现好几种时长与缓动，请把它提到库里再引用',
    );
  }
}

const KF_MIN_CHECKED = 40;
if (kfChecked.length < KF_MIN_CHECKED) {
  console.log(
    `❌ 自写 keyframes 规则的判据几乎为空（只扫到 ${kfChecked.length} 个页面 SCSS，少于下限 ${KF_MIN_CHECKED}）——\n` +
      '   说明 `pages/**` 与 `pkg-*/**` 的收集范围变了。此时"自造 keyframes: 0"只代表没查。\n',
  );
  process.exit(1);
}

// ---------- 输出 ----------
if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify(
      {
        problems,
        counts: {
          tokens: tokenChecked.length,
          chinese: tradChecked.length,
          parallax: fxChecked.length,
          entryAnim: animChecked.length,
          pageScss: colorChecked.length,
          icons: iconNames.size,
          decoVisible: decoChecked.length,
          keyframes: kfChecked.length,
        },
      },
      null,
      2,
    ),
  );
} else if (problems.length === 0) {
  console.log(
    '✅ 小程序静态体检通过：事件绑定齐全、无静默跳转、无孤岛页、无未标注假数据、' +
      '无骨架页误导文案、地址数据未散落、主题类均已定义且无死主题类、无隐形装饰元素、' +
      '语义令牌（--sh / --ms）未被用错属性、qz-* 组件类均有定义、糖果图标均有尺寸来源、' +
      '无 wx:else 与 wx:for 同挂一处的编译期错误、' +
      `无自造 CSS 令牌（已核 ${tokenChecked.length} 处 var()）、` +
      `界面文案无繁体字（已核 ${tradChecked.length} 段中文）、` +
      `装饰层均已接指针视差（已核 ${fxChecked.length} 页，webview 降级分支按 §十一 豁免）、` +
      `每页均有入场动效（已核 ${animChecked.length} 页）、` +
      `页面 SCSS 无裸色值（已核 ${colorChecked.length} 个文件）、` +
      `糖果图标 data-URI 均完整可用（已核 ${iconNames.size} 枚）、` +
      `视差层内每条装饰都落在裁切区之内（已核 ${decoChecked.length} 条流线/水波/曲线/顶线）、` +
      `动效原语只在库里未被子类化（已核 ${kfChecked.length} 个页面 SCSS 无自造 @keyframes）`,
  );
} else {
  console.log(`❌ 发现 ${problems.length} 处问题：\n`);
  for (const p of problems) console.log(`  ${p.file}\n     ${p.msg}`);
}

process.exit(problems.length === 0 ? 0 : 1);
