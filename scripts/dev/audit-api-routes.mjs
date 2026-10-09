#!/usr/bin/env node
/**
 * 接口对齐体检：**客户端调用的每个接口，后端是否真的注册了**。
 *
 * ## 为什么需要它
 *
 * 2026-09-18 排查"订单交付假提示"时发现：`apps/mp/utils/api.ts` 里的
 * `orderApi` 有 7 个方法，而 `POST/GET /orders/*` **后端一个都不存在**（全部 404）。
 * 驿站模块同样只有 2 个只读接口是真的。
 *
 * 这类问题的表现是**静默的**：
 *   · 页面调了不存在的接口 → 请求 404 → 大多数页面 catch 后 toast 一下就完了；
 *   · 更糟的是**页面根本没调接口**，直接弹"已提交/已报名"（假成功）。
 * 两者都不会让 `tsc` / `eslint` / 单测报错，**只有真机点一遍才会发现**。
 *
 * 本脚本把这件事变成静态可查：从后端控制器提取真实路由，
 * 与客户端 `api.ts` 的调用做集合比对。
 *
 * ## 豁免清单
 *
 * 已知"后端未开工但前端已留位"的调用，必须写进 `KNOWN_MISSING` 并**说明缺什么**。
 * 不许直接删条目让体检变绿 —— 那等于把"已知缺口"变成"未知缺口"。
 *
 * 用法：`npm run audit:api`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const API_SRC = join(ROOT, 'apps/api/src');
const CLIENT = join(ROOT, 'apps/mp/utils/api.ts');

/**
 * 已知缺口：后端尚未开工，前端已按接口清单留位。
 * ⚠️ 每条都必须写清"缺什么"，以及对应任务编号。
 */
const KNOWN_MISSING = new Map([
  // ---------- 驿站：**写路径已全部实现**（M3-01 / 06 / 07 / 08 / 09 / 10）----------
  // 2026-09-19：StationModule 注册了 categories / tasks(POST) / parse /
  // tasks/:id/apply / tasks/:id/select / tasks/:id/close / match / applications，
  // 因此本段豁免**已全部移除**。
  // 服务商品 CRUD（M3-04）与服务者入驻认证（M3-02）的后端均已落地（2026-09-19）；
  // 它们此前不在表里是因为"客户端方法还没有"——接线后按真实实现对账即可。

  // ---------- OS 计划看板（Run）：2026-09-19 M2-06 后端已落地 ----------
  // GET /os/runs/:id、confirm、nodes/:nodeId/publish 均已注册并鉴权，
  // 本段豁免**全部移除**（历史见 git）。

  // ---------- 其它 ----------
  // 2026-09-20：`GET /notifications` 已随 M3-19 落地（notification.controller 注册 + 鉴权），
  // 但豁免条目一直留着 —— 守卫会把它当"未开工"放进报告，于是体检结果与现状不符
  //（守卫自己也会提示"以下豁免条目后端已存在，请从 KNOWN_MISSING 移除"）。
  // 现已移除。**这张表是"未开工缺口台账"，实现完就该划掉，否则它会腐化成本地版的假数据。**
]);

/** 递归收集目录下所有匹配后缀的文件 */
function walk(dir, ext, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
      walk(p, ext, out);
    } else if (name.endsWith(ext)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 归一化路径，让两端可比。
 *
 * 客户端 `/orders/${id}/deliver` → `/orders/*\/deliver`
 * 后端   `@Get(':id/download')`   → `/files/*\/download`
 *
 * 同时去掉 query（`/station/match?taskId=x` → `/station/match`）——
 * 后端路由里不含 query，不处理会让每条带参调用都误报。
 */
function normalize(path) {
  const noQuery = path.split('?')[0];
  const noParam = noQuery.replace(/\$\{[^}]*\}/g, '*').replace(/:[A-Za-z_][\w]*/g, '*');
  const collapsed = noParam.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
}

/** 从后端控制器提取真实路由 → Set("GET /orders/*\/deliver") */
function collectBackendRoutes() {
  const routes = new Map();
  for (const file of walk(API_SRC, '.controller.ts')) {
    const src = readFileSync(file, 'utf8');
    const ctrl = src.match(/@Controller\(\s*['"`]([^'"`]*)['"`]\s*\)/);
    if (!ctrl) continue;
    const prefix = normalize('/' + ctrl[1]);

    // 逐个匹配路由装饰器；无参数的（@Get()）视为挂在控制器根路径
    const re = /@(Get|Post|Put|Patch|Delete)\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const method = m[1].toUpperCase();
      const sub = m[2] ?? '';
      const full = normalize(sub ? `${prefix}/${sub}` : prefix);
      // 返回类型只对无参路由取（带参的签名解析容易误判，宁可不查）
      const ret = sub && !sub.includes(':') ? findReturnType(src, method, full) : null;
      routes.set(`${method} ${full}`, { path: full, ret, file });
    }
  }
  return routes;
}

/** 转义正则元字符（路径里可能含 `:` 或 `*`） */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从 `from` 起找到**调用括号 `(`** 的位置，跳过泛型参数。
 *
 * 泛型可能跨行、且内部含字符串字面量，所以不能"找第一个引号"。
 * 按尖括号深度扫描；`=>` 里的 `>` 要忽略，否则箭头类型会把深度算错。
 * 找不到返回 -1。
 */
function findCallParen(src, from) {
  let i = from;
  let angle = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '<') {
      angle += 1;
      i += 1;
    } else if (ch === '>' && src[i - 1] !== '=') {
      angle -= 1;
      i += 1;
      // ⚠️ 这里**不能 break** —— 泛型闭合后还要继续往后找调用括号 `(`。
      // 曾经写成 break，导致带泛型的调用全部漏掉（44 个只解析出 6 个）。
      if (angle < 0) angle = 0;
    } else if (angle === 0 && ch === '(') {
      return i;
    } else {
      i += 1;
    }
  }
  return -1;
}

/** 读 `(` 之后第一个字符串字面量（跳过空白）；不是字符串则返回 null */
function readFirstString(src, from) {
  let j = from;
  while (j < src.length && /\s/.test(src[j])) j += 1;
  const quote = src[j];
  if (!['`', "'", '"'].includes(quote)) return null;
  const end = src.indexOf(quote, j + 1);
  if (end === -1) return null;
  return src.slice(j + 1, end);
}

/** 读 `http.xxx` 与 `(` 之间的泛型实参文本（没有泛型则返回 ''） */
function readGeneric(src, from, paren) {
  const raw = src.slice(from, paren).trim();
  return raw.startsWith('<') ? raw.slice(1, -1).trim() : '';
}

/**
 * 泛型是不是"裸数组"（`Foo[]` / `Array<Foo>` / 元组）。
 *
 * 只看最外层：`{ a: string[] }` 不是数组，`Foo[] | null` 算数组。
 */
function isArrayType(t) {
  if (!t) return false;
  const s = t.replace(/\s+/g, '');
  if (/^Array</.test(s) || /^ReadonlyArray</.test(s)) return true;
  // 去掉联合里的 null/undefined 再判后缀
  const core = s.split('|').find((p) => p && p !== 'null' && p !== 'undefined') ?? '';
  return core.endsWith('[]') || core.startsWith('[');
}

/**
 * 从后端控制器里找该路由的返回类型文本。
 *
 * ## 为什么不用正则一把梭
 *
 * 返回类型有两种形态，正则很难同时吃下：
 *   A. `today(...): Promise<X> {` —— 无花括号，第一个 `{` 就是函数体；
 *   B. `modules(): { modules: X[] } {` —— 返回类型**自己有花括号**，
 *      要等它配平后遇到的 `{` 才是函数体。
 *
 * ⚠️ 而且这些文件是 **CRLF** 检出的（实测），把换行写成 `\n` 会一条都匹配不到，
 * 于是 `ret` 全是 `null` → 形状规则**空跑并且"通过"**。
 * **"判据为空所以恒真"的守卫比误报危险得多** —— 它给人一个假的绿灯。
 * （本次就是先踩了这个：修完缺陷守卫仍是 0，查了半天才发现正则没匹配上。）
 *
 * 所以改成**按括号深度扫描**，不依赖换行与缩进。
 * 解析不出就返回 `null`（视为"没结论"，**不报错**）—— 宁可漏查，不要误报。
 */
function findReturnType(src, method, path) {
  const leaf = path.split('/').filter(Boolean).pop() ?? '';
  if (!leaf) return null;
  const verb = method[0] + method.slice(1).toLowerCase();
  // ⚠️ 装饰器里的路径**带引号**（`@Get('modules')`）。两边都要认引号。
  const re = new RegExp(`@${verb}\\(\\s*['"\`]${escapeRe(leaf)}['"\`]\\s*\\)`);
  const m = re.exec(src);
  if (!m) return null;

  // 装饰器之后可能有别的装饰器（`@ApiOperation({...})`），所以从装饰器位置往后
  // 找**第一个形如 `名字(` 的方法签名**。用 `\n[ \t]*名字` 定位，CRLF 由 `\s` 兜住。
  const after = src.slice(m.index, m.index + 4000);
  const nameRe = /\s([A-Za-z_$][\w$]*)\s*\(/g;
  let nm;
  while ((nm = nameRe.exec(after)) !== null) {
    const name = nm[1];
    // 跳掉装饰器名与关键字
    if (['ApiOperation', 'ApiTags', 'ApiResponse', 'if', 'for', 'while', 'return'].includes(name)) continue;
    const at = m.index + nm.index + 1;
    const ret = readDeclaredReturn(src, at);
    if (ret !== null) return ret;
  }
  return null;
}

/**
 * 从方法名位置起，读出 `): 返回类型` 里那段返回类型。
 *
 * 返回类型可能是 `Promise<X>`，也可能是自带花括号的对象字面量类型 `{ a: X }`。
 * 扫描逻辑拆成 `scanReturn` 是为了把圈复杂度压到 10 以内
 * （`readDeclaredReturn` 只负责定位 `:` 的位置）。
 */
function readDeclaredReturn(src, from) {
  const open = src.indexOf('(', from);
  if (open < 0 || open - from > 200) return null;
  const close = matchParen(src, open);
  if (close < 0) return null;

  let j = close + 1;
  while (j < src.length && /\s/.test(src[j])) j += 1;
  if (src[j] !== ':') return null;
  return scanReturn(src, j + 1);
}

/**
 * 从 `:` 之后扫描返回类型，遇到函数体开括号就收。
 *
 * 逐字符推进，每个字符只做一件事（拆成三个小判定是为了把圈复杂度压在 10 以内 ——
 * 一串 `if/else if` 里每个 `&&` 都会加分，堆在一起必然超标）。
 */
function scanReturn(src, start) {
  const st = { angle: 0, brace: 0 };
  const limit = Math.min(src.length, start + 4000);

  for (let j = start; j < limit; j += 1) {
    const c = src[j];
    if (c === '<') st.angle += 1;
    else if (c === '>' && src[j - 1] !== '=') st.angle -= 1;

    const verdict = classify(st, src, j);
    if (verdict === 'body') return normalizeRet(src.slice(start, j));
    if (verdict === 'stop') return null;
  }
  return null;
}

/** 当前字符对"返回类型 / 函数体"的判定：`skip` 继续、`body` 到函数体、`stop` 放弃 */
function classify(st, src, j) {
  if (st.angle > 0) return 'skip';
  const c = src[j];
  if (c === ';' && st.brace === 0) return 'stop';
  if (c !== '{' && c !== '}') return 'skip';
  if (c === '}') {
    if (st.brace > 0) st.brace -= 1;
    return 'skip';
  }
  if (st.brace > 0) {
    st.brace += 1;
    return 'skip';
  }
  // 深度为 0 的 `{`：紧跟在 `:` 之后是返回类型，否则是函数体
  if (opensReturnType(src, j)) {
    st.brace = 1;
    return 'skip';
  }
  return 'body';
}

/** 这个 `{` 是不是"返回类型的对象字面量"？（判据：它所在行、它之前紧邻 `:`） */
function opensReturnType(src, at) {
  const lineStart = src.lastIndexOf('\n', at) + 1;
  return /:\s*$/.test(src.slice(lineStart, at));
}

/** 配对括号；找不到返回 -1 */
function matchParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 归一化：去掉空白、剥掉 `Promise<...>` */
function normalizeRet(raw) {
  const ret = raw.trim();
  if (!ret) return null;
  const compact = ret.replace(/\s+/g, '');
  const p = /^Promise<([\s\S]*)>$/.exec(compact);
  return p ? p[1] : compact;
}

/**
 * 从客户端 api.ts 提取调用 → [{method, path, line, generic}]
 *
 * ⚠️ 不能"从 http.xxx 往后找第一个引号"——泛型里就可能含字符串字面量。
 * 实测踩到：`http.post<{ ...; type: 'ai' | 'human' }[]>('/os/intent')`
 * 会命中泛型里的 `'ai'`，被当成路径 `/ai`（误报）。
 */
function collectClientCalls() {
  const src = readFileSync(CLIENT, 'utf8');
  const calls = [];
  const re = /http\.(get|post|put|patch|delete)\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const paren = findCallParen(src, m.index + m[0].length);
    if (paren === -1) continue;
    const raw = readFirstString(src, paren + 1);
    if (raw === null) continue;
    calls.push({
      method: m[1].toUpperCase(),
      path: normalize(raw),
      raw,
      generic: readGeneric(src, m.index + m[0].length, paren),
      line: src.slice(0, m.index).split('\n').length,
    });
  }
  return calls;
}

const backend = collectBackendRoutes();
const client = collectClientCalls();

const missing = client.filter((c) => !backend.has(`${c.method} ${c.path}`));
const known = missing.filter((c) => KNOWN_MISSING.has(`${c.method} ${c.path}`));
const unknown = missing.filter((c) => !KNOWN_MISSING.has(`${c.method} ${c.path}`));

// 反向：后端有、客户端没调 —— 只做提示（可能是给后台/第三方用的）
const clientKeys = new Set(client.map((c) => `${c.method} ${c.path}`));
const unused = [...backend.keys()].filter((r) => !clientKeys.has(r));

/**
 * 形状对账：客户端泛型写的是"裸数组"，后端返回的却是**包了一层的对象**。
 *
 * ## 为什么单列一条规则（2026-09-21 真实事故）
 *
 * `apps/mp/utils/api.ts` 写的是 `http.get<PracticeModuleItem[]>('/practice/modules')`，
 * 而后端返回 `{ modules: [...] }`。请求层只剥最外层信封（`data`），不会再往里剥，
 * 所以拿到的是**对象**，`list.map(...)` 在运行时炸：
 * `list.map is not a function`。
 *
 * ## 为什么前面所有守卫都拦不住
 *
 * · `tsc` 不报 —— 两边各自都自洽，`.map` 在对象和数组上都"存在"；
 * · `audit:api` 原来只查"路由存不存在"，形状错不在它的判据里；
 * · `audit:mp` 不看 TS 与接口的对应关系；
 * · 单测不报 —— 页面文件在 vitest 里跑不起来。
 * 于是它**只在真机点开那一刻炸**，而且报错文案里没有半点"是哪个接口"的信息。
 *
 * 这条规则只查最容易出事、也最好判的一类：**顶层 数组 ↔ 顶层 对象**。
 * 解析不出后端返回类型时**不做结论**（宁可漏查，也不要误报）。
 */
const shapeMismatch = [];
const shapeChecked = [];
for (const c of client) {
  const entry = backend.get(`${c.method} ${c.path}`);
  if (!entry) continue;
  if (!entry.ret) continue;
  shapeChecked.push(c);
  const beArray = isArrayType(entry.ret);
  const feArray = isArrayType(c.generic);
  // 后端是有字段的对象 + 前端声明成数组 → 就是本次事故的形状
  if (!beArray && feArray && entry.ret.startsWith('{')) shapeMismatch.push({ c, ret: entry.ret });
}

console.log('\n接口对齐体检（客户端调用 vs 后端注册路由）\n');
console.log(`  后端注册路由      : ${backend.size}`);
console.log(`  客户端调用        : ${client.length}`);
console.log(`  其中后端不存在    : ${missing.length}（已知缺口 ${known.length} / ⚠️ 未知 ${unknown.length}）`);
console.log(`  后端有但前端未调用: ${unused.length}`);
console.log(`  返回形状不一致    : ${shapeMismatch.length}（已对账 ${shapeChecked.length} 条）\n`);

/**
 * ⚠️ **"判据为空所以恒真"自检**。
 *
 * 这条规则要能生效，前提是"**真的从后端源码里解出了返回类型**"。
 * 本次就是先踩了这个坑：正则漏了 CRLF 与引号，`ret` 全是 `null`，
 * 于是脚本打印 `返回形状不一致: 0` 并**亮绿灯** —— 而它其实一条都没查。
 *
 * 所以要求解出**至少 10 条**签名。掉到 0 附近就说明解析器坏了（换行符变了、
 * 装饰器写法变了……），此时**必须报错**，不能继续装作体检查过了。
 */
const SHAPE_MIN_CHECKED = 10;
if (shapeChecked.length < SHAPE_MIN_CHECKED) {
  console.log(
    `❌ 形状规则的判据几乎为空（只解出 ${shapeChecked.length} 条后端签名，` +
      `少于下限 ${SHAPE_MIN_CHECKED}）——\n` +
      `   说明返回类型解析器失效了（换行符 / 装饰器写法变化？）。\n` +
      `   此时"返回形状不一致: 0"**不代表没问题**，只代表没查。请先修解析器。\n`,
  );
  process.exit(1);
}

if (shapeMismatch.length) {
  console.log('❌ 返回形状对不上 —— 客户端按"裸数组"用，后端返回的是包了一层的对象：');
  for (const { c, ret } of shapeMismatch) {
    console.log(`  · ${c.method} ${c.path}   (api.ts:${c.line})`);
    console.log(`      客户端泛型 : ${c.generic}`);
    console.log(`      后端返回   : ${ret}`);
    console.log(`      → 运行时表现为 \`x.map is not a function\`；改客户端泛型 + 取字段那一处`);
  }
  console.log('');
}

if (known.length) {
  console.log('── 已知缺口（已在 KNOWN_MISSING 登记，属"后端未开工"，前端需如实提示）──');
  for (const c of known) {
    console.log(`  · ${c.method} ${c.path}   (api.ts:${c.line})`);
    console.log(`      ${KNOWN_MISSING.get(`${c.method} ${c.path}`)}`);
  }
  console.log('');
}

if (unknown.length || shapeMismatch.length) {
  console.log('');
  console.log('❌ 未登记的缺口 —— 要么补后端，要么写进 KNOWN_MISSING 并说明缺什么：');
  for (const c of unknown) {
    console.log(`  · ${c.method} ${c.path}   (api.ts:${c.line})  ← 原始写法 ${JSON.stringify(c.raw)}`);
  }
  console.log('');
  process.exit(1);
}

// 豁免清单里已失效的条目（后端已补齐）→ 提示删掉，避免清单腐化
const stale = [...KNOWN_MISSING.keys()].filter((k) => backend.has(k));
if (stale.length) {
  console.log('ℹ️ 以下豁免条目后端已存在，请从 KNOWN_MISSING 移除（避免清单腐化）：');
  for (const k of stale) console.log(`  · ${k}`);
  console.log('');
}

if (unused.length) {
  console.log('ℹ️ 后端有但小程序未调用（仅提示，不算问题）：');
  for (const r of unused) console.log(`  · ${r}`);
  console.log('   注意：本脚本只解析 api.ts。走 wx.request / wx.downloadFile 直连的');
  console.log('   （如 utils/file-transfer.ts 的 /files/local/*）不会出现在上面，属正常。');
  console.log('');
}

console.log(
  `✅ 接口对齐体检通过：${client.length} 个客户端调用全部有归属` +
    `（${backend.size} 个已实现，${known.length} 个已登记的未开工缺口）`,
);
console.log(`   （后端源码：${relative(ROOT, API_SRC)}｜客户端：${relative(ROOT, CLIENT)}）\n`);
